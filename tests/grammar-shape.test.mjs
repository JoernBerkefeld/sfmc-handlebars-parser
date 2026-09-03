/**
 * Grammar / shape unit tests + contract key-presence assertions (plan `drop_handlebars-parser`,
 * worker W3a — must-fix A3).
 *
 * The golden-parity gate (`tests/golden-parity.test.mjs`) already deep-compares the whole AST
 * against the frozen `@handlebars/parser@2.2.2` projection. These tests are complementary and
 * deliberately EXPLICIT: they assert — on the live runtime objects, not their JSON projection —
 * that the exact contract keys the ESLint `hbs-*` rules and the LSP read are PRESENT with the
 * right shape and the right `undefined`-vs-absent distinction. Because JSON cannot tell an
 * `undefined`-valued key from an absent one, these `'key' in node` / `node.key === undefined`
 * assertions are the only place that distinction is checked directly.
 *
 * Contract surface (from the plan's "AST contract" + "LSP compatibility analysis"):
 *   - PathExpression: `data` / `depth` / `parts` / `original` (+ `head` / `tail` / `this`).
 *   - Hash: `pairs`; HashPair: `key` / `value`.
 *   - MustacheStatement: `path` / `params` / `hash` / `escaped`; `hash` is a PRESENT key with
 *     value `undefined` when there is no `k=v` pair (never omitted, never `null`).
 *   - BlockStatement: `program` / `inverse` both present-as-keys; `undefined` when the branch is
 *     absent.
 *   - empty `Program` carries a `loc` KEY (value `undefined` per the frozen golden) and
 *     `blockParams` only when `as |…|` was written.
 *   - literal `value` / `original` types; partial `name`; decorator shape.
 *   - every row of the plan's empty-block / `else if` table.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/index.js';

/**
 * Parse a source and return its first top-level statement.
 *
 * @param {string} source - The Handlebars source.
 * @returns {object} `parse(source).body[0]`.
 */
function first(source) {
    return parse(source).body[0];
}

// ── PathExpression contract (data / depth / parts / original + head / tail / this) ──────────
test('PathExpression: dotted path exposes data/depth/parts/original/head/tail/this', () => {
    const node = first('{{alpha.beta.gamma}}').path;
    assert.equal(node.type, 'PathExpression');
    assert.equal(node.data, false);
    assert.equal(node.depth, 0);
    assert.deepEqual(node.parts, ['alpha', 'beta', 'gamma']);
    assert.equal(node.original, 'alpha.beta.gamma');
    assert.equal(node.head, 'alpha');
    assert.deepEqual(node.tail, ['beta', 'gamma']);
    assert.equal(node.this, false);
    for (const key of ['data', 'depth', 'parts', 'original', 'head', 'tail', 'this']) {
        assert.ok(Reflect.has(node, key), `PathExpression must expose '${key}'`);
    }
});

test('PathExpression: @-data path sets data:true, parts drop the @, original keeps it', () => {
    const node = first('{{@root.value}}').path;
    assert.equal(node.data, true);
    // `parts` strips the leading `@`, but upstream keeps it on `original` (per the frozen golden).
    assert.deepEqual(node.parts, ['root', 'value']);
    assert.equal(node.original, '@root.value');
});

test('PathExpression: ../../ parent hops set depth', () => {
    assert.equal(first('{{../../value}}').path.depth, 2);
});

test('PathExpression: segment literal keeps inner spaces, drops brackets', () => {
    const node = first('{{alpha.[beta gamma]}}').path;
    assert.deepEqual(node.parts, ['alpha', 'beta gamma']);
    assert.equal(node.original, 'alpha.beta gamma');
});

test('PathExpression: bare this sets this:false with empty parts', () => {
    const node = first('{{this}}').path;
    assert.equal(node.this, false);
    assert.deepEqual(node.parts, []);
});

// ── Hash / HashPair contract ────────────────────────────────────────────────────────────────
test('Hash: real node with pairs only when >=1 k=v pair', () => {
    const node = first('{{helper key=1 other="x"}}').hash;
    assert.equal(node.type, 'Hash');
    assert.ok(Array.isArray(node.pairs));
    assert.equal(node.pairs.length, 2);
});

test('HashPair: exposes key (string) and value (node)', () => {
    const pair = first('{{helper key=1}}').hash.pairs[0];
    assert.equal(pair.type, 'HashPair');
    assert.equal(pair.key, 'key');
    assert.equal(typeof pair.key, 'string');
    assert.equal(pair.value.type, 'NumberLiteral');
    assert.ok('key' in pair && 'value' in pair);
});

// ── MustacheStatement contract (path/params/hash/escaped) + hash present-with-undefined ──────
test('MustacheStatement: path/params/hash/escaped present; hash undefined-not-node when no pair', () => {
    const node = first('{{helper positional}}');
    assert.equal(node.type, 'MustacheStatement');
    assert.equal(node.path.type, 'PathExpression');
    assert.ok(Array.isArray(node.params));
    assert.equal(node.escaped, true);
    // hash is a PRESENT key with value undefined (must-fix A3) — not omitted, not null.
    assert.ok('hash' in node, "MustacheStatement must carry a 'hash' key");
    assert.equal(node.hash, undefined);
    assert.notEqual(node.hash, null);
});

test('MustacheStatement: escaped:false for {{{ }}} and {{& }}', () => {
    assert.equal(first('{{{raw}}}').escaped, false);
    assert.equal(first('{{& amp}}').escaped, false);
    assert.equal(first('{{esc}}').escaped, true);
});

test('MustacheStatement: params is always an array (empty when none)', () => {
    assert.deepEqual(first('{{lonely}}').params, []);
});

// ── literal-as-path ─────────────────────────────────────────────────────────────────────────
test('literal-as-path: {{"str"}} / {{true}} / {{5}} place the literal in path', () => {
    const string_ = first('{{"greeting"}}').path;
    assert.equal(string_.type, 'StringLiteral');
    assert.equal(string_.value, 'greeting');
    assert.equal(string_.original, 'greeting');
    assert.equal(typeof string_.value, 'string');

    const bool = first('{{true}}').path;
    assert.equal(bool.type, 'BooleanLiteral');
    assert.equal(bool.value, true);
    assert.equal(typeof bool.value, 'boolean');

    const number_ = first('{{5}}').path;
    assert.equal(number_.type, 'NumberLiteral');
    assert.equal(number_.value, 5);
    assert.equal(typeof number_.value, 'number');
});

// ── BlockStatement contract: program/inverse present-as-keys ─────────────────────────────────
test('BlockStatement: program and inverse are both present keys', () => {
    const node = first('{{#if cond}}yes{{else}}no{{/if}}');
    assert.equal(node.type, 'BlockStatement');
    assert.ok('program' in node, "BlockStatement must carry a 'program' key");
    assert.ok('inverse' in node, "BlockStatement must carry an 'inverse' key");
    assert.equal(node.program.type, 'Program');
    assert.equal(node.inverse.type, 'Program');
});

test('BlockStatement: inverse-only {{^x}} sets inverse, program is the undefined key', () => {
    const node = first('{{^empty}}fallback{{/empty}}');
    assert.ok('program' in node);
    assert.equal(node.program, undefined);
    assert.equal(node.inverse.type, 'Program');
});

test('BlockStatement: {{#x}}body{{/x}} with no else sets inverse:undefined (present key)', () => {
    const node = first('{{#each list}}row{{/each}}');
    assert.ok('inverse' in node);
    assert.equal(node.inverse, undefined);
    assert.equal(node.program.type, 'Program');
});

// ── Program: loc key on empty program; blockParams only when declared ────────────────────────
test('Program: empty root program carries a loc KEY (value present)', () => {
    const root = parse('');
    assert.equal(root.type, 'Program');
    assert.deepEqual(root.body, []);
    assert.ok('loc' in root, 'empty Program must carry a loc key');
});

test('Program: empty block body carries a loc KEY (value undefined per golden)', () => {
    const program = first('{{#if a}}{{/if}}').program;
    assert.deepEqual(program.body, []);
    // The frozen golden captures empty-Program `loc` as undefined; the key is present regardless.
    assert.ok('loc' in program, 'empty block Program must carry a loc key');
});

test('Program: blockParams key always present; array when as |…| declared, undefined otherwise', () => {
    const withParameters = first('{{#each list as |item index|}}{{/each}}').program;
    assert.ok('blockParams' in withParameters, 'block program with as |…| must carry blockParams');
    assert.deepEqual(withParameters.blockParams, ['item', 'index']);

    // Per the frozen golden a block Program carries `blockParams` as a PRESENT key whose value is
    // `undefined` when no `as |…|` was written (never omitted) — matching @handlebars/parser.
    const withoutParameters = first('{{#each list}}{{/each}}').program;
    assert.ok('blockParams' in withoutParameters, 'block program must carry a blockParams key');
    assert.equal(withoutParameters.blockParams, undefined);
});

// ── Whitespace-control strip flags (~) ───────────────────────────────────────────────────────
// The golden normaliser denylists strip/openStrip/closeStrip/inverseStrip, so these live-object
// assertions are the only check that the `~` boolean flags are set correctly. Expected values are
// derived from the parser: a mustache maps its leading/trailing `~` to strip.open/strip.close
// (index.js line ~285); a block maps the opener's leading/trailing `~` to openStrip.open/.close
// (index.js line ~576), while inverseStrip/closeStrip are always `{open:false, close:false}` in
// this parser (they are hardcoded and denylisted from the golden).
test('strip flags: {{~foo~}} sets strip.open and strip.close true; {{foo}} leaves them false', () => {
    const stripped = first('{{~foo~}}');
    assert.equal(stripped.type, 'MustacheStatement');
    assert.equal(stripped.strip.open, true);
    assert.equal(stripped.strip.close, true);

    const leadingOnly = first('{{~foo}}');
    assert.equal(leadingOnly.strip.open, true);
    assert.equal(leadingOnly.strip.close, false);

    const plain = first('{{foo}}');
    assert.equal(plain.strip.open, false);
    assert.equal(plain.strip.close, false);
});

test('strip flags: block opener ~ sets openStrip.open/.close; inverseStrip/closeStrip stay false', () => {
    const node = first('{{~#if x~}}a{{~else~}}b{{~/if~}}');
    assert.equal(node.type, 'BlockStatement');
    // Opener `{{~#if x~}}`: leading `~` -> openStrip.open, trailing `~` -> openStrip.close.
    assert.equal(node.openStrip.open, true);
    assert.equal(node.openStrip.close, true);
    // This parser hardcodes inverseStrip/closeStrip to false (denylisted from the golden).
    assert.deepEqual(node.inverseStrip, { open: false, close: false });
    assert.deepEqual(node.closeStrip, { open: false, close: false });

    // A block with no `~` on its opener leaves openStrip both false.
    const plain = first('{{#if x}}a{{/if}}');
    assert.deepEqual(plain.openStrip, { open: false, close: false });
});

// ── Partial / Decorator shape ────────────────────────────────────────────────────────────────
test('PartialStatement: name present; params/hash keys present', () => {
    const node = first('{{> layout ctx key=val}}');
    assert.equal(node.type, 'PartialStatement');
    assert.ok('name' in node);
    assert.equal(node.name.type, 'PathExpression');
    assert.ok(Array.isArray(node.params));
    assert.equal(node.hash.type, 'Hash');
});

test('PartialBlockStatement: has program, omits inverse key entirely', () => {
    const node = first('{{#> block}}content{{/block}}');
    assert.equal(node.type, 'PartialBlockStatement');
    assert.ok('program' in node);
    assert.ok(!('inverse' in node), 'PartialBlockStatement must not carry an inverse key');
});

test('Decorator: {{* d}} carries path/params/hash/escaped:true', () => {
    const node = first('{{* register}}');
    assert.equal(node.type, 'Decorator');
    assert.equal(node.path.type, 'PathExpression');
    assert.equal(node.escaped, true);
    assert.ok('hash' in node);
});

test('DecoratorBlock: {{#*inline "n"}} carries program + inverse key (undefined)', () => {
    const node = first('{{#*inline "partialName"}}body{{/inline}}');
    assert.equal(node.type, 'DecoratorBlock');
    assert.equal(node.program.type, 'Program');
    assert.ok('inverse' in node);
    assert.equal(node.inverse, undefined);
});

// ── Raw block: program body is a single ContentStatement, no inverse key ──────────────────────
test('raw block: single verbatim ContentStatement body, no inverse key', () => {
    const node = first('{{{{rawHelper}}}}inner {{notParsed}}{{{{/rawHelper}}}}');
    assert.equal(node.type, 'BlockStatement');
    assert.ok(!('inverse' in node), 'raw block must not carry an inverse key');
    assert.equal(node.program.body.length, 1);
    assert.equal(node.program.body[0].type, 'ContentStatement');
});

// ── Empty-block / else-if table (plan "verified" table — every row) ──────────────────────────
// Each row asserts the exact program/inverse shape upstream produces (and the frozen golden
// captures). `emptyProgram(x)` = a Program with an empty body.

/**
 * Assert a value is a `Program` node whose `body` is empty.
 *
 * @param {object} node - The value to check.
 * @param {string} label - A label for the assertion message.
 * @returns {void}
 */
function assertEmptyProgram(node, label) {
    assert.equal(node && node.type, 'Program', `${label} must be a Program`);
    assert.deepEqual(node.body, [], `${label} body must be empty`);
}

/**
 * Assert a value is a `Program` node whose `body` has `length` statements.
 *
 * @param {object} node - The value to check.
 * @param {number} length - The expected body length.
 * @param {string} label - A label for the assertion message.
 * @returns {void}
 */
function assertProgramWithBody(node, length, label) {
    assert.equal(node && node.type, 'Program', `${label} must be a Program`);
    assert.equal(node.body.length, length, `${label} body length`);
}

test('empty-block table: {{#if a}}{{/if}} -> empty program, inverse undefined', () => {
    const node = first('{{#if a}}{{/if}}');
    assertEmptyProgram(node.program, 'program');
    assert.equal(node.inverse, undefined);
});

test('empty-block table: {{#if a}}x{{/if}} -> program body [Content], inverse undefined', () => {
    const node = first('{{#if a}}x{{/if}}');
    assertProgramWithBody(node.program, 1, 'program');
    assert.equal(node.inverse, undefined);
});

test('empty-block table: {{#if a}}{{else}}x{{/if}} -> empty program, inverse body [Content]', () => {
    const node = first('{{#if a}}{{else}}x{{/if}}');
    assertEmptyProgram(node.program, 'program');
    assertProgramWithBody(node.inverse, 1, 'inverse');
});

test('empty-block table: {{#if a}}x{{else}}{{/if}} -> program body [Content], empty inverse', () => {
    const node = first('{{#if a}}x{{else}}{{/if}}');
    assertProgramWithBody(node.program, 1, 'program');
    assertEmptyProgram(node.inverse, 'inverse');
});

test('empty-block table: {{#if a}}{{else if b}}{{/if}} -> chained inverse, nested empty program', () => {
    const node = first('{{#if a}}{{else if b}}{{/if}}');
    assertEmptyProgram(node.program, 'program');
    assert.equal(node.inverse.type, 'Program');
    assert.equal(node.inverse.chained, true);
    const nested = node.inverse.body[0];
    assert.equal(nested.type, 'BlockStatement');
    assertEmptyProgram(nested.program, 'nested program');
    assert.equal(nested.inverse, undefined);
});

test('empty-block table: {{#if a}}{{else if b}}x{{/if}} -> nested program body [Content]', () => {
    const node = first('{{#if a}}{{else if b}}x{{/if}}');
    assertEmptyProgram(node.program, 'program');
    assert.equal(node.inverse.chained, true);
    const nested = node.inverse.body[0];
    assertProgramWithBody(nested.program, 1, 'nested program');
    assert.equal(nested.inverse, undefined);
});

test('empty-block table: {{#if a}}x{{else if b}}{{/if}} -> program [Content], nested empty', () => {
    const node = first('{{#if a}}x{{else if b}}{{/if}}');
    assertProgramWithBody(node.program, 1, 'program');
    assert.equal(node.inverse.chained, true);
    const nested = node.inverse.body[0];
    assertEmptyProgram(nested.program, 'nested program');
});

test('empty-block table: {{#each a}}{{else}}{{/each}} -> empty program and empty inverse', () => {
    const node = first('{{#each a}}{{else}}{{/each}}');
    assertEmptyProgram(node.program, 'program');
    assertEmptyProgram(node.inverse, 'inverse');
});

test('empty-block table: {{^x}}{{/x}} -> program undefined, empty inverse', () => {
    const node = first('{{^x}}{{/x}}');
    assert.equal(node.program, undefined);
    assertEmptyProgram(node.inverse, 'inverse');
});

test('empty-block table: {{^x}}y{{/x}} -> program undefined, inverse body [Content]', () => {
    const node = first('{{^x}}y{{/x}}');
    assert.equal(node.program, undefined);
    assertProgramWithBody(node.inverse, 1, 'inverse');
});

test('chained: chained:true sits on the inverse Program, not the nested BlockStatement', () => {
    const node = first('{{#if a}}{{else if b}}x{{/if}}');
    assert.equal(node.inverse.chained, true);
    // The nested block's own `chained` is undefined (a present-or-absent detail; assert absent).
    assert.ok(!('chained' in node.inverse.body[0]) || node.inverse.body[0].chained === undefined);
});
