/**
 * Source-location utilities for sfmc-handlebars-parser.
 *
 * Converts absolute string offsets (UTF-16 code-unit indices into the source) into
 * `{ line, column }` positions and builds `SourceLocation { start, end }` spans that the
 * parser (W2) attaches to AST nodes.
 *
 * Position contract (matches the upstream `@handlebars/parser` AST and the ESLint/LSP
 * wrappers): `line` is 1-based, `column` is 0-based, and both are counted in UTF-16 code
 * units (i.e. plain JavaScript string indices). A `\r\n` sequence counts as a SINGLE line
 * break; the column resets to 0 on the code unit after the `\n`. A lone `\r` and a lone
 * `\n` each also count as a line break.
 */

/**
 * Precomputed line-start table for a single source string. Enables O(log n) offset→position
 * lookups without rescanning the source for every token.
 *
 * @typedef {object} LineTable
 * @property {string} source - The source string this table was built from.
 * @property {number[]} lineStarts - Absolute offset (UTF-16 code unit) at which each line begins.
 * `lineStarts[0]` is always `0`; entry `i` is the offset of the first character of line `i + 1`.
 */

/**
 * A position in the source. `line` is 1-based, `column` is 0-based, both in UTF-16 code units.
 *
 * @typedef {object} Position
 * @property {number} line - 1-based line number.
 * @property {number} column - 0-based column (UTF-16 code units from the line start).
 */

/**
 * A source span with inclusive start and exclusive end positions.
 *
 * @typedef {object} SourceLocation
 * @property {Position} start - Start position (offset of the first code unit of the span).
 * @property {Position} end - End position (offset just past the last code unit of the span).
 */

/**
 * Builds a {@link LineTable} for the given source. A `\r\n` pair is treated as one line
 * break: the next line begins at the offset following the `\n`. Lone `\r` and lone `\n`
 * each start a new line as well.
 *
 * @param {string} source - The full source string.
 * @returns {LineTable} A table mapping offsets to positions for `source`.
 */
export function buildLineTable(source) {
    const lineStarts = [0];
    const length = source.length;
    for (let index = 0; index < length; index++) {
        const code = source.codePointAt(index);
        // \n (LF)
        if (code === 10) {
            lineStarts.push(index + 1);
        } else if (code === 13) {
            // \r (CR); if followed by \n, consume the pair as a single line break.
            if (index + 1 < length && source.codePointAt(index + 1) === 10) {
                index++;
            }
            lineStarts.push(index + 1);
        }
    }
    return { source, lineStarts };
}

/**
 * Converts an absolute offset into a {@link Position} using a precomputed {@link LineTable}.
 *
 * The offset is clamped into `[0, source.length]`, so passing `source.length` (one past the
 * end) yields a valid end position on the final line.
 *
 * @param {LineTable} table - A table produced by {@link buildLineTable}.
 * @param {number} offset - Absolute offset (UTF-16 code unit) into the source.
 * @returns {Position} The 1-based-line / 0-based-column position for `offset`.
 */
export function offsetToPosition(table, offset) {
    const { lineStarts, source } = table;
    const clamped = offset < 0 ? 0 : Math.min(offset, source.length);
    // Binary search for the greatest lineStart that is <= clamped.
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (lineStarts[mid] <= clamped) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return { line: low + 1, column: clamped - lineStarts[low] };
}

/**
 * Builds a {@link SourceLocation} spanning `[startOffset, endOffset)` using a
 * precomputed {@link LineTable}.
 *
 * @param {LineTable} table - A table produced by {@link buildLineTable}.
 * @param {number} startOffset - Absolute offset of the first code unit of the span.
 * @param {number} endOffset - Absolute offset just past the last code unit of the span.
 * @returns {SourceLocation} A `{ start, end }` location.
 */
export function locFromOffsets(table, startOffset, endOffset) {
    return {
        start: offsetToPosition(table, startOffset),
        end: offsetToPosition(table, endOffset),
    };
}
