/**
 * Gate A / Gate A' — full golden-parity gate (plan `drop_handlebars-parser`, worker W3a).
 *
 * This is the COMPLETE, systematic parity harness: it proves the hand-rolled {@link parse}
 * reproduces the frozen `@handlebars/parser@2.2.2` AST + error goldens across the ENTIRE corpus,
 * as a permanent regression lock. Unlike the per-construct tests in `tests/parse.test.mjs`
 * (which enumerate files by hand), this harness is DATA-DRIVEN off the goldens: it iterates over
 * every entry in `ast.baseline.json` / `errors.baseline.json` and additionally asserts the corpus
 * and the goldens stay in one-to-one correspondence, so a newly added corpus file (or a golden
 * entry with no file) fails loudly rather than being silently skipped.
 *
 * Normaliser sharing: the SAME denylist projection the capture script uses is imported from
 * `scripts/normalise.mjs` — there is no second copy that can drift. The goldens are the
 * normalised projection of upstream's output; we apply the identical projection to our parser's
 * output and deep-compare. Message text is intentionally NOT asserted (clean-room error prose
 * differs from Jison's token-grammar wording); only the error CLASS and POSITION are gated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parse } from '../src/index.js';
import { normalise, compareStrings } from '../scripts/normalise.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDirectory = path.join(packageRoot, 'tests', 'corpus');
const errorsDirectory = path.join(corpusDirectory, 'errors');
const goldenDirectory = path.join(packageRoot, 'tests', 'golden');

const astGolden = JSON.parse(readFileSync(path.join(goldenDirectory, 'ast.baseline.json'), 'utf8'));
const errorsGolden = JSON.parse(
    readFileSync(path.join(goldenDirectory, 'errors.baseline.json'), 'utf8'),
);

/**
 * List the `.hbs` files in a directory, sorted for stable ordering (matches the capture script's
 * ordering so golden keys and file names line up).
 *
 * @param {string} directory - Directory to list.
 * @returns {string[]} Sorted file names ending in `.hbs`.
 */
function listHbs(directory) {
    return readdirSync(directory)
        .filter((name) => name.endsWith('.hbs'))
        .toSorted(compareStrings);
}

const validFiles = listHbs(corpusDirectory);
const errorFiles = listHbs(errorsDirectory);

/**
 * Recursively find the first JSON path at which two normalised values differ, returning a
 * `path`/`expected`/`actual` triple for a readable failure message, or `null` when equal.
 *
 * @param {unknown} expected - The golden (upstream) value at this position.
 * @param {unknown} actual - The parser's normalised value at this position.
 * @param {string} [jsonPath] - The accumulated JSON path (e.g. `body[0].hash`).
 * @returns {{path: string, expected: unknown, actual: unknown}|null} The first divergence, or
 * `null` when the sub-trees are deep-equal.
 */
function firstDiff(expected, actual, jsonPath = '$') {
    if (Array.isArray(expected) || Array.isArray(actual)) {
        if (!Array.isArray(expected) || !Array.isArray(actual)) {
            return { path: jsonPath, expected, actual };
        }
        if (expected.length !== actual.length) {
            return { path: `${jsonPath}.length`, expected: expected.length, actual: actual.length };
        }
        for (const [index, element] of expected.entries()) {
            const diff = firstDiff(element, actual[index], `${jsonPath}[${index}]`);
            if (diff) {
                return diff;
            }
        }
        return null;
    }
    const hasExpectedObject = expected !== null && typeof expected === 'object';
    const hasActualObject = actual !== null && typeof actual === 'object';
    if (hasExpectedObject && hasActualObject) {
        const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].toSorted(
            compareStrings,
        );
        for (const key of keys) {
            const hasExpectedKey = Reflect.has(expected, key);
            const hasActualKey = Reflect.has(actual, key);
            if (!hasExpectedKey || !hasActualKey) {
                return {
                    path: `${jsonPath}.${key}`,
                    expected: hasExpectedKey ? expected[key] : '<absent>',
                    actual: hasActualKey ? actual[key] : '<absent>',
                };
            }
            const diff = firstDiff(expected[key], actual[key], `${jsonPath}.${key}`);
            if (diff) {
                return diff;
            }
        }
        return null;
    }
    if (expected !== actual) {
        return { path: jsonPath, expected, actual };
    }
    return null;
}

/**
 * Assert a normalised parser value deep-equals the golden, and on failure attach a readable diff
 * naming the corpus file and the exact JSON path of the first divergence.
 *
 * @param {string} file - The corpus file name (for the failure message).
 * @param {unknown} expected - The golden value.
 * @param {unknown} actual - The parser's normalised value.
 * @returns {void}
 */
function assertParity(file, expected, actual) {
    const diff = firstDiff(expected, actual);
    if (diff) {
        assert.fail(
            `AST parity mismatch in ${file} at ${diff.path}\n` +
                `  golden : ${JSON.stringify(diff.expected)}\n` +
                `  parser : ${JSON.stringify(diff.actual)}`,
        );
    }
    // Belt-and-braces: a full structural equality check in case firstDiff ever misses a case.
    assert.deepEqual(actual, expected, `AST parity mismatch in ${file}`);
}

// ── Corpus <-> golden correspondence (no orphans in either direction) ───────────────────────
test('golden parity: every valid corpus file has a golden entry and vice versa', () => {
    assert.deepEqual(
        validFiles,
        Object.keys(astGolden).toSorted(compareStrings),
        'valid corpus files must match ast.baseline.json keys exactly',
    );
});

test('golden parity: every error corpus file has a golden entry and vice versa', () => {
    assert.deepEqual(
        errorFiles,
        Object.keys(errorsGolden).toSorted(compareStrings),
        'error corpus files must match errors.baseline.json keys exactly',
    );
});

// ── Gate A — full AST parity over the ENTIRE valid corpus ────────────────────────────────────
for (const file of validFiles) {
    test(`Gate A AST parity: ${file}`, () => {
        const source = readFileSync(path.join(corpusDirectory, file), 'utf8');
        const ast = parse(source);
        assert.equal(ast.type, 'Program', `${file} must parse to a Program root`);
        assertParity(file, astGolden[file], normalise(ast));
    });
}

// ── Gate A' — error parity over the ENTIRE error corpus ──────────────────────────────────────
// Project the thrown error the SAME way the capture script does: class by `hash.loc` presence,
// capturing `hash.loc` (jison) or `lineNumber`/`column` (exception). Deep-compare the projected
// record (minus the intentionally-diverging `message`) against the golden.
for (const file of errorFiles) {
    test(`Gate A' error parity: ${file}`, () => {
        const want = errorsGolden[file];
        const source = readFileSync(path.join(errorsDirectory, file), 'utf8');
        let thrown;
        try {
            parse(source);
        } catch (ex) {
            thrown = ex;
        }
        assert.ok(thrown, `expected ${file} to throw`);

        const loc = thrown.hash && thrown.hash.loc;
        const record = { class: loc ? 'jison' : 'exception' };
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
        if (thrown.lineNumber !== undefined) {
            record.lineNumber = thrown.lineNumber;
        }
        if (thrown.column !== undefined) {
            record.column = thrown.column;
        }

        // Compare only the parity-gated fields (class + position); message wording is excluded.
        const expected = { class: want.class };
        if (want.hash) {
            expected.hash = want.hash;
        }
        if (want.lineNumber !== undefined) {
            expected.lineNumber = want.lineNumber;
        }
        if (want.column !== undefined) {
            expected.column = want.column;
        }
        assert.deepEqual(record, expected, `error class/position parity for ${file}`);
    });
}
