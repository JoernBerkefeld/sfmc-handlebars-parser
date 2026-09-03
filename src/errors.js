/**
 * Error classes for sfmc-handlebars-parser.
 *
 * Reproduces the TWO distinct error shapes that `@handlebars/parser@2.2.2` throws, so the
 * `eslint-plugin-sfmc` wrapper (`eslint-plugin-sfmc/src/handlebars-parser.js`) and the LSP
 * derive the same 1:1-vs-real-position diagnostics they do today:
 *
 *   - {@link HandlebarsParseError} — the **Jison-class** parse/lex error. Carries
 *     `hash.loc = { first_line, first_column, last_line, last_column }` (1-based line, 0-based
 *     column) and NO `lineNumber`/`column`. The wrapper reads `hash.loc.first_line` /
 *     `first_column` and reports the real position.
 *   - {@link HandlebarsException} — the **exception-class** logic error (block-name mismatch,
 *     `Invalid path:`, lexical "Unrecognized text"). Carries NO `hash`; instead it MAY set
 *     `lineNumber` / `column` (1-based line, 1-based column, matching upstream's `Exception`).
 *     When it carries neither (the lexical case), the wrapper falls back to reporting `1:1`.
 *
 * The golden error projection (`tests/golden/errors.baseline.json`) classifies an error as
 * `jison` iff `hash.loc` is present, else `exception` — so the CLASS is what these two subclasses
 * encode. Message wording is not part of the parity gate (only class + position), but each
 * builder emits a descriptive message for the plugin's single-line diagnostic.
 *
 * Clean-room note: written from the observed public error behaviour of `@handlebars/parser`
 * (MIT) and the Handlebars language spec; no upstream source was copied.
 */

/**
 * A Jison-class parse/lex error. Carries a `hash.loc` span (Jison's `SourceLocation` shape) and
 * deliberately NO `lineNumber`/`column`, so the golden projection classifies it as `jison`.
 */
export class HandlebarsParseError extends Error {
    /**
     * @param {string} message - The diagnostic message (wording is not parity-gated).
     * @param {object} loc - The Jison `hash.loc` span.
     * @param {number} loc.first_line - 1-based start line.
     * @param {number} loc.first_column - 0-based start column.
     * @param {number} loc.last_line - 1-based end line.
     * @param {number} loc.last_column - 0-based end column.
     */
    constructor(message, loc) {
        super(message);
        this.name = 'HandlebarsParseError';
        this.hash = { loc };
    }
}

/**
 * An exception-class logic/lexical error. Carries NO `hash`; the golden projection classifies it
 * as `exception`. `lineNumber` / `column` are set for the logic errors (block mismatch, invalid
 * path) and left unset for the lexical "Unrecognized text" error (matching upstream, whose
 * lexical exception exposes neither — the wrapper then reports `1:1`).
 */
export class HandlebarsException extends Error {
    /**
     * @param {string} message - The diagnostic message (the ` - line:column` suffix, if any, is
     * expected to already be appended by the caller for the logic-error cases).
     * @param {object} [position] - Optional 1-based line / 1-based column of the error.
     * @param {number} [position.lineNumber] - 1-based line number.
     * @param {number} [position.column] - 1-based column number.
     */
    constructor(message, position) {
        super(message);
        this.name = 'HandlebarsException';
        if (position && position.lineNumber !== undefined) {
            this.lineNumber = position.lineNumber;
        }
        if (position && position.column !== undefined) {
            this.column = position.column;
        }
    }
}
