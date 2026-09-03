/**
 * AST node factory for sfmc-handlebars-parser.
 *
 * One builder per upstream `@handlebars/parser@2.2.2` AST node type. Each builder stamps the
 * node's `type`, its type-specific fields, and a `loc` {@link import('./loc.js').SourceLocation}
 * built via {@link locFromOffsets}. The shapes reproduce the frozen golden
 * (`tests/golden/ast.baseline.json`) EXACTLY — field names, `undefined`-valued-key vs omitted
 * rules, and literal `value`/`original` typing — so the parity gate (W3a) diffs to zero.
 *
 * Clean-room note: written from the observed public AST behaviour of `@handlebars/parser`
 * (MIT) and the Handlebars language spec; no upstream source was copied.
 *
 * ── loc contract ─────────────────────────────────────────────────────────────────────────
 * Every node's `loc` is `{ start, end, source }` where `start`/`end` are
 * {@link import('./loc.js').Position} objects and `source` is `undefined` (the key is PRESENT
 * with value `undefined`, matching upstream's `SourceLocation` when `parse` is called without a
 * `srcName`; the golden captures it as `"source": {"__undefined__": true}`). All builders that
 * take offsets go through {@link makeLoc}, so this is uniform.
 *
 * ── undefined-valued keys ────────────────────────────────────────────────────────────────
 * The golden preserves keys whose value is `undefined` (via the capture serialiser's
 * `{ __undefined__: true }` marker). Two expression-level cases matter for W2a:
 *   - `hash` on {@link mustacheStatement}/{@link subExpression}/block/partial/decorator is the
 *     key `hash` present with value `undefined` when there is no `k=v` pair; a real
 *     {@link hash} node is emitted only when >= 1 pair exists. W2a's
 *     {@link import('./expression.js').parseParametersAndHash} returns `hash: undefined` in that
 *     case, and the caller passes it straight through — assigning `undefined` keeps the key.
 *   - Literal `original`/`value` for {@link undefinedLiteral} are genuinely `undefined`.
 */

import { locFromOffsets } from './loc.js';

/**
 * Builds a node `loc` matching the upstream `SourceLocation` shape: `{ start, end, source }`
 * with `source` present and `undefined`. Delegates start/end to {@link locFromOffsets}.
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source being parsed.
 * @param {number} startOffset - Absolute offset (UTF-16 code unit) of the node's first code unit.
 * @param {number} endOffset - Absolute offset just past the node's last code unit.
 * @returns {import('./loc.js').SourceLocation} The `{ start, end, source: undefined }` location.
 */
export function makeLoc(table, startOffset, endOffset) {
    const loc = locFromOffsets(table, startOffset, endOffset);
    loc.source = undefined;
    return loc;
}

/**
 * Builds a `PathExpression` node.
 *
 * Upstream splits a dotted/slashed path into `parts` (segment strings), derives `head` =
 * `parts[0]` (or `undefined` for a bare `this`, whose `parts` is empty) and `tail` =
 * `parts.slice(1)`, and records `original` = the raw path text with segment-literal brackets
 * removed but every separator kept verbatim (e.g. `@root.[0].x` -> `@root.0.x`, `group/member`
 * -> `group/member`). `data` is `true` for an `@`-prefixed path; `depth` counts leading `../`;
 * `this` is `true` only when the path began with a `this` head that carried further segments
 * (`this.label` -> `this:true`, bare `this` -> `this:false`).
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the path's first code unit.
 * @param {number} endOffset - Offset just past the path's last code unit.
 * @param {object} fields - The precomputed path fields.
 * @param {boolean} fields.data - Whether the path is `@`-data-prefixed.
 * @param {number} fields.depth - Number of leading `../` parent hops.
 * @param {string[]} fields.parts - The resolved segment strings (brackets removed).
 * @param {string} fields.original - The raw path text with brackets removed, separators kept.
 * @param {boolean} fields.this - Whether the path had an explicit `this` head with a tail.
 * @returns {object} A `PathExpression` node.
 */
export function pathExpression(table, startOffset, endOffset, fields) {
    const parts = fields.parts;
    return {
        type: 'PathExpression',
        data: fields.data,
        depth: fields.depth,
        parts,
        head: parts[0],
        tail: parts.slice(1),
        this: fields.this,
        original: fields.original,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds a `StringLiteral` node. `value` is the decoded string; `original` mirrors it (upstream
 * stores the decoded value in both for string literals).
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the opening quote.
 * @param {number} endOffset - Offset just past the closing quote.
 * @param {string} value - The decoded string value.
 * @returns {object} A `StringLiteral` node.
 */
export function stringLiteral(table, startOffset, endOffset, value) {
    return {
        type: 'StringLiteral',
        value,
        original: value,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds a `NumberLiteral` node. Both `value` and `original` are the NUMERIC value (upstream
 * stores a JS number in both, not the raw lexeme).
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the number's first code unit.
 * @param {number} endOffset - Offset just past the number's last code unit.
 * @param {number} value - The parsed numeric value.
 * @returns {object} A `NumberLiteral` node.
 */
export function numberLiteral(table, startOffset, endOffset, value) {
    return {
        type: 'NumberLiteral',
        value,
        original: value,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds a `BooleanLiteral` node. Both `value` and `original` are the boolean.
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the literal's first code unit.
 * @param {number} endOffset - Offset just past the literal's last code unit.
 * @param {boolean} value - The boolean value.
 * @returns {object} A `BooleanLiteral` node.
 */
export function booleanLiteral(table, startOffset, endOffset, value) {
    return {
        type: 'BooleanLiteral',
        value,
        original: value,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds a `NullLiteral` node. Both `value` and `original` are `null`.
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the literal's first code unit.
 * @param {number} endOffset - Offset just past the literal's last code unit.
 * @returns {object} A `NullLiteral` node.
 */
export function nullLiteral(table, startOffset, endOffset) {
    return {
        type: 'NullLiteral',
        value: null,
        original: null,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds an `UndefinedLiteral` node. Both `value` and `original` are `undefined` (present keys).
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the literal's first code unit.
 * @param {number} endOffset - Offset just past the literal's last code unit.
 * @returns {object} An `UndefinedLiteral` node.
 */
export function undefinedLiteral(table, startOffset, endOffset) {
    return {
        type: 'UndefinedLiteral',
        value: undefined,
        original: undefined,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds a `HashPair` node. `key` is the pair name (a plain string); `value` is a literal, path,
 * or subexpression node. The pair `loc` spans from the key's first code unit to the value's last.
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the key's first code unit.
 * @param {number} endOffset - Offset just past the value's last code unit.
 * @param {string} key - The hash-pair key.
 * @param {object} value - The value node (literal / path / subexpression).
 * @returns {object} A `HashPair` node.
 */
export function hashPair(table, startOffset, endOffset, key, value) {
    return {
        type: 'HashPair',
        key,
        value,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds a `Hash` node wrapping >= 1 {@link hashPair}. The `Hash` `loc` spans from the first
 * pair's start to the last pair's end. A `Hash` node is emitted ONLY when at least one pair
 * exists; callers pass `hash: undefined` (a present key) otherwise — see the module header.
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the first pair's first code unit.
 * @param {number} endOffset - Offset just past the last pair's last code unit.
 * @param {object[]} pairs - The `HashPair` nodes (>= 1).
 * @returns {object} A `Hash` node.
 */
export function hash(table, startOffset, endOffset, pairs) {
    return {
        type: 'Hash',
        pairs,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds a `SubExpression` node: `( path params hash )`. `hash` is a real {@link hash} node when
 * >= 1 pair, else the key present with value `undefined`. The `loc` spans the parens inclusive.
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the opening `(`.
 * @param {number} endOffset - Offset just past the closing `)`.
 * @param {object} path - The call-path node (a `PathExpression`).
 * @param {object[]} parameters - The positional parameter nodes (possibly empty).
 * @param {object|undefined} hashNode - A `Hash` node, or `undefined` when no `k=v` pair.
 * @returns {object} A `SubExpression` node.
 */
export function subExpression(table, startOffset, endOffset, path, parameters, hashNode) {
    return {
        type: 'SubExpression',
        path,
        params: parameters,
        hash: hashNode,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds a `ContentStatement` node — a run of literal template text between mustaches. `value`
 * is the rendered text and `original` the raw source slice; upstream's whitespace-control pass
 * can later mutate `value`, so both are stored (the golden denylists `value`, keeping `original`).
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the content's first code unit.
 * @param {number} endOffset - Offset just past the content's last code unit.
 * @param {string} value - The rendered text value.
 * @param {string} original - The raw source text of the run.
 * @returns {object} A `ContentStatement` node.
 */
export function contentStatement(table, startOffset, endOffset, value, original) {
    return {
        type: 'ContentStatement',
        value,
        original,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds a `MustacheStatement` node — `{{ path params hash }}` (or `{{{ … }}}` / `{{& … }}`).
 * `escaped` is `true` for the HTML-escaping `{{` form and `false` for the unescaped
 * `{{{`/`{{&` forms.
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the opening delimiter.
 * @param {number} endOffset - Offset just past the closing delimiter.
 * @param {object} path - The call head (a `PathExpression` or literal node).
 * @param {object[]} parameters - The positional parameter nodes (possibly empty).
 * @param {object|undefined} hashNode - A `Hash` node, or `undefined` when no `k=v` pair.
 * @param {boolean} escaped - Whether this is the HTML-escaping `{{` form.
 * @param {{open: boolean, close: boolean}} strip - Whitespace-control flags (denylisted in the
 * golden but kept for the plugin).
 * @returns {object} A `MustacheStatement` node.
 */
export function mustacheStatement(
    table,
    startOffset,
    endOffset,
    path,
    parameters,
    hashNode,
    escaped,
    strip,
) {
    return {
        type: 'MustacheStatement',
        path,
        params: parameters,
        hash: hashNode,
        escaped,
        strip,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds a `CommentStatement` node from a `{{! … }}` or `{{!-- … --}}` comment.
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the opening `{{`.
 * @param {number} endOffset - Offset just past the closing delimiter.
 * @param {string} value - The raw inner comment text.
 * @param {{open: boolean, close: boolean}} strip - Whitespace-control flags (denylisted).
 * @returns {object} A `CommentStatement` node.
 */
export function commentStatement(table, startOffset, endOffset, value, strip) {
    return {
        type: 'CommentStatement',
        value,
        strip,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds a `Program` node — a body of statements. The `loc` key is always PRESENT; its value is
 * `undefined` for an empty body (matching upstream, which omits the span for empty programs) and
 * a real span otherwise. The `blockParams` and `chained` keys are included ONLY when the caller
 * passes the corresponding option, reproducing the golden's key-presence rules:
 *   - a block's primary program carries `blockParams` (array or `undefined`);
 *   - an `{{else}}`/`{{else if}}` inverse program does NOT carry `blockParams`;
 *   - a chained `{{else if}}` inverse program carries `chained: true`;
 *   - raw-block and partial-block programs carry neither.
 *
 * @param {object[]} body - The statement nodes.
 * @param {import('./loc.js').SourceLocation|undefined} loc - The program span, or `undefined`.
 * @param {object} [options] - Optional key-presence controls.
 * @param {boolean} [options.hasBlockParams] - Include a `blockParams` key.
 * @param {string[]|undefined} [options.blockParams] - The block-param names (or `undefined`).
 * @param {boolean} [options.chained] - Include `chained: true`.
 * @returns {object} A `Program` node.
 */
export function program(body, loc, options = {}) {
    const node = { type: 'Program', body };
    if (options.hasBlockParams) {
        node.blockParams = options.blockParams;
    }
    if (options.chained) {
        node.chained = true;
    }
    node.loc = loc;
    return node;
}

/**
 * Builds a `BlockStatement` node — `{{#x}} … {{/x}}` (with optional `{{else}}`/`{{^}}` inverse).
 * The `inverse` key is included when `hasInverse` is set (its value may be `undefined` for a
 * plain block that has no inverse but is not a raw block); raw blocks omit the key entirely.
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the opening `{{#`/`{{^`.
 * @param {number} endOffset - Offset just past the closing `{{/x}}`.
 * @param {object} fields - The block's child nodes and options.
 * @param {object} fields.path - The block-helper path.
 * @param {object[]} fields.params - The positional parameters.
 * @param {object|undefined} fields.hash - A `Hash` node or `undefined`.
 * @param {object|undefined} fields.programNode - The primary `Program` (or `undefined`).
 * @param {boolean} fields.hasInverse - Whether to include the `inverse` key.
 * @param {object|undefined} [fields.inverse] - The inverse `Program` (or `undefined`).
 * @param {{open: boolean, close: boolean}} fields.openStrip - Open-delimiter strip flags.
 * @param {{open: boolean, close: boolean}} fields.inverseStrip - Inverse-delimiter strip flags.
 * @param {{open: boolean, close: boolean}} fields.closeStrip - Close-delimiter strip flags.
 * @returns {object} A `BlockStatement` node.
 */
export function blockStatement(table, startOffset, endOffset, fields) {
    const node = {
        type: 'BlockStatement',
        path: fields.path,
        params: fields.params,
        hash: fields.hash,
        program: fields.programNode,
    };
    if (fields.hasInverse) {
        node.inverse = fields.inverse;
    }
    node.openStrip = fields.openStrip;
    node.inverseStrip = fields.inverseStrip;
    node.closeStrip = fields.closeStrip;
    node.loc = makeLoc(table, startOffset, endOffset);
    return node;
}

/**
 * Builds a `PartialStatement` node — `{{> name params hash }}`. `name` is a `PathExpression` or
 * a `SubExpression`. `indent` is the leading-whitespace indent captured for standalone partials
 * (empty string for inline ones).
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the opening `{{>`.
 * @param {number} endOffset - Offset just past the closing delimiter.
 * @param {object} fields - The partial's child nodes and options.
 * @param {object} fields.name - The partial name (`PathExpression`/`SubExpression`).
 * @param {object[]} fields.params - The positional parameters.
 * @param {object|undefined} fields.hash - A `Hash` node or `undefined`.
 * @param {string} fields.indent - The captured indent string.
 * @param {{open: boolean, close: boolean}} fields.strip - Strip flags (denylisted).
 * @returns {object} A `PartialStatement` node.
 */
export function partialStatement(table, startOffset, endOffset, fields) {
    return {
        type: 'PartialStatement',
        name: fields.name,
        params: fields.params,
        hash: fields.hash,
        indent: fields.indent,
        strip: fields.strip,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds a `PartialBlockStatement` node — `{{#> name}} … {{/name}}`. Carries a `program` body
 * and no `inverse` key.
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the opening `{{#>`.
 * @param {number} endOffset - Offset just past the closing `{{/name}}`.
 * @param {object} fields - The partial-block's child nodes and options.
 * @param {object} fields.name - The partial name (`PathExpression`/`SubExpression`).
 * @param {object[]} fields.params - The positional parameters.
 * @param {object|undefined} fields.hash - A `Hash` node or `undefined`.
 * @param {object|undefined} fields.programNode - The `Program` body (or `undefined`).
 * @param {{open: boolean, close: boolean}} fields.openStrip - Open-delimiter strip flags.
 * @param {{open: boolean, close: boolean}} fields.closeStrip - Close-delimiter strip flags.
 * @returns {object} A `PartialBlockStatement` node.
 */
export function partialBlockStatement(table, startOffset, endOffset, fields) {
    return {
        type: 'PartialBlockStatement',
        name: fields.name,
        params: fields.params,
        hash: fields.hash,
        program: fields.programNode,
        openStrip: fields.openStrip,
        closeStrip: fields.closeStrip,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds a `Decorator` node — `{{* name params hash }}`. Mirrors {@link mustacheStatement} but
 * with a `Decorator` type; `escaped` is always `true` in upstream's output.
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the opening `{{*`.
 * @param {number} endOffset - Offset just past the closing delimiter.
 * @param {object} path - The decorator path.
 * @param {object[]} parameters - The positional parameters.
 * @param {object|undefined} hashNode - A `Hash` node or `undefined`.
 * @param {{open: boolean, close: boolean}} strip - Strip flags (denylisted).
 * @returns {object} A `Decorator` node.
 */
export function decorator(table, startOffset, endOffset, path, parameters, hashNode, strip) {
    return {
        type: 'Decorator',
        path,
        params: parameters,
        hash: hashNode,
        escaped: true,
        strip,
        loc: makeLoc(table, startOffset, endOffset),
    };
}

/**
 * Builds a `DecoratorBlock` node — `{{#* name}} … {{/name}}`. Carries a `program` body and an
 * `inverse` key (`undefined` in practice).
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Offset of the opening `{{#*`.
 * @param {number} endOffset - Offset just past the closing `{{/name}}`.
 * @param {object} fields - The decorator-block's child nodes and options.
 * @param {object} fields.path - The decorator path.
 * @param {object[]} fields.params - The positional parameters.
 * @param {object|undefined} fields.hash - A `Hash` node or `undefined`.
 * @param {object|undefined} fields.programNode - The `Program` body (or `undefined`).
 * @param {object|undefined} fields.inverse - The inverse (`undefined`).
 * @param {{open: boolean, close: boolean}} fields.openStrip - Open-delimiter strip flags.
 * @param {{open: boolean, close: boolean}} fields.closeStrip - Close-delimiter strip flags.
 * @returns {object} A `DecoratorBlock` node.
 */
export function decoratorBlock(table, startOffset, endOffset, fields) {
    return {
        type: 'DecoratorBlock',
        path: fields.path,
        params: fields.params,
        hash: fields.hash,
        program: fields.programNode,
        inverse: fields.inverse,
        openStrip: fields.openStrip,
        closeStrip: fields.closeStrip,
        loc: makeLoc(table, startOffset, endOffset),
    };
}
