/**
 * Unit tests for the top-level {@link import('../src/index.js').parse} skeleton, the BLOCK-FREE
 * statement layer (`ContentStatement`, `MustacheStatement`, `CommentStatement`) implemented by
 * worker W2b-1, and the BLOCK layer (`BlockStatement`, `PartialStatement`,
 * `PartialBlockStatement`, `Decorator`, `DecoratorBlock`, raw blocks, `{{else}}` / `{{else if}}`
 * chains, caret-inverse, block params) implemented by worker W2b-2.
 *
 * Strategy: parse each corpus template with our own `parse`, project the produced `Program`
 * through the SAME denylist normalisation the golden capture uses (`scripts/capture-golden.mjs`),
 * and deep-compare against the frozen golden entry (`tests/golden/ast.baseline.json`). Lexical /
 * parse errors are compared against `tests/golden/errors.baseline.json` by ERROR CLASS (jison vs
 * exception) and location only — the clean-room error MESSAGES intentionally differ from
 * upstream's Jison prose, so they are not asserted. We do NOT import `@handlebars/parser`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parse } from '../src/index.js';
import { normalise } from '../scripts/normalise.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const astGolden = JSON.parse(
    readFileSync(path.join(packageRoot, 'tests', 'golden', 'ast.baseline.json'), 'utf8'),
);
const errorsGolden = JSON.parse(
    readFileSync(path.join(packageRoot, 'tests', 'golden', 'errors.baseline.json'), 'utf8'),
);

/**
 * Read a corpus file's raw source.
 *
 * @param {string} file - Corpus file name (e.g. `simple-mustache.hbs`).
 * @param {string} [directory] - Sub-directory under `tests/corpus` (default the corpus root).
 * @returns {string} The file contents.
 */
function readCorpus(file, directory = '') {
    return readFileSync(path.join(packageRoot, 'tests', 'corpus', directory, file), 'utf8');
}

// ── Block-free corpus → golden Program ────────────────────────────────────────────────────
// Every file here is block-free (no `{{#…}}`, `{{^…}}`, `{{>…}}`, `{{*…}}`, `{{else}}`, or
// `{{{{…}}}}`). `whitespace-control` and `html-embedded` are OMITTED: both contain `{{#if}}`
// blocks and belong to W2b-2's test surface.
const BLOCK_FREE_FILES = [
    'simple-mustache.hbs',
    'nested-mustache.hbs',
    'triple-stache.hbs',
    'amp-unescaped.hbs',
    'comment-short.hbs',
    'comment-long.hbs',
    'escaped-mustache.hbs',
    'escaped-double-backslash.hbs',
    'subexpression.hbs',
    'hash-pairs.hbs',
    'literals.hbs',
    'literal-as-path.hbs',
    'paths-special.hbs',
    'segment-literal.hbs',
    'binding-content.hbs',
    'dollar-underscore-ids.hbs',
    'numeric-path-vs-literal.hbs',
    'legacy-slash-path.hbs',
];

for (const file of BLOCK_FREE_FILES) {
    test(`parse: ${file} matches golden Program`, () => {
        const source = readCorpus(file);
        const ast = parse(source);
        assert.equal(ast.type, 'Program');
        assert.deepEqual(normalise(ast), astGolden[file]);
    });
}

// ── Block corpus → golden Program (W2b-2) ──────────────────────────────────────────────────
// Every block-like construct: `{{#…}}` blocks (with `{{else}}` / `{{else if}}` chains / caret
// inverse / block params), raw blocks, partials, partial blocks, decorators, decorator blocks,
// and the two mixed HTML/whitespace-control templates that embed `{{#if}}` blocks.
const BLOCK_CORPUS_FILES = [
    'block-if-else.hbs',
    'block-caret-inverse.hbs',
    'block-else-if-chain.hbs',
    'block-params.hbs',
    'empty-blocks.hbs',
    'raw-block.hbs',
    'partial.hbs',
    'partial-block.hbs',
    'decorator.hbs',
    'decorator-block.hbs',
    'plugin-helpers.hbs',
    'mcn-block-params-with.hbs',
    'mcn-data-vars.hbs',
    'mcn-hash-and-literals.hbs',
    'mcn-nested-subexpr.hbs',
    'whitespace-control.hbs',
    'html-embedded.hbs',
];

for (const file of BLOCK_CORPUS_FILES) {
    test(`parse: ${file} matches golden Program`, () => {
        const source = readCorpus(file);
        const ast = parse(source);
        assert.equal(ast.type, 'Program');
        assert.deepEqual(normalise(ast), astGolden[file]);
    });
}

// ── Leaf-level error contract ─────────────────────────────────────────────────────────────
// Compare CLASS (jison vs exception) and LOCATION against the golden. Clean-room messages differ
// from upstream, so message text is intentionally not asserted.
const LEAF_ERROR_FILES = [
    'bare-caret.hbs',
    'empty-mustache.hbs',
    'unexpected-sep.hbs',
    'unterminated-string.hbs',
    'unterminated-comment.hbs',
];

for (const file of LEAF_ERROR_FILES) {
    test(`parse error: ${file} matches golden class + location`, () => {
        const source = readCorpus(file, 'errors');
        const want = errorsGolden[file];
        let thrown;
        try {
            parse(source);
        } catch (ex) {
            thrown = ex;
        }
        assert.ok(thrown, `expected ${file} to throw`);
        const loc = thrown.hash && thrown.hash.loc;
        const cls = loc ? 'jison' : 'exception';
        assert.equal(cls, want.class, `error class for ${file}`);
        if (want.class === 'jison') {
            assert.deepEqual(
                {
                    first_line: loc.first_line,
                    first_column: loc.first_column,
                    last_line: loc.last_line,
                    last_column: loc.last_column,
                },
                want.hash.loc,
                `jison loc for ${file}`,
            );
        }
    });
}

// ── Block-level error contract (W2b-2) ─────────────────────────────────────────────────────
// Assert CLASS (jison iff `hash.loc` present) and POSITION for the four block errors: a
// mismatched close (`{{#a}}…{{/b}}`) and an invalid path (`{{foo/../bar}}`) are exception-class
// (with `lineNumber`/`column`); a stray `{{else}}` and an unclosed block are jison-class (with
// `hash.loc`). Clean-room messages differ from upstream, so message text is not asserted.
const BLOCK_ERROR_FILES = [
    'block-mismatch.hbs',
    'doubled-else.hbs',
    'invalid-path.hbs',
    'unclosed-block.hbs',
];

// ── Dot-path drop-in (`{{.}}` / `{{..}}` / `{{...}}`) ──────────────────────────────────────
// `@handlebars/parser` lexes `.` and `..` as path IDs (current / parent context). `{{...}}` is
// therefore path `..` plus a `.` positional param — not a throw. `{{.foo}}` remains invalid.

test('parse: {{...}} is a mustache with parent-context path plus a current-context param', () => {
    const ast = parse('{{...}}');
    assert.equal(ast.type, 'Program');
    assert.equal(ast.body.length, 1);
    const mustache = ast.body[0];
    assert.equal(mustache.type, 'MustacheStatement');
    assert.equal(mustache.path.type, 'PathExpression');
    assert.equal(mustache.path.original, '..');
    assert.equal(mustache.path.depth, 1);
    assert.deepEqual(mustache.path.parts, []);
    assert.equal(mustache.path.this, false);
    assert.equal(mustache.params.length, 1);
    assert.equal(mustache.params[0].type, 'PathExpression');
    assert.equal(mustache.params[0].original, '.');
    assert.equal(mustache.params[0].depth, 0);
    assert.deepEqual(mustache.params[0].parts, []);
});

test('parse: {{.}} is current-context path; {{..}} is parent-context path', () => {
    const current = parse('{{.}}').body[0].path;
    assert.equal(current.original, '.');
    assert.equal(current.depth, 0);
    assert.deepEqual(current.parts, []);

    const parent = parse('{{..}}').body[0].path;
    assert.equal(parent.original, '..');
    assert.equal(parent.depth, 1);
    assert.deepEqual(parent.parts, []);
});

test('parse: {{...foo}} stays one path (parent hop + segment)', () => {
    const pathNode = parse('{{...foo}}').body[0].path;
    assert.equal(pathNode.original, '...foo');
    assert.equal(pathNode.depth, 1);
    assert.deepEqual(pathNode.parts, ['foo']);
});

for (const file of BLOCK_ERROR_FILES) {
    test(`parse error: ${file} matches golden class + location`, () => {
        const source = readCorpus(file, 'errors');
        const want = errorsGolden[file];
        let thrown;
        try {
            parse(source);
        } catch (ex) {
            thrown = ex;
        }
        assert.ok(thrown, `expected ${file} to throw`);
        const loc = thrown.hash && thrown.hash.loc;
        const cls = loc ? 'jison' : 'exception';
        assert.equal(cls, want.class, `error class for ${file}`);
        if (want.class === 'jison') {
            assert.deepEqual(
                {
                    first_line: loc.first_line,
                    first_column: loc.first_column,
                    last_line: loc.last_line,
                    last_column: loc.last_column,
                },
                want.hash.loc,
                `jison loc for ${file}`,
            );
        } else {
            assert.equal(thrown.lineNumber, want.lineNumber, `exception line for ${file}`);
            assert.equal(thrown.column, want.column, `exception column for ${file}`);
        }
    });
}
