/**
 * Handlebars tokenizer for sfmc-handlebars-parser.
 *
 * Scans raw template text (a Handlebars template or an HTML document containing `{{…}}`)
 * into a flat token stream that the parser (W2a/W2b) consumes. This module performs
 * LEXING ONLY — it recognises lexical constructs and records their absolute source offsets;
 * it does NOT build AST nodes or decide node fields. Whitespace-control (`~`) and escaped
 * (`\{{`) markers are recorded as flags on the relevant tokens; the parser interprets them.
 *
 * Clean-room note: written from the observed public behaviour of `@handlebars/parser` and
 * the Handlebars language spec; no upstream source was copied.
 *
 * ── Token contract (what the parser consumes) ────────────────────────────────────────────
 * Every token is `{ type, start, end, ...payload }` where:
 *   - `type`   {@link TokenType} — the lexical class.
 *   - `start`  number — absolute offset (UTF-16 code unit) of the first code unit of the token.
 *   - `end`    number — absolute offset just past the last code unit (so `source.slice(start,end)`
 *              is the token's raw text). Use `loc.js` `locFromOffsets(table, start, end)` to get a
 *              `SourceLocation`.
 *
 * Payload fields by type:
 *   - CONTENT        `{ value, escaped }` — `value` is the literal text to render. For a normal
 *                    content run `value === source.slice(start,end)`. For an ESCAPED mustache
 *                    (`\{{…}}`), `escaped` is `true`, `start`/`end` span the text AFTER the
 *                    consumed backslash (i.e. the literal `{{…}}` text), and `value` equals that
 *                    literal text. `escaped` is `false`/absent for ordinary content.
 *   - OPEN           `{ open, strip }` — a mustache open delimiter. `open` is one of
 *                    `'{{'`, `'{{{'`, `'{{{{'`. `strip` is `true` when a `~` immediately followed
 *                    the open (`{{~`). The sigil (`#`, `/`, `^`, `>`, `#>`, `*`, `#*`, `&`) is a
 *                    SEPARATE {@link TokenType.SIGIL} token that follows, so the parser reads it.
 *   - CLOSE          `{ close, strip }` — a mustache close delimiter. `close` is one of
 *                    `'}}'`, `'}}}'`, `'}}}}'`. `strip` is `true` when a `~` immediately preceded
 *                    the close (`~}}`).
 *   - SIGIL          `{ value }` — a leading sigil right after an OPEN: one of
 *                    `'#'`, `'/'`, `'^'`, `'>'`, `'#>'`, `'*'`, `'#*'`, `'&'`. (Comment sigils
 *                    `!` / `!--` are NOT emitted as SIGIL — they are lexed as COMMENT, below.)
 *   - COMMENT        `{ value, long, open, close, strip }` — a whole `{{! … }}` or
 *                    `{{!-- … --}}` comment. `value` is the raw inner text (between the sigil and
 *                    the terminator). `long` is `true` for the `{{!-- --}}` form. `open`/`close`
 *                    carry the delimiter text and `strip` the open-side `~` flag; the closing
 *                    `~}}` strip (if any) is captured in `closeStrip`. The token spans the ENTIRE
 *                    comment (`{{` … `}}`), so no OPEN/CLOSE tokens are emitted around it.
 *   - ID             `{ value }` — an identifier / path segment (bare word: letters, digits,
 *                    `_`, `$`, `-`, etc.). Booleans / `null` / `undefined` are lexed as ID; the
 *                    parser classifies them.
 *   - SEGMENT        `{ value }` — a segment-literal `[ … ]`. `value` is the INNER text with the
 *                    brackets removed (may contain spaces and dots, kept verbatim).
 *   - SEP            `{ value }` — a path separator: `'.'`, `'/'`, or `'..'` (parent).
 *   - DATA           `{}` — the `@` data prefix.
 *   - EQUALS         `{}` — `=` (hash assignment).
 *   - STRING         `{ value, quote }` — a string literal. `value` is the DECODED string (escape
 *                    sequences resolved); `quote` is `'"'` or `"'"`. `start`/`end` span the quotes.
 *   - NUMBER         `{ value }` — a numeric literal; `value` is the raw lexeme text.
 *   - OPEN_PAREN     `{}` — `(` (subexpression start).
 *   - CLOSE_PAREN    `{}` — `)` (subexpression end).
 *   - PIPE           `{}` — `|` (block-params fence, `as |a b|`).
 *   - WHITESPACE     `{}` — a run of insignificant whitespace INSIDE an expression. Emitted so the
 *                    parser can rely on offsets; the parser may ignore it.
 *   - RAW_OPEN       `{ name }` — the `{{{{name}}}}` raw-block open. `name` is the block name.
 *   - RAW_CONTENT    `{ value }` — the verbatim raw-block body (inner `{{` NOT parsed). `value ===
 *                    source.slice(start,end)`.
 *   - RAW_CLOSE      `{ name }` — the `{{{{/name}}}}` raw-block close. `name` is the block name.
 *   - EOF            `{}` — the final token (`start === end === source.length`).
 *
 * ── Lexical-error signalling (for W2b) ───────────────────────────────────────────────────
 * On a lexical error the tokenizer can detect itself (unterminated string, unterminated
 * `{{!-- --}}`, unterminated raw block, unterminated segment literal), it THROWS a
 * {@link TokenizerError}: an `Error` with a numeric `.offset` property giving the ABSOLUTE
 * offset (UTF-16 code unit) at which the error was detected (typically the offset of the
 * unterminated construct's opening, matching where upstream reports the lexical class-(b)
 * "Unrecognized text" error). The message text is intentionally generic — W2b owns the final
 * user-facing message and error class; it should read `.offset` (and, if present, `.kind`) to
 * produce the plan's class-(b) lexical error at the right position.
 */

import { buildLineTable } from './loc.js';

/**
 * Lexical token classes emitted by {@link tokenize}. See the module header for each type's
 * payload fields.
 *
 * @readonly
 * @enum {string}
 */
export const TokenType = {
    CONTENT: 'CONTENT',
    OPEN: 'OPEN',
    CLOSE: 'CLOSE',
    SIGIL: 'SIGIL',
    COMMENT: 'COMMENT',
    ID: 'ID',
    SEGMENT: 'SEGMENT',
    SEP: 'SEP',
    DATA: 'DATA',
    EQUALS: 'EQUALS',
    STRING: 'STRING',
    NUMBER: 'NUMBER',
    OPEN_PAREN: 'OPEN_PAREN',
    CLOSE_PAREN: 'CLOSE_PAREN',
    PIPE: 'PIPE',
    WHITESPACE: 'WHITESPACE',
    RAW_OPEN: 'RAW_OPEN',
    RAW_CONTENT: 'RAW_CONTENT',
    RAW_CLOSE: 'RAW_CLOSE',
    EOF: 'EOF',
};

/**
 * Error thrown for a lexical error the tokenizer detects. Carries the absolute source
 * `offset` so W2b can produce the plan's class-(b) "Unrecognized text" error at the right
 * position, and a `kind` discriminator for diagnostics.
 */
export class TokenizerError extends Error {
    /**
     * @param {string} message - Generic message (W2b owns the final wording).
     * @param {number} offset - Absolute offset (UTF-16 code unit) where the error was detected.
     * @param {string} kind - Short discriminator, e.g. `'unterminated-string'`,
     * `'unterminated-comment'`, `'unterminated-raw-block'`, `'unterminated-segment'`.
     */
    constructor(message, offset, kind) {
        super(message);
        this.name = 'TokenizerError';
        /**
        @type {number} Absolute offset where the lexical error was detected.
         */
        this.offset = offset;
        /**
        @type {string} Short discriminator for the lexical-error kind.
         */
        this.kind = kind;
    }
}

/**
 * Whether `code` is an insignificant whitespace code unit (space/tab/CR/LF/FF/VT).
 *
 * @param {number} code - A UTF-16 code unit.
 * @returns {boolean} True for a whitespace code unit.
 */
const WHITESPACE_CODES = new Set([32, 9, 10, 13, 12, 11]);
function isWhitespace(code) {
    return WHITESPACE_CODES.has(code);
}

/**
 * Whether `code` may start or continue a bare identifier segment. Handlebars ids are liberal:
 * anything that is not whitespace and not one of the structural expression characters
 * (`.` `/` `=` `~` `|` `(` `)` `[` `]` `{` `}` `"` `'` `@` `!` `#` `>` `^` `*` `&`) is treated
 * as id text. This keeps `$`, `_`, `-`, digits and unicode letters inside ids.
 *
 * @param {number} code - A UTF-16 code unit.
 * @returns {boolean} True when `code` is legal inside an id lexeme.
 */
function isIdChar(code) {
    if (isWhitespace(code)) {
        return false;
    }
    switch (code) {
        case 46: // .
        case 47: // /
        case 61: // =
        case 126: // ~
        case 124: // |
        case 40: // (
        case 41: // )
        case 91: // [
        case 93: // ]
        case 123: // {
        case 125: // }
        case 34: // "
        case 39: // '
        case 64: // @
        case 33: // !
        case 35: // #
        case 62: // >
        case 94: // ^
        case 42: // *
        case 38: {
            // &
            return false;
        }
        default: {
            return true;
        }
    }
}

/**
 * Tokenizes a Handlebars template into a flat array of tokens (see the module header for the
 * token contract). The stream always ends with a single {@link TokenType.EOF} token.
 *
 * @param {string} source - The Handlebars (or HTML-with-Handlebars) source to tokenize.
 * @returns {object[]} The token stream. Each token is `{ type, start, end, ...payload }`.
 * @throws {TokenizerError} On a lexical error the tokenizer detects (unterminated string /
 *   comment / raw block / segment literal). The error carries `.offset` and `.kind`.
 */
export function tokenize(source) {
    const length = source.length;
    /**
    @type {object[]}
     */
    const tokens = [];
    let pos = 0;

    // ── Content scanning ────────────────────────────────────────────────────────────────
    // Outside mustaches. Emit CONTENT runs, handle `\{{` escapes, and dispatch to the
    // right mustache lexer when an unescaped `{{` is reached.
    while (pos < length) {
        const next = source.indexOf('{{', pos);
        if (next === -1) {
            // Remaining text is all content.
            emitContent(pos, length, false);
            break;
        }
        // Determine whether the `{{` at `next` is escaped by an ODD run of backslashes.
        let backslashStart = next;
        while (backslashStart > pos && source.codePointAt(backslashStart - 1) === 92) {
            backslashStart--;
        }
        const backslashCount = next - backslashStart;
        if (backslashCount % 2 === 1) {
            // Odd backslashes → the `{{` is escaped. The last backslash is consumed; content
            // before it (including any preceding escaped-out backslash pairs) is emitted, then
            // the `{{…}}` run is emitted as literal (escaped) content.
            // Content up to the consumed backslash (exclusive of that backslash).
            if (backslashStart + backslashCount - 1 > pos) {
                emitContent(pos, backslashStart + backslashCount - 1, false);
            } else if (pos < backslashStart) {
                emitContent(pos, backslashStart, false);
            }
            // The literal mustache text: from `{{` to the matching `}}` (or end of source).
            const escStart = next;
            const closeIndex = source.indexOf('}}', next + 2);
            const escEnd = closeIndex === -1 ? length : closeIndex + 2;
            emitContent(escStart, escEnd, true);
            pos = escEnd;
            continue;
        }
        // Unescaped `{{`. Emit any content before it, then lex the mustache/comment/raw block.
        if (next > pos) {
            emitContent(pos, next, false);
        }
        pos = lexMustacheRegion(next);
    }

    tokens.push({ type: TokenType.EOF, start: length, end: length });
    return tokens;

    /**
     * Emits a CONTENT token for `source.slice(start,end)`. Skips empty runs.
     *
     * @param {number} start - Start offset.
     * @param {number} end - End offset.
     * @param {boolean} escaped - Whether this run is an escaped `\{{…}}` literal.
     */
    function emitContent(start, end, escaped) {
        if (end <= start) {
            return;
        }
        tokens.push({
            type: TokenType.CONTENT,
            start,
            end,
            value: source.slice(start, end),
            escaped,
        });
    }

    /**
     * Lexes a mustache region starting at an unescaped `{{` at `at`. Dispatches to raw-block,
     * comment, or ordinary-mustache lexing. Returns the offset just past the region consumed
     * (for comments and raw blocks that is the whole construct; for ordinary mustaches it is
     * the offset just past the closing delimiter).
     *
     * @param {number} at - Offset of the opening `{`.
     * @returns {number} Offset to resume content scanning from.
     */
    function lexMustacheRegion(at) {
        // Raw block open `{{{{name}}}}` (four braces).
        if (source.startsWith('{{{{', at) && !source.startsWith('{{{{/', at)) {
            return lexRawBlock(at);
        }
        // Comment `{{! … }}` / `{{!-- … --}}`. A `~` may sit between `{{` and `!`.
        const afterOpen = at + (source.codePointAt(at + 2) === 126 ? 3 : 2); // skip `~`
        if (source.codePointAt(afterOpen) === 33) {
            // `!`
            return lexComment(at);
        }
        return lexMustache(at);
    }

    /**
     * Lexes a `{{{{name}}}}` raw block: the open, the verbatim body, and the matching
     * `{{{{/name}}}}` close. Inner `{{` in the body are not parsed.
     *
     * @param {number} at - Offset of the opening `{`.
     * @returns {number} Offset just past the `}}}}` of the close.
     * @throws {TokenizerError} When no matching `{{{{/name}}}}` close is found.
     */
    function lexRawBlock(at) {
        const openEnd = source.indexOf('}}}}', at + 4);
        if (openEnd === -1) {
            throw new TokenizerError('unterminated raw block', at, 'unterminated-raw-block');
        }
        const name = source.slice(at + 4, openEnd).trim();
        tokens.push({ type: TokenType.RAW_OPEN, start: at, end: openEnd + 4, name });
        const bodyStart = openEnd + 4;
        const closeMarker = `{{{{/${name}}}}}`;
        const closeStart = source.indexOf(closeMarker, bodyStart);
        if (closeStart === -1) {
            throw new TokenizerError('unterminated raw block', at, 'unterminated-raw-block');
        }
        if (closeStart > bodyStart) {
            tokens.push({
                type: TokenType.RAW_CONTENT,
                start: bodyStart,
                end: closeStart,
                value: source.slice(bodyStart, closeStart),
            });
        }
        const closeEnd = closeStart + closeMarker.length;
        tokens.push({ type: TokenType.RAW_CLOSE, start: closeStart, end: closeEnd, name });
        return closeEnd;
    }

    /**
     * Lexes a comment `{{! … }}` or `{{!-- … --}}` as a single COMMENT token. The short form
     * ends at the first `}}`; the long form ends at `--}}` and may contain `}}`.
     *
     * @param {number} at - Offset of the opening `{`.
     * @returns {number} Offset just past the closing delimiter.
     * @throws {TokenizerError} When a long `{{!-- --}}` comment is unterminated.
     */
    function lexComment(at) {
        const isOpenStrip = source.codePointAt(at + 2) === 126; // `{{~`
        const sigilStart = at + (isOpenStrip ? 3 : 2); // position of `!`
        const long = source.startsWith('!--', sigilStart);
        const openText = source.slice(at, sigilStart + (long ? 3 : 1));
        if (long) {
            const bodyStart = sigilStart + 3;
            const term = source.indexOf('--', bodyStart);
            if (term === -1) {
                throw new TokenizerError('unterminated comment', at, 'unterminated-comment');
            }
            // After `--` there may be a `~` then `}}`.
            let cursor = term + 2;
            const isCloseStrip = source.codePointAt(cursor) === 126;
            if (isCloseStrip) {
                cursor++;
            }
            if (!source.startsWith('}}', cursor)) {
                throw new TokenizerError('unterminated comment', at, 'unterminated-comment');
            }
            const closeEnd = cursor + 2;
            tokens.push({
                type: TokenType.COMMENT,
                start: at,
                end: closeEnd,
                value: source.slice(bodyStart, term),
                long: true,
                open: openText,
                close: source.slice(term, closeEnd),
                strip: isOpenStrip,
                closeStrip: isCloseStrip,
            });
            return closeEnd;
        }
        // Short comment: body up to the first `}}` (optionally preceded by `~`).
        const bodyStart = sigilStart + 1;
        const term = source.indexOf('}}', bodyStart);
        if (term === -1) {
            throw new TokenizerError('unterminated comment', at, 'unterminated-comment');
        }
        // A short comment cannot legally strip on close via `~}}` differently, but upstream
        // still recognises `~}}`; capture it if the char before `}}` is `~`.
        const isCloseStrip = term > bodyStart && source.codePointAt(term - 1) === 126;
        const valueEnd = isCloseStrip ? term - 1 : term;
        const closeEnd = term + 2;
        tokens.push({
            type: TokenType.COMMENT,
            start: at,
            end: closeEnd,
            value: source.slice(bodyStart, valueEnd),
            long: false,
            open: openText,
            close: source.slice(isCloseStrip ? term - 1 : term, closeEnd),
            strip: isOpenStrip,
            closeStrip: isCloseStrip,
        });
        return closeEnd;
    }

    /**
     * Lexes an ordinary mustache `{{ … }}` / `{{{ … }}}` (with optional `~` strip flags and a
     * leading sigil), emitting an OPEN token, the inside-expression tokens, and a CLOSE token.
     *
     * @param {number} at - Offset of the opening `{`.
     * @returns {number} Offset just past the closing delimiter (or the end of source when the
     * mustache is unterminated — the parser reports the missing close).
     */
    function lexMustache(at) {
        // Count opening braces (2 or 3; four was handled as a raw block).
        const braceCount = source.codePointAt(at + 2) === 123 ? 3 : 2;
        let cursor = at + braceCount;
        const isOpenStrip = source.codePointAt(cursor) === 126; // `~`
        if (isOpenStrip) {
            cursor++;
        }
        tokens.push({
            type: TokenType.OPEN,
            start: at,
            end: cursor,
            open: '{'.repeat(braceCount),
            strip: isOpenStrip,
        });
        // Optional leading sigil.
        cursor = lexSigil(cursor);
        // Inside-expression tokens up to the closing delimiter.
        cursor = lexExpression(cursor);
        return cursor;
    }

    /**
     * Emits a SIGIL token when a leading sigil (`#`, `/`, `^`, `>`, `#>`, `*`, `#*`, `&`) sits
     * at `cursor` (right after the open, possibly after leading whitespace is NOT skipped —
     * upstream requires the sigil to be adjacent). Returns the offset after the sigil, or
     * `cursor` unchanged when none is present.
     *
     * @param {number} cursor - Offset right after the open delimiter (and its `~`).
     * @returns {number} Offset after the sigil (or unchanged).
     */
    function lexSigil(cursor) {
        const c0 = source.codePointAt(cursor);
        // Two-char sigils first: `#>` and `#*`.
        if (c0 === 35) {
            // `#`
            const c1 = source.codePointAt(cursor + 1);
            if (c1 === 62) {
                // `#>`
                tokens.push({ type: TokenType.SIGIL, start: cursor, end: cursor + 2, value: '#>' });
                return cursor + 2;
            }
            if (c1 === 42) {
                // `#*`
                tokens.push({ type: TokenType.SIGIL, start: cursor, end: cursor + 2, value: '#*' });
                return cursor + 2;
            }
            tokens.push({ type: TokenType.SIGIL, start: cursor, end: cursor + 1, value: '#' });
            return cursor + 1;
        }
        switch (c0) {
            case 47: // /
            case 94: // ^
            case 62: // >
            case 42: // *
            case 38: {
                // &
                const value = source[cursor];
                tokens.push({ type: TokenType.SIGIL, start: cursor, end: cursor + 1, value });
                return cursor + 1;
            }
            default: {
                return cursor;
            }
        }
    }

    /**
     * Lexes the inside-expression token stream from `cursor` up to and including the closing
     * mustache delimiter (`}}` / `}}}`, with an optional `~` strip). Emits ID / SEGMENT / SEP /
     * DATA / EQUALS / STRING / NUMBER / paren / PIPE / WHITESPACE tokens, then a CLOSE token.
     *
     * @param {number} cursor - Offset to start lexing the expression body from.
     * @returns {number} Offset just past the closing delimiter (or end of source if unterminated).
     */
    function lexExpression(cursor) {
        while (cursor < length) {
            // Closing delimiter? A `~` may precede `}}` / `}}}`.
            const isCloseStrip = source.codePointAt(cursor) === 126;
            const closeAt = isCloseStrip ? cursor + 1 : cursor;
            if (source.startsWith('}}', closeAt)) {
                const isTriple = source.codePointAt(closeAt + 2) === 125; // `}}}`
                const braces = isTriple ? 3 : 2;
                const closeEnd = closeAt + braces;
                tokens.push({
                    type: TokenType.CLOSE,
                    start: cursor,
                    end: closeEnd,
                    close: '}'.repeat(braces),
                    strip: isCloseStrip,
                });
                return closeEnd;
            }
            const code = source.codePointAt(cursor);
            if (isWhitespace(code)) {
                const ws = scanWhile(cursor, isWhitespace);
                tokens.push({ type: TokenType.WHITESPACE, start: cursor, end: ws });
                cursor = ws;
                continue;
            }
            cursor = lexExpressionAtom(cursor, code);
        }
        // Reached end of source without a close delimiter: leave it to the parser.
        return cursor;
    }

    /**
     * Lexes a single inside-expression atom at `cursor`. Returns the offset after it.
     *
     * @param {number} cursor - Offset of the atom's first code unit.
     * @param {number} code - `source.codePointAt(cursor)` (already read by the caller).
     * @returns {number} Offset just past the atom.
     * @throws {TokenizerError} On an unterminated string or segment literal.
     */
    function lexExpressionAtom(cursor, code) {
        switch (code) {
            case 34: // "
            case 39: {
                // '
                return lexString(cursor, code);
            }
            case 91: {
                // [
                return lexSegment(cursor);
            }
            case 40: {
                // (
                tokens.push({ type: TokenType.OPEN_PAREN, start: cursor, end: cursor + 1 });
                return cursor + 1;
            }
            case 41: {
                // )
                tokens.push({ type: TokenType.CLOSE_PAREN, start: cursor, end: cursor + 1 });
                return cursor + 1;
            }
            case 124: {
                // |
                tokens.push({ type: TokenType.PIPE, start: cursor, end: cursor + 1 });
                return cursor + 1;
            }
            case 61: {
                // =
                tokens.push({ type: TokenType.EQUALS, start: cursor, end: cursor + 1 });
                return cursor + 1;
            }
            case 64: {
                // @
                tokens.push({ type: TokenType.DATA, start: cursor, end: cursor + 1 });
                return cursor + 1;
            }
            case 46: {
                // .  (either `.` or `..`)
                if (source.codePointAt(cursor + 1) === 46) {
                    tokens.push({
                        type: TokenType.SEP,
                        start: cursor,
                        end: cursor + 2,
                        value: '..',
                    });
                    return cursor + 2;
                }
                tokens.push({ type: TokenType.SEP, start: cursor, end: cursor + 1, value: '.' });
                return cursor + 1;
            }
            case 47: {
                // /
                tokens.push({ type: TokenType.SEP, start: cursor, end: cursor + 1, value: '/' });
                return cursor + 1;
            }
            default: {
                if (isNumberStart(cursor, code)) {
                    return lexNumber(cursor);
                }
                return lexId(cursor);
            }
        }
    }

    /**
     * Whether a number literal begins at `cursor`. A leading `-` counts only when followed by a
     * digit; a bare digit also starts a number. (Distinguishing `NumberLiteral` from a numeric
     * `PathExpression` such as `0x1` is the parser's job — the tokenizer lexes the run as
     * NUMBER when it is purely numeric, else as ID.)
     *
     * @param {number} cursor - Offset to test.
     * @param {number} code - `source.codePointAt(cursor)`.
     * @returns {boolean} True when a numeric literal starts here.
     */
    function isNumberStart(cursor, code) {
        if (code >= 48 && code <= 57) {
            return true;
        }
        if (code === 45) {
            // `-` followed by a digit
            const c1 = source.codePointAt(cursor + 1);
            return c1 >= 48 && c1 <= 57;
        }
        return false;
    }

    /**
     * Lexes a numeric literal (optional leading `-`, digits, optional single `.` fraction).
     * A trailing `.` with no fraction digit is treated as a path separator, not part of the
     * number.
     *
     * @param {number} cursor - Offset of the number's first code unit.
     * @returns {number} Offset just past the number.
     */
    function lexNumber(cursor) {
        let index = cursor;
        if (source.codePointAt(index) === 45) {
            index++;
        }
        while (index < length && isDigit(source.codePointAt(index))) {
            index++;
        }
        // Fractional part: `.` immediately followed by a digit.
        if (source.codePointAt(index) === 46 && isDigit(source.codePointAt(index + 1))) {
            index++;
            while (index < length && isDigit(source.codePointAt(index))) {
                index++;
            }
        }
        tokens.push({
            type: TokenType.NUMBER,
            start: cursor,
            end: index,
            value: source.slice(cursor, index),
        });
        return index;
    }

    /**
     * Lexes a bare identifier / path segment run of {@link isIdChar} code units.
     *
     * @param {number} cursor - Offset of the id's first code unit.
     * @returns {number} Offset just past the id.
     */
    function lexId(cursor) {
        const end = scanWhile(cursor, isIdChar);
        // A lone character that is not an id char would produce a zero-length id; consume one
        // code unit as an id to guarantee progress (the parser will reject stray characters).
        const effectiveEnd = end > cursor ? end : cursor + 1;
        tokens.push({
            type: TokenType.ID,
            start: cursor,
            end: effectiveEnd,
            value: source.slice(cursor, effectiveEnd),
        });
        return effectiveEnd;
    }

    /**
     * Lexes a segment literal `[ … ]`. The inner text (which may contain spaces and dots) is
     * captured verbatim with the brackets removed.
     *
     * @param {number} cursor - Offset of the opening `[`.
     * @returns {number} Offset just past the closing `]`.
     * @throws {TokenizerError} When the segment literal is unterminated.
     */
    function lexSegment(cursor) {
        const close = source.indexOf(']', cursor + 1);
        if (close === -1) {
            throw new TokenizerError(
                'unterminated segment literal',
                cursor,
                'unterminated-segment',
            );
        }
        tokens.push({
            type: TokenType.SEGMENT,
            start: cursor,
            end: close + 1,
            value: source.slice(cursor + 1, close),
        });
        return close + 1;
    }

    /**
     * Lexes a string literal delimited by `quote` (`"` or `'`), resolving backslash escapes in
     * the decoded `value`. `start`/`end` span the quotes.
     *
     * @param {number} cursor - Offset of the opening quote.
     * @param {number} quote - The quote code unit (34 for `"`, 39 for `'`).
     * @returns {number} Offset just past the closing quote.
     * @throws {TokenizerError} When the string is unterminated.
     */
    function lexString(cursor, quote) {
        let index = cursor + 1;
        let value = '';
        while (index < length) {
            const code = source.codePointAt(index);
            if (code === 92) {
                // backslash escape: keep the escaped char literally (\" -> ", \\ -> \, etc.)
                const escaped = source[index + 1];
                if (escaped === undefined) {
                    break;
                }
                value += escaped;
                index += 2;
                continue;
            }
            if (code === quote) {
                tokens.push({
                    type: TokenType.STRING,
                    start: cursor,
                    end: index + 1,
                    value,
                    quote: String.fromCodePoint(quote),
                });
                return index + 1;
            }
            value += source[index];
            index++;
        }
        throw new TokenizerError('unterminated string', cursor, 'unterminated-string');
    }

    /**
     * Scans forward from `start` while `predicate(code)` holds. Returns the first offset where
     * it fails (or `length`).
     *
     * @param {number} start - Offset to start scanning from.
     * @param {(code: number) => boolean} predicate - Per-code-unit test.
     * @returns {number} The first offset at which the predicate fails.
     */
    function scanWhile(start, predicate) {
        let index = start;
        while (index < length && predicate(source.codePointAt(index))) {
            index++;
        }
        return index;
    }
}

/**
 * Whether `code` is an ASCII digit `0`–`9`.
 *
 * @param {number} code - A UTF-16 code unit.
 * @returns {boolean} True for an ASCII digit.
 */
function isDigit(code) {
    return code >= 48 && code <= 57;
}

/**
 * Convenience wrapper: tokenizes `source` and returns both the token stream and a
 * {@link import('./loc.js').LineTable} so callers can convert token offsets to positions
 * without rebuilding the table.
 *
 * @param {string} source - The Handlebars source to tokenize.
 * @returns {{tokens: object[], lineTable: import('./loc.js').LineTable}} The tokens and line table.
 * @throws {TokenizerError} On a lexical error (see {@link tokenize}).
 */
export function tokenizeWithLineTable(source) {
    return { tokens: tokenize(source), lineTable: buildLineTable(source) };
}
