/**
 * sfmc-handlebars-parser — a zero-dependency Handlebars parser for SFMC tooling.
 *
 * Clean-room note: this parser is written from the observed public AST behaviour of
 * `@handlebars/parser` and the published Handlebars language specification. No source
 * was copied from handlebars.js or `@handlebars/parser` (both MIT). The upstream package
 * is kept only as a devDependency, used by the capture/differential tooling to freeze the
 * AST/error goldens the parser is verified against.
 *
 * The public entry point is {@link parse}, which returns the upstream-compatible
 * `AST.Program` node (see `src/index.d.ts`).
 *
 * ── W2b-1 scope (LEAF statements + block seam) ───────────────────────────────────────────
 * This module (worker W2b-1) implements the top-level {@link parse} skeleton plus the
 * BLOCK-FREE statement layer: {@link ContentStatement}, {@link MustacheStatement} (escaped
 * `{{ }}`, unescaped `{{{ }}}` / `{{& }}`, literal-as-head), and {@link CommentStatement}. It
 * drives the shared expression reader (W2a) for the mustache body and reproduces the golden
 * shapes exactly.
 *
 * BLOCKS are NOT implemented here. Every block-opening construct (`{{#…}}` / `{{#>…}}` /
 * `{{#*…}}`, an inverse `{{^…}}`, a partial `{{>…}}`, a decorator `{{*…}}`, or a raw block
 * `{{{{…}}}}`) is routed to {@link parseBlockLike} — the single well-named SEAM that worker
 * W2b-2 replaces with real block / else-chain / blockParams / partial-block / decorator-block /
 * raw-block handling. Today {@link parseBlockLike} throws a not-yet-implemented marker so the
 * block corpus files fail loudly rather than silently mis-parse. See the seam docblock below
 * for the exact hand-off contract.
 */

import { tokenizeWithLineTable, TokenType, TokenizerError } from './tokenizer.js';
import { buildLineTable, offsetToPosition } from './loc.js';
import {
    createReader,
    parseLiteral,
    parseParametersAndHash,
    parsePath,
    parseSubExpression,
} from './expression.js';
import {
    contentStatement,
    mustacheStatement,
    commentStatement,
    program,
    makeLoc,
    blockStatement,
    partialStatement,
    partialBlockStatement,
    decorator,
    decoratorBlock,
} from './nodes.js';
import { HandlebarsParseError, HandlebarsException } from './errors.js';

/**
 * The sigil values that open a BLOCK (handled by the W2b-2 seam, not W2b-1). The inverse `^`,
 * partial `>` and decorator `*` sigils are ALSO non-leaf statement openers routed to the seam.
 */
const BLOCK_SIGILS = new Set(['#', '#>', '#*', '^', '>', '*']);

/**
 * Token types that open a real mustache/comment run immediately after plain content. Used to
 * detect the escaped-backslash-before-a-mustache case (`\\{{`) in {@link parseContent}.
 */
const MUSTACHE_OPENER_TYPES = new Set([TokenType.OPEN, TokenType.RAW_OPEN, TokenType.COMMENT]);

/**
 * Parses a Handlebars template string into an upstream-compatible AST.
 *
 * Tokenizes the source (capturing a line table for `loc` resolution), wraps the token stream in
 * the shared expression reader, and runs {@link parseProgram} at the top level to assemble the
 * root `Program`. Lexical errors thrown by the tokenizer are converted to the plan's error
 * classes ({@link HandlebarsParseError} / {@link HandlebarsException}) at the reported offset.
 *
 * @param {string} code - The Handlebars (or HTML-with-Handlebars) source to parse.
 * @returns {import('./index.d.ts').AST.Program} The root `Program` node.
 * @throws {HandlebarsParseError} On a Jison-class parse error (unexpected token / empty body).
 * @throws {HandlebarsException} On an exception-class lexical error (unterminated comment).
 */
export function parse(code) {
    let tokens;
    let lineTable;
    try {
        ({ tokens, lineTable } = tokenizeWithLineTable(code));
    } catch (ex) {
        throw convertTokenizerError(ex, code);
    }
    const reader = createReader(tokens, lineTable, code);
    const body = parseProgram(reader, isTopTerminator);
    // A well-formed block-free template consumes every token up to EOF.
    if (!reader.atEnd()) {
        const token = reader.peek();
        throw jisonAt(lineTable, token.start, token.end);
    }
    // Upstream spans the Program from its FIRST child's start to its LAST child's end (the
    // per-node `loc`s already account for escaped content trimming a leading `\`). An empty
    // top-level body has no children to span, so fall back to the whole-source range.
    const loc =
        body.length > 0
            ? { start: body[0].loc.start, end: body.at(-1).loc.end, source: undefined }
            : makeLoc(lineTable, 0, code.length);
    return program(body, loc);
}

/**
 * Terminator predicate for the TOP-LEVEL program: nothing but `EOF` ends it. Sub-programs (block
 * bodies / inverse branches — W2b-2) will pass their own terminator (a `{{/…}}` close or an
 * `{{else}}`), so {@link parseProgram} stays reusable for nested bodies.
 *
 * @param {object} token - The next statement-level token.
 * @returns {boolean} True when `token` ends the top-level program (i.e. it is `EOF`).
 */
function isTopTerminator(token) {
    return token.type === TokenType.EOF;
}

/**
 * Parses a run of statements into a `body` array, dispatching on the statement-level token type
 * until `isTerminator` matches the next token (or `EOF` is reached). This is the reusable program
 * loop: W2b-2 calls it with a block-close terminator to parse a block body or inverse branch.
 *
 * Dispatch:
 *   - `CONTENT`                       → {@link parseContent} (merges contiguous content runs).
 *   - `COMMENT`                       → {@link parseComment}.
 *   - `OPEN` + block/partial/decorator/inverse `SIGIL`, or `RAW_OPEN` → {@link parseBlockLike}
 *     (the W2b-2 seam). Bare `{{^}}` (an inverse sigil with no path) is a top-level Jison error
 *     owned by W2b-1 and thrown here.
 *   - `OPEN` (plain, `{{{`, or `{{&`) → {@link parseMustache}.
 *
 * @param {object} reader - The shared cursor from {@link createReader}.
 * @param {(token: object) => boolean} isTerminator - Predicate matching the token that ends this
 * program body (WITHOUT consuming it — the caller decides how to consume the terminator).
 * @returns {object[]} The parsed statement nodes.
 */
export function parseProgram(reader, isTerminator) {
    /**
    @type {object[]}
     */
    const body = [];
    while (true) {
        const token = reader.peek();
        if (!token || token.type === TokenType.EOF || isTerminator(token)) {
            break;
        }
        if (token.type === TokenType.CONTENT) {
            body.push(parseContent(reader));
            continue;
        }
        if (token.type === TokenType.COMMENT) {
            body.push(parseComment(reader));
            continue;
        }
        if (token.type === TokenType.RAW_OPEN) {
            body.push(parseBlockLike(reader));
            continue;
        }
        if (token.type === TokenType.OPEN) {
            const sigil = reader.peek(1);
            if (sigil && sigil.type === TokenType.SIGIL && BLOCK_SIGILS.has(sigil.value)) {
                // Bare `{{^}}` / `{{^ }}` (an inverse sigil with no path) is not a block — it is
                // an unexpected INVERSE token at statement level. Upstream throws a Jison parse
                // error at `1:0`; reproduce that here (W2b-1 owns bare-caret).
                if (sigil.value === '^' && isBareInverse(reader)) {
                    throw jisonAt(reader.table, 0, 0);
                }
                body.push(parseBlockLike(reader));
                continue;
            }
            // A bare `{{else}}` / `{{else if}}` (OPEN + ID `else`) that reaches statement-level
            // dispatch is not enclosed by a block — upstream throws a Jison parse error anchored
            // at the opener (`got 'INVERSE'`). Block bodies consume their own `{{else}}` via the
            // terminator, so this only fires for a stray/top-level else.
            if (sigil && sigil.type === TokenType.ID && sigil.value === 'else') {
                throw jisonAt(reader.table, token.start, token.start);
            }
            body.push(parseMustache(reader));
            continue;
        }
        // Any other statement-level token here is unexpected (e.g. a stray CLOSE / SIGIL).
        throw jisonAt(reader.table, token.start, token.end);
    }
    return body;
}

/**
 * Whether the OPEN + `^` SIGIL at the cursor is a BARE inverse (`{{^}}` / `{{^ }}`) — i.e. the
 * `^` is followed only by whitespace and then the CLOSE, with no path. A `^` followed by a path
 * (`{{^x}}`) is a real inverse block for W2b-2. Does NOT advance the cursor.
 *
 * @param {object} reader - The shared cursor from {@link createReader}.
 * @returns {boolean} True for a bare inverse mustache.
 */
function isBareInverse(reader) {
    // Skip the OPEN (offset 0) and the SIGIL (offset 1); look past any whitespace for a CLOSE.
    let offset = 2;
    let token = reader.peek(offset);
    while (token && token.type === TokenType.WHITESPACE) {
        offset++;
        token = reader.peek(offset);
    }
    return !!token && token.type === TokenType.CLOSE;
}

/**
 * Parses a `ContentStatement` from a maximal run of CONTIGUOUS `CONTENT` tokens (each token's
 * `start` equal to the previous token's `end`). Upstream merges an escaped-mustache literal
 * (`\{{…}}`) with the surrounding plain text into a single `ContentStatement`, splitting only at
 * a gap (the consumed backslash of the next `\{{`). A trailing backslash on plain content that
 * directly abuts a real mustache is the escaped-backslash case (`\\{{`): upstream drops ONE
 * trailing backslash from `original`/`value` (`\\{{` → content `\`, `\\\\{{` → `\\\`).
 *
 * @param {object} reader - The shared cursor from {@link createReader}.
 * @returns {object} A `ContentStatement` node.
 */
function parseContent(reader) {
    const first = reader.next();
    const startOffset = first.start;
    let endOffset = first.end;
    let value = first.value;
    let lastEscaped = first.escaped;
    // Merge contiguous CONTENT tokens (no gap between them).
    while (true) {
        const token = reader.peek();
        if (!token || token.type !== TokenType.CONTENT || token.start !== endOffset) {
            break;
        }
        value += token.value;
        endOffset = token.end;
        lastEscaped = token.escaped;
        reader.next();
    }
    let original = reader.source.slice(startOffset, endOffset);
    // Escaped-backslash before a real mustache: `\\{{` renders one backslash. The tokenizer keeps
    // the raw `\\`; drop one trailing backslash when this plain run directly abuts a real
    // mustache opener (OPEN / RAW_OPEN / COMMENT).
    if (!lastEscaped && original.endsWith('\\')) {
        const next = reader.peek();
        if (next && next.start === endOffset && MUSTACHE_OPENER_TYPES.has(next.type)) {
            original = original.slice(0, -1);
            value = value.slice(0, -1);
        }
    }
    return contentStatement(reader.table, startOffset, endOffset, value, original);
}

/**
 * Parses a `CommentStatement` from a single `COMMENT` token (`{{! … }}` or `{{!-- … --}}`). The
 * comment's inner text is the token `value`; the token already spans the whole comment.
 *
 * @param {object} reader - The shared cursor from {@link createReader}.
 * @returns {object} A `CommentStatement` node.
 */
function parseComment(reader) {
    const token = reader.next();
    const strip = { open: !!token.strip, close: !!token.closeStrip };
    return commentStatement(reader.table, token.start, token.end, token.value, strip);
}

/**
 * Parses a `MustacheStatement` (`{{ … }}`, `{{{ … }}}`, or `{{& … }}`). Consumes the OPEN, an
 * optional `&` SIGIL, the call head (a path, or a literal-as-head for `{{"str"}}` / `{{true}}` /
 * `{{5}}`), positional params + hash pairs (via W2a), then the CLOSE. `escaped` is `true` for the
 * `{{` form and `false` for the unescaped `{{{` / `{{&` forms.
 *
 * @param {object} reader - The shared cursor from {@link createReader}.
 * @returns {object} A `MustacheStatement` node.
 */
function parseMustache(reader) {
    const open = reader.expect(TokenType.OPEN);
    // `{{{` (triple) and `{{&` are the unescaped forms.
    let isEscaped = open.open !== '{{{';
    if (reader.peekType() === TokenType.SIGIL && reader.peek().value === '&') {
        isEscaped = false;
        reader.next();
    }
    reader.skipWhitespace();
    // Empty body (`{{ }}`) — upstream throws a Jison parse error anchored at the OPEN token.
    if (reader.peekType() === TokenType.CLOSE) {
        throw jisonAt(reader.table, open.start, open.end);
    }
    const head = parseCallHead(reader, open);
    const { params, hash } = parseParametersAndHash(
        reader,
        (token) => token.type === TokenType.CLOSE,
    );
    reader.skipWhitespace();
    const close = reader.expect(TokenType.CLOSE);
    const strip = { open: !!open.strip, close: !!close.strip };
    return mustacheStatement(
        reader.table,
        open.start,
        close.end,
        head,
        params,
        hash,
        isEscaped,
        strip,
    );
}

/**
 * Parses the CALL HEAD of a mustache: a literal (`{{"str"}}` / `{{true}}` / `{{5}}` place the
 * literal node in the `path` slot) when the cursor is on a standalone literal, otherwise a
 * `PathExpression`. When neither is possible (e.g. a leading `.` separator), upstream throws a
 * Jison parse error anchored at the OPEN token.
 *
 * @param {object} reader - The shared cursor from {@link createReader}.
 * @param {object} open - The consumed OPEN token (for error anchoring).
 * @returns {object} The head node (a literal or `PathExpression`).
 */
function parseCallHead(reader, open) {
    const literal = parseLiteral(reader);
    if (literal) {
        return literal;
    }
    reader.skipWhitespace();
    const token = reader.peek();
    // A path may begin with a relative/parent context (`./`, `../`) — a `.`/`..` SEP immediately
    // followed by a `/` SEP. A leading bare `.` SEP that is NOT part of `./` (e.g. `{{.foo}}`) is
    // an invalid path start: upstream throws a Jison "got 'SEP'" error anchored at the OPEN token.
    if (token && token.type === TokenType.SEP) {
        const next = reader.peek(1);
        const isRelativeStart = next && next.type === TokenType.SEP && next.value === '/';
        if (!isRelativeStart) {
            throw jisonAt(reader.table, open.start, open.end);
        }
    }
    return parsePath(reader);
}

/**
 * Parses a BLOCK-LIKE construct (worker W2b-2) — invoked by {@link parseProgram} with the reader
 * positioned ON the opener (nothing consumed). Dispatches on the opener:
 *   - `RAW_OPEN` → {@link parseRawBlock} (`{{{{name}}}} … {{{{/name}}}}`).
 *   - `OPEN` + SIGIL: `#` → {@link parseBlockStatement}; `^` (with a path) → caret-inverse
 *     shorthand (also {@link parseBlockStatement}); `>` → {@link parsePartial}; `#>` →
 *     {@link parsePartialBlock}; `*` → {@link parseDecorator}; `#*` → {@link parseDecoratorBlock}.
 *
 * Bare `{{^}}` / `{{^ }}` is intercepted by {@link parseProgram} before this hook.
 *
 * @param {object} reader - The shared cursor from {@link createReader}, positioned on the opener.
 * @returns {object} The block-like AST node.
 */
export function parseBlockLike(reader) {
    if (reader.peekType() === TokenType.RAW_OPEN) {
        return parseRawBlock(reader);
    }
    const sigil = reader.peek(1).value;
    switch (sigil) {
        case '#': {
            return parseBlockStatement(reader, false);
        }
        case '^': {
            // `{{^x}}…{{/x}}` — inverse-shorthand block (the body lives in `inverse`).
            return parseBlockStatement(reader, true);
        }
        case '>': {
            return parsePartial(reader);
        }
        case '#>': {
            return parsePartialBlock(reader);
        }
        case '*': {
            return parseDecorator(reader);
        }
        default: {
            // `#*`
            return parseDecoratorBlock(reader);
        }
    }
}

/**
 * Whether the token at `reader.peek(offset)` opens a block-close tag `{{/…}}` (an `OPEN` whose
 * next token is a `/` SIGIL). Does not advance the cursor.
 *
 * @param {object} reader - The shared cursor.
 * @param {number} [offset] - Look-ahead distance to the candidate `OPEN` (default 0).
 * @returns {boolean} True when a `{{/…}}` close begins at `offset`.
 */
function isCloseTag(reader, offset = 0) {
    const open = reader.peek(offset);
    const sigil = reader.peek(offset + 1);
    return (
        !!open &&
        open.type === TokenType.OPEN &&
        !!sigil &&
        sigil.type === TokenType.SIGIL &&
        sigil.value === '/'
    );
}

/**
 * Whether an inverse split (`{{else}}` / `{{else if …}}` / bare `{{^}}`) begins at the cursor.
 * An `else` split is `OPEN` + `ID('else')`; a bare-caret split is `OPEN` + `SIGIL('^')` followed
 * only by whitespace and a CLOSE. Does not advance the cursor.
 *
 * @param {object} reader - The shared cursor.
 * @returns {boolean} True when an inverse split begins at the cursor.
 */
function isInverseSplit(reader) {
    if (reader.peekType() !== TokenType.OPEN) {
        return false;
    }
    const marker = reader.peek(1);
    if (marker && marker.type === TokenType.ID && marker.value === 'else') {
        return true;
    }
    return (
        !!marker && marker.type === TokenType.SIGIL && marker.value === '^' && isBareInverse(reader)
    );
}

/**
 * Terminator predicate for a block BODY / inverse branch: the branch ends at an inverse split
 * (`{{else}}` / `{{^}}`) or a `{{/…}}` close, neither consumed.
 *
 * @param {object} reader - The shared cursor.
 * @returns {boolean} True when the current token ends the current branch.
 */
function atBranchEnd(reader) {
    return isCloseTag(reader) || isInverseSplit(reader);
}

/**
 * Parses the `as |a b|` block-params fence when it begins at the cursor (an `ID('as')` followed
 * by a `PIPE`), returning the parameter names. Consumes `as`, the opening `|`, the id run, and
 * the closing `|`. Returns `undefined` when no fence is present (the caller keeps the golden's
 * `blockParams: undefined`).
 *
 * @param {object} reader - The shared cursor, positioned after the params/hash.
 * @returns {string[]|undefined} The block-param names, or `undefined` when absent.
 */
function parseBlockParameters(reader) {
    reader.skipWhitespace();
    const asToken = reader.peek();
    if (!asToken || asToken.type !== TokenType.ID || asToken.value !== 'as') {
        return;
    }
    reader.next(); // `as`
    reader.skipWhitespace();
    reader.expect(TokenType.PIPE);
    /**
     * @type {string[]}
     */
    const names = [];
    while (true) {
        reader.skipWhitespace();
        const token = reader.peek();
        if (!token || token.type !== TokenType.ID) {
            break;
        }
        names.push(token.value);
        reader.next();
    }
    reader.skipWhitespace();
    reader.expect(TokenType.PIPE);
    return names;
}

/**
 * Builds a sub-program `Program` for a block body / inverse branch. An EMPTY body carries
 * `loc: undefined` (per the golden); a non-empty body spans `[bodyStart, bodyEnd)`.
 *
 * @param {object} reader - The shared cursor (for the line table).
 * @param {object[]} body - The parsed statement nodes.
 * @param {number} bodyStart - Offset where the body region begins (just after the opener's close).
 * @param {number} bodyEnd - Offset where the body region ends (start of the terminating tag).
 * @param {object} [options] - Program key-presence options (`hasBlockParams` / `chained`).
 * @returns {object} A `Program` node.
 */
function makeSubProgram(reader, body, bodyStart, bodyEnd, options) {
    const loc = body.length > 0 ? makeLoc(reader.table, bodyStart, bodyEnd) : undefined;
    return program(body, loc, options);
}

/**
 * Consumes a `{{/name}}` close tag, asserting it matches `openName`. On a name mismatch upstream
 * throws an exception-class error anchored at the opener path's start position (`name doesn't
 * match closer`). Returns the consumed `OPEN` and `CLOSE` tokens.
 *
 * @param {object} reader - The shared cursor, positioned on the `{{/…}}` `OPEN`.
 * @param {string} openName - The `original` text of the opener's path (for the match check).
 * @param {object} openPath - The opener's path node (for the mismatch error position).
 * @returns {{openToken: object, closeToken: object}} The consumed close-tag delimiters.
 * @throws {HandlebarsException} On a name mismatch.
 */
function consumeCloseTag(reader, openName, openPath) {
    const openToken = reader.expect(TokenType.OPEN);
    reader.expect(TokenType.SIGIL); // `/`
    const closePath = parsePath(reader);
    if (closePath.original !== openName) {
        const at = openPath.loc.start;
        throw new HandlebarsException(
            `${openName} doesn't match ${closePath.original} - ${at.line}:${at.column}`,
            { lineNumber: at.line, column: at.column },
        );
    }
    reader.skipWhitespace();
    const closeToken = reader.expect(TokenType.CLOSE);
    return { openToken, closeToken };
}

/**
 * Reports an unclosed block: upstream throws a Jison parse error anchored at the point where the
 * close was expected (the next token, typically `EOF`), e.g. `got 'EOF'`.
 *
 * @param {object} reader - The shared cursor, positioned where a close/inverse was expected.
 * @returns {never} Always throws.
 * @throws {HandlebarsParseError} The Jison-class unclosed-block error.
 */
function throwUnclosed(reader) {
    // Upstream anchors an unclosed block at the last consumed token through the point where the
    // close was expected (typically `EOF`): e.g. `{{#alpha}}x` reports `1:10`-`1:11` (the `x`
    // content start through `EOF`). Span `[previousToken.start, currentToken.end]`.
    const current = reader.peek() || { start: reader.source.length, end: reader.source.length };
    const previous = reader.peek(-1);
    const startOffset = previous ? previous.start : current.start;
    throw jisonAt(reader.table, startOffset, current.end);
}

/**
 * Parses a `BlockStatement` — `{{#name params hash as |bp|}} body {{else}} inverse {{/name}}` —
 * or the caret-inverse shorthand `{{^name}} body {{/name}}` (`isCaret`), consuming through the
 * matching `{{/name}}`.
 *
 * For the `#` form the body is the PRIMARY program (carries `blockParams`) and the `{{else}}` /
 * `{{else if}}` / `{{^}}` branch is the `inverse`. For the caret shorthand the body is placed in
 * `inverse` (which carries `blockParams`) and `program` is `undefined`.
 *
 * @param {object} reader - The shared cursor, positioned on the opener `OPEN`.
 * @param {boolean} isCaret - Whether this is the `{{^name}}` inverse-shorthand form.
 * @returns {object} A `BlockStatement` node.
 */
function parseBlockStatement(reader, isCaret) {
    const open = reader.expect(TokenType.OPEN);
    reader.expect(TokenType.SIGIL); // `#` or `^`
    const path = parsePath(reader);
    const { params, hash } = parseParametersAndHash(reader, headTerminator(reader));
    const blockParameters = parseBlockParameters(reader);
    reader.skipWhitespace();
    const openClose = reader.expect(TokenType.CLOSE);
    const bodyStart = openClose.end;

    // Body statements until an inverse split or the `{{/name}}` close.
    const body = parseProgram(reader, () => atBranchEnd(reader));
    if (reader.atEnd()) {
        throwUnclosed(reader);
    }
    const bodyEnd = reader.peek().start;
    const bodyProgram = makeSubProgram(reader, body, bodyStart, bodyEnd, {
        hasBlockParams: true,
        blockParams: blockParameters,
    });

    let primaryProgram;
    let inverse;
    if (isCaret) {
        // `{{^x}}` — the body lives in `inverse` (which carries blockParams); `program` is absent.
        primaryProgram = undefined;
        inverse = bodyProgram;
    } else {
        primaryProgram = bodyProgram;
        inverse = parseInverseBranch(reader, path).inverse;
    }

    // Consume the matching `{{/name}}` close.
    if (!isCloseTag(reader)) {
        throwUnclosed(reader);
    }
    const { closeToken } = consumeCloseTag(reader, path.original, path);
    return blockStatement(reader.table, open.start, closeToken.end, {
        path,
        params,
        hash,
        programNode: primaryProgram,
        hasInverse: true,
        inverse,
        openStrip: { open: !!open.strip, close: !!openClose.strip },
        inverseStrip: { open: false, close: false },
        closeStrip: { open: false, close: false },
    });
}

/**
 * Parses the inverse branch of a `#` block after its primary program: a plain `{{else}}` /
 * bare `{{^}}` inverse, an `{{else if …}}` chain (a nested `BlockStatement` under a
 * `chained: true` Program), or nothing (the cursor is already on `{{/name}}`). Does NOT consume
 * the shared `{{/name}}` close (the enclosing block does).
 *
 * @param {object} reader - The shared cursor, positioned on the terminator after the body.
 * @param {object} blockPath - The enclosing block's path node (for name-match / mismatch errors).
 * @returns {{inverse: (object|undefined)}} The inverse `Program` (or `undefined` when there is no
 * `{{else}}` branch — the cursor is on `{{/name}}`).
 */
function parseInverseBranch(reader, blockPath) {
    // No inverse: the body was terminated directly by `{{/name}}`.
    if (isCloseTag(reader)) {
        return { inverse: undefined };
    }
    const marker = reader.peek(1);
    // `{{else if …}}` chain — a nested block sharing the enclosing `{{/name}}` close.
    if (marker.type === TokenType.ID && marker.value === 'else' && isElseIf(reader)) {
        const { block } = parseChainedBlock(reader, blockPath);
        const chainedLoc = block.program === undefined ? block.loc : block.program.loc || block.loc;
        const inverse = program([block], chainedLoc, { chained: true });
        return { inverse };
    }
    // Plain `{{else}}` or bare `{{^}}` inverse.
    reader.expect(TokenType.OPEN);
    reader.next(); // `else` ID or `^` SIGIL
    reader.skipWhitespace();
    const elseClose = reader.expect(TokenType.CLOSE);
    const bodyStart = elseClose.end;
    const body = parseProgram(reader, () => atBranchEnd(reader));
    if (reader.atEnd()) {
        throwUnclosed(reader);
    }
    const bodyEnd = reader.peek().start;
    const inverse = makeSubProgram(reader, body, bodyStart, bodyEnd);
    return { inverse };
}

/**
 * Whether the `{{else …}}` at the cursor is an `{{else if …}}` chain (an `else` ID immediately
 * followed by another `ID` before the CLOSE) rather than a plain `{{else}}`. Does not advance.
 *
 * @param {object} reader - The shared cursor, positioned on the `{{else …}}` `OPEN`.
 * @returns {boolean} True for an `{{else if …}}` chain.
 */
function isElseIf(reader) {
    // OPEN(0) ID('else')(1) then, skipping whitespace, another ID before CLOSE.
    let offset = 2;
    let token = reader.peek(offset);
    while (token && token.type === TokenType.WHITESPACE) {
        offset++;
        token = reader.peek(offset);
    }
    return !!token && token.type === TokenType.ID;
}

/**
 * Parses one link of an `{{else if …}}` chain: consumes `{{else`, parses the nested block's head
 * (`if cond` etc.), its primary program, and recurses into its own inverse — all sharing the
 * enclosing block's `{{/name}}` close (NOT consumed here). The nested block's `loc` spans from
 * the `{{else …}}` opener to the shared close's `OPEN` start.
 *
 * @param {object} reader - The shared cursor, positioned on the `{{else if …}}` `OPEN`.
 * @param {object} blockPath - The enclosing block's path (for the shared close-name check).
 * @returns {{block: object}} The nested `BlockStatement`.
 */
function parseChainedBlock(reader, blockPath) {
    const open = reader.expect(TokenType.OPEN);
    reader.next(); // `else` ID
    reader.skipWhitespace();
    const path = parsePath(reader); // `if` (or another block helper)
    const { params, hash } = parseParametersAndHash(reader, headTerminator(reader));
    const blockParameters = parseBlockParameters(reader);
    reader.skipWhitespace();
    const openClose = reader.expect(TokenType.CLOSE);
    const bodyStart = openClose.end;

    const body = parseProgram(reader, () => atBranchEnd(reader));
    if (reader.atEnd()) {
        throwUnclosed(reader);
    }
    const bodyEnd = reader.peek().start;
    const primaryProgram = makeSubProgram(reader, body, bodyStart, bodyEnd, {
        hasBlockParams: true,
        blockParams: blockParameters,
    });
    const branch = parseInverseBranch(reader, blockPath);

    // The nested block ends at the shared `{{/name}}` close's OPEN start (not consumed here).
    if (!isCloseTag(reader)) {
        throwUnclosed(reader);
    }
    const closeOpenStart = reader.peek().start;
    const block = blockStatement(reader.table, open.start, closeOpenStart, {
        path,
        params,
        hash,
        programNode: primaryProgram,
        hasInverse: true,
        inverse: branch.inverse,
        openStrip: { open: !!open.strip, close: !!openClose.strip },
        inverseStrip: { open: false, close: false },
        closeStrip: { open: false, close: false },
    });
    return { block };
}

/**
 * Builds the params/hash terminator for a call HEAD (block / partial / decorator open): the head
 * ends at the CLOSE, a `PIPE` (block-params fence), or the `as` keyword that begins an
 * `as |a b|` fence. Bound to the reader so it can look past `as` for the `|`.
 *
 * @param {object} reader - The shared cursor.
 * @returns {(token: object) => boolean} The terminator predicate.
 */
function headTerminator(reader) {
    return (token) => {
        if (token.type === TokenType.CLOSE || token.type === TokenType.PIPE) {
            return true;
        }
        if (token.type === TokenType.ID && token.value === 'as') {
            // `as` followed (after whitespace) by `|` starts the blockParams fence — stop here so
            // `as` is not mis-parsed as a positional param.
            let offset = 1;
            let next = reader.peek(offset);
            while (next && next.type === TokenType.WHITESPACE) {
                offset++;
                next = reader.peek(offset);
            }
            return !!next && next.type === TokenType.PIPE;
        }
        return false;
    };
}

/**
 * Parses a raw block `{{{{name}}}} body {{{{/name}}}}` into a `BlockStatement` whose `program`
 * body is a single verbatim `ContentStatement` (inner `{{ }}` are NOT parsed). Raw blocks omit
 * the `inverse` key entirely and their program carries no `blockParams`.
 *
 * @param {object} reader - The shared cursor, positioned on the `RAW_OPEN`.
 * @returns {object} A `BlockStatement` node.
 */
function parseRawBlock(reader) {
    const rawOpen = reader.expect(TokenType.RAW_OPEN);
    // The block name path spans the `name` inside `{{{{name}}}}` (starts after the four braces).
    const nameStart = rawOpen.start + 4;
    const nameEnd = nameStart + rawOpen.name.length;
    const path = pathFromRawName(reader, rawOpen.name, nameStart, nameEnd);

    /**
     * @type {object[]}
     */
    const bodyStatements = [];
    if (reader.peekType() === TokenType.RAW_CONTENT) {
        const content = reader.next();
        bodyStatements.push(
            contentStatement(
                reader.table,
                content.start,
                content.end,
                content.value,
                content.value,
            ),
        );
    }
    const rawClose = reader.expect(TokenType.RAW_CLOSE);
    // Program + block span the whole construct `[RAW_OPEN.start, RAW_CLOSE.end)`.
    const programNode = program(bodyStatements, makeLoc(reader.table, rawOpen.start, rawClose.end));
    return blockStatement(reader.table, rawOpen.start, rawClose.end, {
        path,
        params: [],
        hash: undefined,
        programNode,
        hasInverse: false,
        openStrip: { open: false, close: false },
        inverseStrip: { open: false, close: false },
        closeStrip: { open: false, close: false },
    });
}

/**
 * Builds a bare `PathExpression` for a raw-block name (a single unbracketed segment).
 *
 * @param {object} reader - The shared cursor (for the line table).
 * @param {string} name - The raw-block name.
 * @param {number} startOffset - Offset of the name's first code unit.
 * @param {number} endOffset - Offset just past the name.
 * @returns {object} A `PathExpression` node.
 */
function pathFromRawName(reader, name, startOffset, endOffset) {
    const subReader = createReader(
        [
            { type: TokenType.ID, start: startOffset, end: endOffset, value: name },
            { type: TokenType.EOF, start: endOffset, end: endOffset },
        ],
        reader.table,
        reader.source,
    );
    return parsePath(subReader);
}

/**
 * Parses a `{{> name params hash}}` partial (or the `PartialStatement` head of any partial). The
 * `name` is a `PathExpression`, a `SubExpression` (`(…)`), or a `StringLiteral`.
 *
 * @param {object} reader - The shared cursor, positioned on the opener `OPEN`.
 * @returns {object} A `PartialStatement` node.
 */
function parsePartial(reader) {
    const open = reader.expect(TokenType.OPEN);
    reader.expect(TokenType.SIGIL); // `>`
    const name = parsePartialName(reader);
    const { params, hash } = parseParametersAndHash(
        reader,
        (token) => token.type === TokenType.CLOSE,
    );
    reader.skipWhitespace();
    const close = reader.expect(TokenType.CLOSE);
    return partialStatement(reader.table, open.start, close.end, {
        name,
        params,
        hash,
        indent: '',
        strip: { open: !!open.strip, close: !!close.strip },
    });
}

/**
 * Parses a `{{#> name}} body {{/name}}` partial block into a `PartialBlockStatement`.
 *
 * @param {object} reader - The shared cursor, positioned on the opener `OPEN`.
 * @returns {object} A `PartialBlockStatement` node.
 */
function parsePartialBlock(reader) {
    const open = reader.expect(TokenType.OPEN);
    reader.expect(TokenType.SIGIL); // `#>`
    const name = parsePartialName(reader);
    const { params, hash } = parseParametersAndHash(reader, headTerminator(reader));
    reader.skipWhitespace();
    const openClose = reader.expect(TokenType.CLOSE);
    const bodyStart = openClose.end;

    const body = parseProgram(reader, () => isCloseTag(reader));
    if (reader.atEnd()) {
        throwUnclosed(reader);
    }
    const bodyEnd = reader.peek().start;
    const programNode = makeSubProgram(reader, body, bodyStart, bodyEnd);
    const matchName = name.type === 'PathExpression' ? name.original : undefined;
    const { closeToken } = consumeCloseTag(reader, matchName, name);
    return partialBlockStatement(reader.table, open.start, closeToken.end, {
        name,
        params,
        hash,
        programNode,
        openStrip: { open: !!open.strip, close: !!openClose.strip },
        closeStrip: { open: false, close: false },
    });
}

/**
 * Parses a partial NAME: a `SubExpression` (`(…)`), a `StringLiteral`, or a `PathExpression`.
 *
 * @param {object} reader - The shared cursor, positioned after the partial sigil.
 * @returns {object} The partial-name node.
 */
function parsePartialName(reader) {
    reader.skipWhitespace();
    if (reader.peekType() === TokenType.OPEN_PAREN) {
        return parseSubExpression(reader);
    }
    const literal = parseLiteral(reader);
    if (literal) {
        return literal;
    }
    return parsePath(reader);
}

/**
 * Parses a `{{* name params hash}}` inline decorator into a `Decorator` node.
 *
 * @param {object} reader - The shared cursor, positioned on the opener `OPEN`.
 * @returns {object} A `Decorator` node.
 */
function parseDecorator(reader) {
    const open = reader.expect(TokenType.OPEN);
    reader.expect(TokenType.SIGIL); // `*`
    const path = parsePath(reader);
    const { params, hash } = parseParametersAndHash(
        reader,
        (token) => token.type === TokenType.CLOSE,
    );
    reader.skipWhitespace();
    const close = reader.expect(TokenType.CLOSE);
    return decorator(reader.table, open.start, close.end, path, params, hash, {
        open: !!open.strip,
        close: !!close.strip,
    });
}

/**
 * Parses a `{{#* name}} body {{/name}}` decorator block into a `DecoratorBlock` node. Its program
 * carries `blockParams` (undefined in practice) and its `inverse` is `undefined`.
 *
 * @param {object} reader - The shared cursor, positioned on the opener `OPEN`.
 * @returns {object} A `DecoratorBlock` node.
 */
function parseDecoratorBlock(reader) {
    const open = reader.expect(TokenType.OPEN);
    reader.expect(TokenType.SIGIL); // `#*`
    const path = parsePath(reader);
    const { params, hash } = parseParametersAndHash(reader, headTerminator(reader));
    const blockParameters = parseBlockParameters(reader);
    reader.skipWhitespace();
    const openClose = reader.expect(TokenType.CLOSE);
    const bodyStart = openClose.end;

    const body = parseProgram(reader, () => isCloseTag(reader));
    if (reader.atEnd()) {
        throwUnclosed(reader);
    }
    const bodyEnd = reader.peek().start;
    const programNode = makeSubProgram(reader, body, bodyStart, bodyEnd, {
        hasBlockParams: true,
        blockParams: blockParameters,
    });
    const { closeToken } = consumeCloseTag(reader, path.original, path);
    return decoratorBlock(reader.table, open.start, closeToken.end, {
        path,
        params,
        hash,
        programNode,
        inverse: undefined,
        openStrip: { open: !!open.strip, close: !!openClose.strip },
        closeStrip: { open: false, close: false },
    });
}

/**
 * Builds a {@link HandlebarsParseError} (Jison class) whose `hash.loc` spans `[startOffset,
 * endOffset)` — 1-based line, 0-based column, matching upstream's Jison `SourceLocation`.
 *
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {number} startOffset - Absolute start offset of the error span.
 * @param {number} endOffset - Absolute end offset of the error span.
 * @returns {HandlebarsParseError} The Jison-class parse error.
 */
function jisonAt(table, startOffset, endOffset) {
    const start = offsetToPosition(table, startOffset);
    const end = offsetToPosition(table, endOffset);
    return new HandlebarsParseError('Parse error', {
        first_line: start.line,
        first_column: start.column,
        last_line: end.line,
        last_column: end.column,
    });
}

/**
 * Converts a {@link TokenizerError} into the plan's error class for the corresponding lexical
 * case. An unterminated `{{!-- --}}` comment is the exception-class "Unrecognized text" error
 * (NO position — the wrapper reports `1:1`). An unterminated string is the Jison class; upstream
 * anchors it at the preceding call-head token, so the span of the token just before the opening
 * quote is used.
 *
 * @param {TokenizerError} error - The lexical error thrown by the tokenizer.
 * @param {string} source - The original source (for locating the preceding token).
 * @returns {HandlebarsParseError|HandlebarsException|TokenizerError} The converted error.
 */
function convertTokenizerError(error, source) {
    if (!(error instanceof TokenizerError)) {
        return error;
    }
    if (error.kind === 'unterminated-comment') {
        // Exception-class lexical error; upstream exposes no position (wrapper falls back to 1:1).
        return new HandlebarsException('Lexical error. Unrecognized text.');
    }
    if (error.kind === 'unterminated-string') {
        // Jison class. Upstream anchors at the preceding call-head token (the id before the
        // opening quote). Locate the maximal id run ending just before the quote at `error.offset`.
        const { start, end } = precedingIdSpan(source, error.offset);
        return jisonAt(buildLineTable(source), start, end);
    }
    // Other lexical kinds (unterminated raw block / segment) belong to W2b-2's block surface;
    // surface them as a Jison error at the reported offset for now.
    return jisonAt(buildLineTable(source), error.offset, error.offset);
}

/**
 * Finds the span `[start, end)` of the bare-word token immediately preceding the code unit at
 * `offset` (skipping a single space between them), for anchoring an unterminated-string error at
 * the call-head token as upstream does.
 *
 * @param {string} source - The source string.
 * @param {number} offset - Offset of the opening quote of the unterminated string.
 * @returns {{start: number, end: number}} The preceding token's span (or a zero-width span at
 * `offset` when none is found).
 */
function precedingIdSpan(source, offset) {
    let end = offset;
    // Skip a run of insignificant whitespace before the quote.
    while (end > 0 && /\s/.test(source[end - 1])) {
        end--;
    }
    let start = end;
    while (start > 0 && /[^\s{}"'()[\]=~|@./]/.test(source[start - 1])) {
        start--;
    }
    if (start === end) {
        return { start: offset, end: offset };
    }
    return { start, end };
}
