/**
 * Unit tests for the expression / path / literal / hash / subexpression sub-parsers
 * (`src/expression.js`) and the node factory (`src/nodes.js`).
 *
 * Strategy: for each construct we tokenise a full `{{ … }}` mustache with the real tokenizer,
 * position the shared reader just past the `OPEN` token (as W2b will), run the relevant
 * sub-parser, then compare the produced sub-AST against the SAME sub-node in the frozen golden
 * (`tests/golden/ast.baseline.json`). The golden preserves `undefined`-valued keys via the
 * `{ __undefined__: true }` marker, so we normalise our node the identical way (mirroring
 * `scripts/capture-golden.mjs`) before the deep-compare. We do NOT import `@handlebars/parser`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { tokenizeWithLineTable, TokenType } from '../src/tokenizer.js';
import {
    createReader,
    parsePath,
    parseLiteral,
    parseExpressionParameter,
    parseSubExpression,
    parseParametersAndHash,
} from '../src/expression.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const golden = JSON.parse(
    readFileSync(path.join(packageRoot, 'tests', 'golden', 'ast.baseline.json'), 'utf8'),
);

/**
 * Recursively project a value the way `scripts/capture-golden.mjs` does: sort object keys and
 * represent an `undefined` value as `{ __undefined__: true }`. The `ContentStatement.value` drop
 * is irrelevant here (we only compare expression-level nodes), so it is omitted.
 *
 * @param {unknown} value - The value to normalise.
 * @returns {unknown} The normalised value.
 */
function normalise(value) {
    if (Array.isArray(value)) {
        return value.map((item) => normalise(item));
    }
    if (value === undefined) {
        return { __undefined__: true };
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    const out = {};
    for (const key of Object.keys(value).toSorted(compareStrings)) {
        out[key] = normalise(value[key]);
    }
    return out;
}

/**
 * Byte-wise string comparator matching `scripts/capture-golden.mjs` so normalised key order
 * lines up with the golden.
 *
 * @param {string} a - First key.
 * @param {string} b - Second key.
 * @returns {number} Standard sort order.
 */
function compareStrings(a, b) {
    if (a < b) {
        return -1;
    }
    return a > b ? 1 : 0;
}

/**
 * Tokenise `source`, build the shared reader, and advance past the leading `OPEN` token so the
 * cursor sits on the first inside-mustache token (exactly where W2b hands off to the sub-parsers).
 *
 * @param {string} source - A full `{{ … }}` (or `{{{ … }}}`) mustache source.
 * @returns {object} The positioned reader.
 */
function readerAfterOpen(source) {
    const { tokens, lineTable } = tokenizeWithLineTable(source);
    const reader = createReader(tokens, lineTable, source);
    assert.equal(reader.peekType(), TokenType.OPEN, 'expected a leading OPEN token');
    reader.next();
    return reader;
}

/**
 * Fetch the golden Program body for a corpus file.
 *
 * @param {string} file - Corpus file name (e.g. `paths-special.hbs`).
 * @returns {object[]} The normalised body array from the golden.
 */
function goldenBody(file) {
    return golden[file].body;
}

/**
 * Read a corpus file's real source and return a reader positioned just past the `n`-th `OPEN`
 * token (0-based), so `loc` line/column values match the golden exactly (the golden's positions
 * are relative to the full multi-line corpus source).
 *
 * @param {string} file - Corpus file name.
 * @param {number} [openIndex] - Which `OPEN` token to stop after (0-based, default 0).
 * @returns {object} The positioned reader.
 */
function readerAtCorpusMustache(file, openIndex = 0) {
    const source = readFileSync(path.join(packageRoot, 'tests', 'corpus', file), 'utf8');
    const { tokens, lineTable } = tokenizeWithLineTable(source);
    const reader = createReader(tokens, lineTable, source);
    let seen = 0;
    while (!reader.atEnd()) {
        if (reader.peekType() === TokenType.OPEN) {
            if (seen === openIndex) {
                reader.next();
                return reader;
            }
            seen++;
        }
        reader.next();
    }
    throw new Error(`OPEN #${openIndex} not found in ${file}`);
}

// ── PathExpression ────────────────────────────────────────────────────────────────────────

test('parsePath: bare this -> parts [], head undefined, this false', () => {
    const reader = readerAtCorpusMustache('paths-special.hbs', 0);
    const node = parsePath(reader);
    assert.deepEqual(node.parts, []);
    assert.equal(node.head, undefined);
    assert.deepEqual(node.tail, []);
    assert.equal(node.this, false);
    assert.equal(node.data, false);
    assert.equal(node.depth, 0);
    assert.equal(node.original, 'this');
    // Deep-compare against the golden PathExpression (body[0].path).
    assert.deepEqual(normalise(node), goldenBody('paths-special.hbs')[0].path);
});

test('parsePath: this.label -> this true, parts [label]', () => {
    const reader = readerAtCorpusMustache('paths-special.hbs', 1);
    const node = parsePath(reader);
    assert.deepEqual(node.parts, ['label']);
    assert.equal(node.head, 'label');
    assert.equal(node.this, true);
    assert.equal(node.original, 'this.label');
    // body[2] is the {{this.label}} mustache (body[1] is the "\n" content).
    assert.deepEqual(normalise(node), goldenBody('paths-special.hbs')[2].path);
});

test('parsePath: ../parentValue -> depth 1, data false', () => {
    const reader = readerAfterOpen('{{../parentValue}}');
    const node = parsePath(reader);
    assert.equal(node.depth, 1);
    assert.equal(node.data, false);
    assert.deepEqual(node.parts, ['parentValue']);
    assert.equal(node.original, '../parentValue');
});

test('parsePath: ../../grandParentValue -> depth 2', () => {
    const reader = readerAfterOpen('{{../../grandParentValue}}');
    const node = parsePath(reader);
    assert.equal(node.depth, 2);
    assert.deepEqual(node.parts, ['grandParentValue']);
    assert.equal(node.original, '../../grandParentValue');
});

test('parsePath: {{...}} head stops at parent-context .. and leaves the trailing .', () => {
    const reader = readerAfterOpen('{{...}}');
    const node = parsePath(reader);
    assert.equal(node.original, '..');
    assert.equal(node.depth, 1);
    assert.deepEqual(node.parts, []);
    assert.equal(node.this, false);
    assert.equal(reader.peekType(), TokenType.SEP);
    assert.equal(reader.peek().value, '.');
});

test('parsePath: {{.}} is current-context (original ., depth 0, empty parts)', () => {
    const reader = readerAfterOpen('{{.}}');
    const node = parsePath(reader);
    assert.equal(node.original, '.');
    assert.equal(node.depth, 0);
    assert.deepEqual(node.parts, []);
    assert.equal(node.head, undefined);
});

test('parsePath: {{...foo}} is one path with depth 1 and part foo', () => {
    const reader = readerAfterOpen('{{...foo}}');
    const node = parsePath(reader);
    assert.equal(node.original, '...foo');
    assert.equal(node.depth, 1);
    assert.deepEqual(node.parts, ['foo']);
});

test('parsePath: ./sibling -> depth 0, this false', () => {
    const reader = readerAfterOpen('{{./sibling}}');
    const node = parsePath(reader);
    assert.equal(node.depth, 0);
    assert.equal(node.this, false);
    assert.deepEqual(node.parts, ['sibling']);
    assert.equal(node.original, './sibling');
});

test('parsePath: @root.settings -> data true, parts [root, settings]', () => {
    const reader = readerAtCorpusMustache('paths-special.hbs', 5);
    const node = parsePath(reader);
    assert.equal(node.data, true);
    assert.deepEqual(node.parts, ['root', 'settings']);
    assert.deepEqual(node.tail, ['settings']);
    assert.equal(node.original, '@root.settings');
    assert.deepEqual(normalise(node), goldenBody('paths-special.hbs')[10].path);
});

test('parsePath: @index -> data true, parts [index]', () => {
    const reader = readerAfterOpen('{{@index}}');
    const node = parsePath(reader);
    assert.equal(node.data, true);
    assert.deepEqual(node.parts, ['index']);
    assert.equal(node.original, '@index');
});

// ── Segment literals ──────────────────────────────────────────────────────────────────────

test('parsePath: @root.$graph.[0].node.[0].value -> brackets removed in original', () => {
    const reader = readerAtCorpusMustache('segment-literal.hbs', 0);
    const node = parsePath(reader);
    assert.deepEqual(node.parts, ['root', '$graph', '0', 'node', '0', 'value']);
    assert.equal(node.original, '@root.$graph.0.node.0.value');
    assert.deepEqual(normalise(node), goldenBody('segment-literal.hbs')[0].path);
});

test('parsePath: records.[42] -> parts [records, 42], original records.42', () => {
    const reader = readerAtCorpusMustache('segment-literal.hbs', 1);
    const node = parsePath(reader);
    assert.deepEqual(node.parts, ['records', '42']);
    assert.equal(node.original, 'records.42');
    assert.deepEqual(normalise(node), goldenBody('segment-literal.hbs')[2].path);
});

test('parsePath: obj.[bar baz] -> inner space kept, brackets removed', () => {
    const reader = readerAtCorpusMustache('segment-literal.hbs', 2);
    const node = parsePath(reader);
    assert.deepEqual(node.parts, ['obj', 'bar baz']);
    assert.equal(node.original, 'obj.bar baz');
    assert.deepEqual(normalise(node), goldenBody('segment-literal.hbs')[4].path);
});

test('parsePath: this.[x y] -> this true, part "x y"', () => {
    const reader = readerAtCorpusMustache('segment-literal.hbs', 3);
    const node = parsePath(reader);
    assert.deepEqual(node.parts, ['x y']);
    assert.equal(node.head, 'x y');
    assert.equal(node.this, true);
    assert.equal(node.original, 'this.x y');
    assert.deepEqual(normalise(node), goldenBody('segment-literal.hbs')[6].path);
});

// ── Legacy slash paths ────────────────────────────────────────────────────────────────────

test('parsePath: group/member -> parts split, slash kept in original', () => {
    const reader = readerAtCorpusMustache('legacy-slash-path.hbs', 0);
    const node = parsePath(reader);
    assert.deepEqual(node.parts, ['group', 'member']);
    assert.equal(node.original, 'group/member');
    assert.deepEqual(normalise(node), goldenBody('legacy-slash-path.hbs')[0].path);
});

test('parsePath: outer/inner/leaf -> three parts', () => {
    const reader = readerAfterOpen('{{outer/inner/leaf}}');
    const node = parsePath(reader);
    assert.deepEqual(node.parts, ['outer', 'inner', 'leaf']);
    assert.equal(node.original, 'outer/inner/leaf');
});

// ── numeric-path-vs-literal ───────────────────────────────────────────────────────────────

test('parsePath: 0x1 and 1e3 are paths (letters present)', () => {
    for (const source of ['{{0x1}}', '{{1e3}}']) {
        const reader = readerAfterOpen(source);
        const node = parsePath(reader);
        assert.equal(node.type, 'PathExpression');
        assert.deepEqual(node.parts, [source.slice(2, -2)]);
    }
});

test('parseLiteral: -42 and 3.14 are NumberLiterals with numeric value/original', () => {
    const parameters = goldenBody('numeric-path-vs-literal.hbs')[0].params;
    // The mustache is `{{describe 0x1 1e3 -42 3.14}}`; parse its params in order.
    const reader = readerAtCorpusMustache('numeric-path-vs-literal.hbs', 0);
    parsePath(reader); // describe
    parseExpressionParameter(reader); // 0x1 (path)
    parseExpressionParameter(reader); // 1e3 (path)
    const nodeMinus = parseExpressionParameter(reader); // -42
    assert.equal(nodeMinus.type, 'NumberLiteral');
    assert.equal(nodeMinus.value, -42);
    assert.equal(nodeMinus.original, -42);
    assert.deepEqual(normalise(nodeMinus), parameters[2]);

    const nodeFraction = parseExpressionParameter(reader); // 3.14
    assert.equal(nodeFraction.type, 'NumberLiteral');
    assert.equal(nodeFraction.value, parameters[3].value);
    assert.equal(nodeFraction.original, parameters[3].original);
    assert.deepEqual(normalise(nodeFraction), parameters[3]);
});

// ── Literals ──────────────────────────────────────────────────────────────────────────────

test('parseLiteral: string / boolean / null / undefined classification', () => {
    const string_ = parseLiteral(readerAfterOpen('{{"quoted string"}}'));
    assert.equal(string_.type, 'StringLiteral');
    assert.equal(string_.value, 'quoted string');
    assert.equal(string_.original, 'quoted string');

    const t = parseLiteral(readerAfterOpen('{{true}}'));
    assert.equal(t.type, 'BooleanLiteral');
    assert.equal(t.value, true);
    assert.equal(t.original, true);

    const f = parseLiteral(readerAfterOpen('{{false}}'));
    assert.equal(f.type, 'BooleanLiteral');
    assert.equal(f.value, false);

    const n = parseLiteral(readerAfterOpen('{{null}}'));
    assert.equal(n.type, 'NullLiteral');
    assert.equal(n.value, null);
    assert.equal(n.original, null);

    const u = parseLiteral(readerAfterOpen('{{undefined}}'));
    assert.equal(u.type, 'UndefinedLiteral');
    assert.equal(u.value, undefined);
    assert.equal(u.original, undefined);
});

test('parseLiteral: full literals mustache matches golden params', () => {
    // `{{describe "quoted string" 42 -7 3.14 true false null undefined}}`
    const litParameters = goldenBody('literals.hbs')[0].params;
    const reader = readerAtCorpusMustache('literals.hbs', 0);
    parsePath(reader); // describe
    for (const [index, litParameter] of litParameters.entries()) {
        const node = parseExpressionParameter(reader);
        assert.deepEqual(normalise(node), litParameter, `param ${index} shape`);
    }
});

test('parseLiteral: keyword followed by SEP is a path, not a literal', () => {
    // `true.x` -> parseLiteral declines, parsePath handles it.
    const reader = readerAfterOpen('{{true.x}}');
    assert.equal(parseLiteral(reader), undefined);
    const node = parsePath(reader);
    assert.equal(node.type, 'PathExpression');
    assert.deepEqual(node.parts, ['true', 'x']);
});

// ── Hash / HashPair ───────────────────────────────────────────────────────────────────────

test('parseParamsAndHash: no pairs -> hash is undefined (not a node)', () => {
    // `{{this}}` has no params and no hash.
    const reader = readerAfterOpen('{{this}}');
    parsePath(reader); // consume the path first, as W2b does
    const { params, hash } = parseParametersAndHash(
        reader,
        (token) => token.type === TokenType.CLOSE,
    );
    assert.deepEqual(params, []);
    assert.equal(hash, undefined);
});

test('parseParamsAndHash: params then hash (hash-pairs.hbs line 1)', () => {
    const mustache = goldenBody('hash-pairs.hbs')[0];
    const reader = readerAtCorpusMustache('hash-pairs.hbs', 0);
    parsePath(reader); // formatDate
    const { params, hash } = parseParametersAndHash(
        reader,
        (token) => token.type === TokenType.CLOSE,
    );
    assert.equal(params.length, 1);
    assert.deepEqual(normalise(params[0]), mustache.params[0]);
    assert.equal(hash.type, 'Hash');
    assert.equal(hash.pairs.length, 2);
    assert.equal(hash.pairs[0].key, 'pattern');
    assert.equal(hash.pairs[1].key, 'locale');
    assert.deepEqual(normalise(hash), mustache.hash);
});

test('parseParamsAndHash: mixed value types (hash-pairs.hbs line 2)', () => {
    const mustache = goldenBody('hash-pairs.hbs')[2];
    const reader = readerAtCorpusMustache('hash-pairs.hbs', 1);
    parsePath(reader); // buildUrl
    const { params, hash } = parseParametersAndHash(
        reader,
        (token) => token.type === TokenType.CLOSE,
    );
    assert.equal(params.length, 1);
    assert.equal(hash.pairs.length, 3);
    assert.equal(hash.pairs[0].value.type, 'PathExpression'); // path=segment
    assert.equal(hash.pairs[1].value.type, 'BooleanLiteral'); // secure=true
    assert.equal(hash.pairs[2].value.type, 'NumberLiteral'); // retries=3
    assert.deepEqual(normalise(hash), mustache.hash);
});

// ── SubExpression (nesting) ───────────────────────────────────────────────────────────────

test('parseSubExpression: nested ( filter ( fetch … ) … )', () => {
    const mustache = goldenBody('subexpression.hbs')[0];
    const reader = readerAtCorpusMustache('subexpression.hbs', 0);
    parsePath(reader); // sortBy
    const { params, hash } = parseParametersAndHash(
        reader,
        (token) => token.type === TokenType.CLOSE,
    );
    assert.equal(hash, undefined);
    assert.equal(params.length, 2);
    // params[0] is the outer subexpression (filter …), params[1] is "createdAt".
    assert.equal(params[0].type, 'SubExpression');
    assert.equal(params[0].hash, undefined);
    assert.equal(params[0].params[0].type, 'SubExpression'); // nested (fetch …)
    assert.deepEqual(normalise(params[0]), mustache.params[0]);
    assert.deepEqual(normalise(params[1]), mustache.params[1]);
});

test('parseExpressionParam: standalone subexpression via parseExpressionParam', () => {
    const reader = readerAfterOpen('{{x (helper 1)}}');
    parsePath(reader); // x
    reader.skipWhitespace();
    const sub = parseExpressionParameter(reader);
    assert.equal(sub.type, 'SubExpression');
    assert.equal(sub.path.type, 'PathExpression');
    assert.equal(sub.path.head, 'helper');
    assert.equal(sub.params.length, 1);
    assert.equal(sub.params[0].type, 'NumberLiteral');
    assert.equal(sub.params[0].value, 1);
});

test('parseSubExpression: direct call on the outer ( … ) matches golden', () => {
    // Position the reader directly on the outer `(filter …)` subexpression and parse it.
    const mustache = goldenBody('subexpression.hbs')[0];
    const reader = readerAtCorpusMustache('subexpression.hbs', 0);
    parsePath(reader); // sortBy
    reader.skipWhitespace();
    assert.equal(reader.peekType(), TokenType.OPEN_PAREN);
    const sub = parseSubExpression(reader);
    assert.equal(sub.type, 'SubExpression');
    assert.equal(sub.path.head, 'filter');
    assert.deepEqual(normalise(sub), mustache.params[0]);
});
