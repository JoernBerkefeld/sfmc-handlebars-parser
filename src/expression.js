/**
 * Expression / path / literal / hash / subexpression sub-parsers for sfmc-handlebars-parser.
 *
 * These operate over the flat token stream from {@link import('./tokenizer.js').tokenize} and
 * build the INSIDE of a mustache: the call path, positional params, trailing `k=v` hash pairs,
 * and nested subexpressions. The statement/block/mustache layer (W2b) drives them through the
 * shared {@link createReader} cursor, so both layers agree on token navigation.
 *
 * Clean-room note: written from the observed public AST behaviour of `@handlebars/parser`
 * (MIT) and the Handlebars language spec; no upstream source was copied.
 *
 * ── What W2b consumes ────────────────────────────────────────────────────────────────────
 *   - {@link createReader}(tokens, table, source) -> a cursor `{ index, tokens, table, source,
 *     peek, peekType, next, atEnd, skipWhitespace, expect, sliceOriginal }`.
 *   - {@link parsePath}(reader) -> a `PathExpression` (consumes one path).
 *   - {@link parseLiteral}(reader) -> a literal node, or `undefined` if the cursor is not on a
 *     literal.
 *   - {@link parseExpressionParameter}(reader) -> ONE positional param (subexpression | literal |
 *     path), or `undefined` if the cursor is not on a param start.
 *   - {@link parseSubExpression}(reader) -> a `SubExpression` (cursor must be on `(`).
 *   - {@link parseParametersAndHash}(reader, isTerminator) -> `{ params, hash }` where `hash` is
 *     `undefined` (a present key, not a node) when there are no `k=v` pairs.
 *
 * The reader skips insignificant {@link import('./tokenizer.js').TokenType.WHITESPACE} tokens
 * on demand (callers invoke `skipWhitespace()` before reading an atom); it never mutates tokens.
 */

import { TokenType } from './tokenizer.js';
import { HandlebarsException } from './errors.js';
import { offsetToPosition } from './loc.js';
import {
    booleanLiteral,
    hash as hashNodeFactory,
    hashPair,
    nullLiteral,
    numberLiteral,
    pathExpression,
    stringLiteral,
    subExpression,
    undefinedLiteral,
} from './nodes.js';

/**
 * Bare-word keywords that classify an `ID` token as a literal rather than a path segment.
 */
const KEYWORD_LITERALS = new Set(['true', 'false', 'null', 'undefined']);

/**
 * Token types that form a path segment (and, when contiguous, join into one segment string).
 */
const SEGMENT_TOKEN_TYPES = new Set([TokenType.ID, TokenType.NUMBER, TokenType.SEGMENT]);

/**
 * Creates a cursor over a token array shared by the expression sub-parsers and W2b's statement
 * layer. The cursor is a plain object with an integer `index` that the methods advance; both
 * layers mutate the SAME object so navigation stays consistent.
 *
 * @param {object[]} tokens - The token stream from {@link import('./tokenizer.js').tokenize}.
 * @param {import('./loc.js').LineTable} table - Line table for the source.
 * @param {string} source - The original source string (for `sliceOriginal`).
 * @returns {object} The reader cursor (see the module header for its shape).
 */
export function createReader(tokens, table, source) {
    const reader = {
        tokens,
        table,
        source,
        index: 0,

        /**
         * Returns the token at `offset` from the current index without advancing (default 0).
         *
         * @param {number} [offset] - Look-ahead distance from the current index.
         * @returns {object|undefined} The token, or `undefined` past the end.
         */
        peek(offset = 0) {
            return tokens[reader.index + offset];
        },

        /**
         * Returns the `type` of the token at `offset` from the current index (default 0).
         *
         * @param {number} [offset] - Look-ahead distance from the current index.
         * @returns {string|undefined} The token type, or `undefined` past the end.
         */
        peekType(offset = 0) {
            const token = tokens[reader.index + offset];
            return token && token.type;
        },

        /**
         * Returns the current token and advances the cursor by one.
         *
         * @returns {object|undefined} The consumed token, or `undefined` past the end.
         */
        next() {
            return tokens[reader.index++];
        },

        /**
         * Whether the cursor is at (or past) the terminal `EOF` token.
         *
         * @returns {boolean} True when no more real tokens remain.
         */
        atEnd() {
            const token = tokens[reader.index];
            return !token || token.type === TokenType.EOF;
        },

        /**
         * Advances past any run of insignificant `WHITESPACE` tokens.
         *
         * @returns {void}
         */
        skipWhitespace() {
            let token = tokens[reader.index];
            while (token && token.type === TokenType.WHITESPACE) {
                reader.index++;
                token = tokens[reader.index];
            }
        },

        /**
         * Consumes the current token, asserting its `type`. Throws a plain `Error` (W2b owns
         * user-facing error classes) when the type does not match.
         *
         * @param {string} type - The expected {@link import('./tokenizer.js').TokenType}.
         * @returns {object} The consumed token.
         */
        expect(type) {
            const token = tokens[reader.index];
            if (!token || token.type !== type) {
                throw new Error(
                    `expected ${type} but found ${token ? token.type : 'end of input'}`,
                );
            }
            reader.index++;
            return token;
        },

        /**
         * Returns `source.slice(startOffset, endOffset)` (raw text of a span).
         *
         * @param {number} startOffset - Start offset.
         * @param {number} endOffset - End offset.
         * @returns {string} The raw source slice.
         */
        sliceOriginal(startOffset, endOffset) {
            return source.slice(startOffset, endOffset);
        },
    };
    return reader;
}

/**
 * Whether `token` can begin (or continue) a path: an `ID`, `SEGMENT`, `DATA` (`@`) prefix, a
 * path separator `SEP`, or a bare `NUMBER` segment.
 *
 * @param {object|undefined} token - A token, or `undefined`.
 * @returns {boolean} True when `token` starts/continues a path.
 */
function isPathToken(token) {
    if (!token) {
        return false;
    }
    return (
        SEGMENT_TOKEN_TYPES.has(token.type) ||
        token.type === TokenType.DATA ||
        token.type === TokenType.SEP
    );
}

/**
 * Reads one path segment: a maximal run of ADJACENT `ID`/`NUMBER`/`SEGMENT` tokens (each token's
 * `start` equal to the previous token's `end`, i.e. no whitespace or separator between them). The
 * tokenizer emits sub-tokens for lexemes like `0x1` (`NUMBER(0)` + `ID(x1)`); upstream rejoins
 * such a contiguous run into a single segment string. The cursor must be on the run's first token.
 *
 * @param {object} reader - The shared cursor from {@link createReader}.
 * @returns {{value: string, endOffset: number}} The joined segment text and its end offset.
 */
function readContiguousSegment(reader) {
    let value = '';
    let endOffset = reader.peek().start;
    while (!reader.atEnd()) {
        const token = reader.peek();
        if (!SEGMENT_TOKEN_TYPES.has(token.type) || token.start !== endOffset) {
            break;
        }
        value += token.value;
        endOffset = token.end;
        reader.next();
    }
    return { value, endOffset };
}

/**
 * Parses a single `PathExpression` starting at the cursor (leading whitespace is skipped first).
 *
 * Grammar handled: an optional `@` data prefix; leading `../` parent hops (each `..` increments
 * `depth`); a bare `..` parent-context path; a bare `.` current-context path; a `this` context
 * head; `.`- and legacy `/`-separated segments; bare-word `ID` segments (including `$`/`_`/`-`
 * ids); and `[segment literal]` parts whose inner text is kept verbatim. Adjacent extra `.`/`..`
 * tokens that do not continue this path (e.g. the trailing `.` of `{{...}}`) are left unconsumed
 * so the caller can parse them as the next expression. `original` is the raw path text with
 * segment-literal brackets removed and every separator kept. See {@link pathExpression} for how
 * `head`/`tail`/`this` are derived.
 *
 * @param {object} reader - The shared cursor from {@link createReader}.
 * @returns {object} A `PathExpression` node.
 */
export function parsePath(reader) {
    reader.skipWhitespace();
    const startToken = reader.peek();
    const startOffset = startToken.start;

    let isData = false;
    let depth = 0;
    let endOffset = startOffset;
    /**
     * @type {string[]}
     */
    const parts = [];
    let isSawThisHead = false;
    let segmentCount = 0;
    let isStarted = false;
    let isLastWasSlash = false;

    // Optional `@` data prefix.
    if (reader.peekType() === TokenType.DATA) {
        isData = true;
        endOffset = reader.next().end;
        isStarted = true;
    }

    // Walk segments and separators until the path can no longer continue.
    while (!reader.atEnd()) {
        const token = reader.peek();
        if (token.type === TokenType.SEP) {
            if (token.value === '..') {
                // A parent hop (`..`) is only valid at the START of a path (leading `../`).
                // Once a real segment has been collected, upstream rejects a later `..` with an
                // exception-class `Invalid path` error anchored at the path's start column. The
                // reported `original` is the raw path text up to and including this `..`.
                if (parts.length > 0) {
                    const bad = reader.source
                        .slice(startOffset, token.end)
                        .replaceAll(/[[\]]/g, '');
                    const at = offsetToPosition(reader.table, startOffset);
                    throw new HandlebarsException(
                        `Invalid path: ${bad} - ${at.line}:${at.column}`,
                        {
                            lineNumber: at.line,
                            column: at.column,
                        },
                    );
                }
                // A second adjacent `..` that is not a `../` hop (e.g. `{{....}}`) is a new
                // path, not more depth on this one. Leave it for the next expression.
                if (isStarted && !isLastWasSlash) {
                    break;
                }
                depth++;
                isLastWasSlash = false;
                isStarted = true;
                endOffset = token.end;
                reader.next();
                continue;
            }
            if (token.value === '.') {
                const next = reader.peek(1);
                const continues =
                    isLastWasSlash ||
                    (next && next.type === TokenType.SEP && next.value === '/') ||
                    (next && SEGMENT_TOKEN_TYPES.has(next.type) && isStarted);
                if (!continues) {
                    // Standalone `.` is current-context (`{{.}}`). A trailing `.` after an
                    // already-started path (`{{...}}`, `{{foo.}}`) is a new path — leave it.
                    if (!isStarted) {
                        endOffset = token.end;
                        reader.next();
                    }
                    break;
                }
                isLastWasSlash = false;
                isStarted = true;
                endOffset = token.end;
                reader.next();
                continue;
            }
            // `/` separator (`./`, `../`, `foo/bar`).
            isLastWasSlash = true;
            isStarted = true;
            endOffset = token.end;
            reader.next();
            continue;
        }
        if (SEGMENT_TOKEN_TYPES.has(token.type)) {
            // One segment = a maximal run of adjacent ID/NUMBER/SEGMENT tokens (no gap between
            // them). The tokenizer splits e.g. `0x1` into NUMBER(0)+ID(x1); upstream treats the
            // contiguous run as one path segment (`parts: ["0x1"]`).
            const segment = readContiguousSegment(reader);
            endOffset = segment.endOffset;
            isLastWasSlash = false;
            isStarted = true;
            if (segmentCount === 0 && token.type === TokenType.ID && segment.value === 'this') {
                // A `this` head is not a part; it only sets the `this` flag (when a tail follows).
                isSawThisHead = true;
            } else {
                parts.push(segment.value);
            }
            segmentCount++;
            // Continue only if the next token is a separator (a contiguous path).
            if (reader.peekType() !== TokenType.SEP) {
                break;
            }
            continue;
        }
        break;
    }

    const original = reader.source.slice(startOffset, endOffset).replaceAll(/[[\]]/g, '');
    return pathExpression(reader.table, startOffset, endOffset, {
        data: isData,
        depth,
        parts,
        original,
        this: isSawThisHead && parts.length > 0,
    });
}

/**
 * Parses a literal at the cursor (leading whitespace is skipped first), or returns `undefined`
 * when the cursor is not on a literal. String/number literals come from dedicated tokens;
 * boolean/`null`/`undefined` literals arrive as bare `ID` tokens and are classified by value
 * (only when they stand alone — an `ID` keyword immediately followed by a `SEP` is a path
 * segment, e.g. `true.x`, and is left for {@link parsePath}).
 *
 * @param {object} reader - The shared cursor from {@link createReader}.
 * @returns {object|undefined} A literal node, or `undefined` if the cursor is not on a literal.
 */
export function parseLiteral(reader) {
    reader.skipWhitespace();
    const token = reader.peek();
    if (!token) {
        return;
    }
    if (token.type === TokenType.STRING) {
        reader.next();
        return stringLiteral(reader.table, token.start, token.end, token.value);
    }
    if (token.type === TokenType.NUMBER) {
        // A NUMBER immediately followed (no gap) by an ID/NUMBER/SEGMENT is really a path
        // segment (e.g. `0x1` -> NUMBER(0)+ID(x1)); leave it for parsePath.
        const next = reader.peek(1);
        if (next && next.start === token.end && SEGMENT_TOKEN_TYPES.has(next.type)) {
            return;
        }
        reader.next();
        return numberLiteral(reader.table, token.start, token.end, Number(token.value));
    }
    if (token.type === TokenType.ID && KEYWORD_LITERALS.has(token.value)) {
        // Only a standalone keyword is a literal; `true.x` etc. is a path.
        if (reader.peekType(1) === TokenType.SEP) {
            return;
        }
        reader.next();
        switch (token.value) {
            case 'true': {
                return booleanLiteral(reader.table, token.start, token.end, true);
            }
            case 'false': {
                return booleanLiteral(reader.table, token.start, token.end, false);
            }
            case 'null': {
                return nullLiteral(reader.table, token.start, token.end);
            }
            default: {
                return undefinedLiteral(reader.table, token.start, token.end);
            }
        }
    }
    return;
}

/**
 * Parses ONE positional parameter at the cursor (leading whitespace skipped first): a
 * subexpression `( … )`, a literal, or a path — in that precedence. Returns `undefined` when the
 * cursor is not on a parameter start (e.g. a terminator or a hash pair).
 *
 * @param {object} reader - The shared cursor from {@link createReader}.
 * @returns {object|undefined} A param node, or `undefined` when none starts here.
 */
export function parseExpressionParameter(reader) {
    reader.skipWhitespace();
    const token = reader.peek();
    if (!token) {
        return;
    }
    if (token.type === TokenType.OPEN_PAREN) {
        return parseSubExpression(reader);
    }
    const literal = parseLiteral(reader);
    if (literal) {
        return literal;
    }
    if (isPathToken(token)) {
        return parsePath(reader);
    }
    return;
}

/**
 * Parses a `SubExpression` — `( path params hash )` — with the cursor on the opening `(`.
 * Recurses through {@link parseParametersAndHash} for nested params/subexpressions. The `loc` spans
 * the parens inclusive.
 *
 * @param {object} reader - The shared cursor from {@link createReader}.
 * @returns {object} A `SubExpression` node.
 */
export function parseSubExpression(reader) {
    const open = reader.expect(TokenType.OPEN_PAREN);
    reader.skipWhitespace();
    const path = parsePath(reader);
    const { params, hash } = parseParametersAndHash(
        reader,
        (token) => token.type === TokenType.CLOSE_PAREN,
    );
    reader.skipWhitespace();
    const close = reader.expect(TokenType.CLOSE_PAREN);
    return subExpression(reader.table, open.start, close.end, path, params, hash);
}

/**
 * Parses the positional-params-then-hash-pairs tail of a call (mustache body, block open,
 * subexpression, partial, decorator). Consumes positional params until a `k=v` hash pair begins
 * (an `ID` immediately followed by `EQUALS`) or `isTerminator` matches the next non-whitespace
 * token, then consumes the trailing hash pairs.
 *
 * @param {object} reader - The shared cursor from {@link createReader}.
 * @param {(token: object) => boolean} isTerminator - Predicate matching the token that ends the
 * param/hash sequence (e.g. `CLOSE`, `CLOSE_PAREN`, `PIPE`). WHITESPACE is skipped before the
 * check, so the predicate sees the next significant token.
 * @returns {{params: object[], hash: (object|undefined)}} The positional params and the `Hash`
 * node (or `undefined` when there is no `k=v` pair — a present key, per the AST contract).
 */
export function parseParametersAndHash(reader, isTerminator) {
    /**
     * @type {object[]}
     */
    const parameters = [];
    /**
     * @type {object[]}
     */
    const pairs = [];

    // Positional params: stop at a terminator or the first hash pair.
    while (true) {
        reader.skipWhitespace();
        const token = reader.peek();
        if (!token || token.type === TokenType.EOF || isTerminator(token)) {
            break;
        }
        if (isHashPairStart(reader)) {
            break;
        }
        const parameter = parseExpressionParameter(reader);
        if (!parameter) {
            break;
        }
        parameters.push(parameter);
    }

    // Trailing hash pairs: `key = value` sequences.
    let firstPairStart;
    let lastPairEnd;
    while (true) {
        reader.skipWhitespace();
        const token = reader.peek();
        if (!token || token.type === TokenType.EOF || isTerminator(token)) {
            break;
        }
        if (!isHashPairStart(reader)) {
            break;
        }
        const { pair, startOffset, endOffset } = parseHashPair(reader);
        if (firstPairStart === undefined) {
            firstPairStart = startOffset;
        }
        lastPairEnd = endOffset;
        pairs.push(pair);
    }

    let hash;
    if (pairs.length > 0) {
        hash = hashNodeFactory(reader.table, firstPairStart, lastPairEnd, pairs);
    }
    return { params: parameters, hash };
}

/**
 * Whether a `k=v` hash pair begins at the cursor: an `ID` token immediately followed (no
 * whitespace) by an `EQUALS` token.
 *
 * @param {object} reader - The shared cursor from {@link createReader}.
 * @returns {boolean} True when the next significant tokens are `ID EQUALS`.
 */
function isHashPairStart(reader) {
    reader.skipWhitespace();
    return reader.peekType() === TokenType.ID && reader.peekType(1) === TokenType.EQUALS;
}

/**
 * Parses one `HashPair` — `key = value` — with the cursor on the key `ID`. The value is a
 * subexpression, literal, or path. Returns the `HashPair` node plus its raw start/end offsets so
 * the caller can span the enclosing `Hash` node's `loc`.
 *
 * @param {object} reader - The shared cursor from {@link createReader}.
 * @returns {{pair: object, startOffset: number, endOffset: number}} The pair and its span.
 */
function parseHashPair(reader) {
    const keyToken = reader.expect(TokenType.ID);
    reader.expect(TokenType.EQUALS);
    const value = parseExpressionParameter(reader);
    // The value's last code unit is the end of the last token the value parser consumed.
    const lastValueToken = reader.peek(-1);
    const endOffset = lastValueToken ? lastValueToken.end : keyToken.end;
    const pair = hashPair(reader.table, keyToken.start, endOffset, keyToken.value, value);
    return { pair, startOffset: keyToken.start, endOffset };
}
