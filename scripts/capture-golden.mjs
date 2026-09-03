/**
 * BEFORE-baseline capture for the Handlebars AST-parity gates (plan Gate A / Gate A').
 *
 * Reads every corpus template, parses it with the CURRENTLY installed
 * `@handlebars/parser` (the version `eslint-plugin-sfmc` depends on today),
 * projects the resulting AST through the plan's denylist normalisation, and
 * freezes it into `tests/golden/ast.baseline.json`. Malformed templates under
 * `tests/corpus/errors/` are parsed too; the thrown error is classified into
 * one of the two upstream error classes (`jison` vs `exception`) and frozen
 * into `tests/golden/errors.baseline.json`.
 *
 * A later parity worker re-points the parser import from `@handlebars/parser`
 * to the hand-rolled `sfmc-handlebars-parser` and diffs against these frozen
 * goldens to prove drop-in behaviour.
 *
 * Determinism: object keys are sorted recursively, JSON is emitted at 4-space
 * indent (so a prettier `tabWidth: 4` pass is a no-op) with a trailing newline.
 * Running the script twice must produce byte-identical output.
 *
 * Usage (the new package's `@handlebars/parser` devDependency may not be
 * installed yet, so the parser is resolved from `eslint-plugin-sfmc`):
 *
 *   node scripts/capture-golden.mjs
 *     # resolves the parser from ../eslint-plugin-sfmc/node_modules
 *
 *   node scripts/capture-golden.mjs --parser <path-to-esm-entry> --out <dir>
 *     # explicit overrides
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { compareStrings, normalise, stableJson } from './normalise.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDirectory, '..');

// ── Resolve CLI overrides ─────────────────────────────────────────────────
function readFlag(name) {
    const index = process.argv.indexOf(name);
    return index !== -1 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

const corpusDirectory = path.join(packageRoot, 'tests', 'corpus');
const errorsDirectory = path.join(corpusDirectory, 'errors');
const outDirectory = readFlag('--out')
    ? path.resolve(readFlag('--out'))
    : path.join(packageRoot, 'tests', 'golden');

// Default: resolve the ESM entry of the upstream parser from the plugin that
// still depends on it. `require()` is broken for that package (see
// bug-report-handlebars-parser.md), so the ESM `dist/esm/index.js` is used.
const defaultParserEntry = path.resolve(
    packageRoot,
    '..',
    'eslint-plugin-sfmc',
    'node_modules',
    '@handlebars',
    'parser',
    'dist',
    'esm',
    'index.js',
);
const parserEntry = readFlag('--parser') ? path.resolve(readFlag('--parser')) : defaultParserEntry;

const { parse } = await import(pathToFileURL(parserEntry).href);

/**
 * List the `.hbs` files in a directory, sorted for stable ordering.
 *
 * @param {string} directory - Directory to list.
 * @returns {string[]} Sorted file names ending in `.hbs`.
 */
function listHbs(directory) {
    return readdirSync(directory)
        .filter((name) => name.endsWith('.hbs'))
        .toSorted(compareStrings);
}

// ── Capture valid corpus → ast.baseline.json ──────────────────────────────
const astBaseline = {};
for (const file of listHbs(corpusDirectory)) {
    const source = readFileSync(path.join(corpusDirectory, file), 'utf8');
    const ast = parse(source);
    astBaseline[file] = normalise(ast);
}

// ── Capture error corpus → errors.baseline.json ───────────────────────────
const errorsBaseline = {};
for (const file of listHbs(errorsDirectory)) {
    const source = readFileSync(path.join(errorsDirectory, file), 'utf8');
    let record;
    try {
        parse(source);
        record = { class: 'none', threw: false };
    } catch (ex) {
        const loc = ex && ex.hash && ex.hash.loc;
        record = {
            class: loc ? 'jison' : 'exception',
            message: ex && ex.message,
        };
        if (loc) {
            record.hash = {
                loc: {
                    first_line: loc.first_line,
                    first_column: loc.first_column,
                    last_line: loc.last_line,
                    last_column: loc.last_column,
                },
            };
        }
        if (ex && ex.lineNumber !== undefined) {
            record.lineNumber = ex.lineNumber;
        }
        if (ex && ex.column !== undefined) {
            record.column = ex.column;
        }
    }
    errorsBaseline[file] = record;
}

// ── Write goldens ─────────────────────────────────────────────────────────
mkdirSync(outDirectory, { recursive: true });
const astPath = path.join(outDirectory, 'ast.baseline.json');
const errorsPath = path.join(outDirectory, 'errors.baseline.json');
writeFileSync(astPath, stableJson(astBaseline));
writeFileSync(errorsPath, stableJson(errorsBaseline));

/* eslint-disable no-console -- this capture script reports its output to the terminal */
console.log(`parser entry: ${parserEntry}`);
console.log(`wrote ${astPath} (${Object.keys(astBaseline).length} corpus files)`);
console.log(`wrote ${errorsPath} (${Object.keys(errorsBaseline).length} error files)`);
/* eslint-enable no-console */
