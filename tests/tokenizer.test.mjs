import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildLineTable, locFromOffsets, offsetToPosition } from '../src/loc.js';
import { TokenType, TokenizerError, tokenize } from '../src/tokenizer.js';

/**
 * Tokenizes `source` and returns a compact `[type, start, end]` triple per token, which is
 * enough to assert stream shape and offsets without the payload noise.
 *
 * @param {string} source - The template to tokenize.
 * @returns {[string, number, number][]} One `[type, start, end]` per token.
 */
function shape(source) {
    return tokenize(source).map((t) => [t.type, t.start, t.end]);
}

/**
 * Finds the first token of the given type in `source`.
 *
 * @param {string} source - The template to tokenize.
 * @param {string} type - The {@link TokenType} to find.
 * @returns {object} The first matching token.
 */
function first(source, type) {
    return tokenize(source).find((t) => t.type === type);
}

describe('loc.js', () => {
    it('offset 0 is line 1 column 0', () => {
        const table = buildLineTable('abc');
        assert.deepEqual(offsetToPosition(table, 0), { line: 1, column: 0 });
    });

    it('tracks columns within a line (0-based, UTF-16 units)', () => {
        const table = buildLineTable('abcde');
        assert.deepEqual(offsetToPosition(table, 3), { line: 1, column: 3 });
    });

    it(String.raw`handles \n line breaks (1-based line, column resets)`, () => {
        const source = 'ab\ncd\nef';
        const table = buildLineTable(source);
        // 'e' is at offset 6 → line 3, column 0
        assert.equal(source[6], 'e');
        assert.deepEqual(offsetToPosition(table, 6), { line: 3, column: 0 });
        // 'f' is at offset 7 → line 3, column 1
        assert.deepEqual(offsetToPosition(table, 7), { line: 3, column: 1 });
    });

    it(String.raw`treats \r\n as a single line break, column resets after \n`, () => {
        const source = 'ab\r\ncd';
        const table = buildLineTable(source);
        // 'c' is at offset 4 → line 2, column 0 (the \r\n at 2..3 is one break)
        assert.equal(source[4], 'c');
        assert.deepEqual(offsetToPosition(table, 4), { line: 2, column: 0 });
        // the \r at offset 2 is still on line 1
        assert.deepEqual(offsetToPosition(table, 2), { line: 1, column: 2 });
    });

    it(String.raw`treats a lone \r as a line break`, () => {
        const source = 'ab\rcd';
        const table = buildLineTable(source);
        assert.equal(source[3], 'c');
        assert.deepEqual(offsetToPosition(table, 3), { line: 2, column: 0 });
    });

    it('clamps an offset one past the end to a valid end position', () => {
        const source = 'ab\ncd';
        const table = buildLineTable(source);
        assert.deepEqual(offsetToPosition(table, source.length), { line: 2, column: 2 });
    });

    it('counts astral characters as 2 UTF-16 code units', () => {
        const source = '\u{1F600}x'; // emoji (surrogate pair) then x
        const table = buildLineTable(source);
        // 'x' sits at code-unit offset 2
        assert.equal(source.length, 3);
        assert.deepEqual(offsetToPosition(table, 2), { line: 1, column: 2 });
    });

    it('locFromOffsets builds a {start,end} span', () => {
        const source = 'ab\ncd';
        const table = buildLineTable(source);
        assert.deepEqual(locFromOffsets(table, 0, 5), {
            start: { line: 1, column: 0 },
            end: { line: 2, column: 2 },
        });
    });
});

describe('tokenizer — content and escapes', () => {
    it('emits a single CONTENT run for plain text', () => {
        assert.deepEqual(shape('hello world'), [
            [TokenType.CONTENT, 0, 11],
            [TokenType.EOF, 11, 11],
        ]);
        assert.equal(first('hello world', TokenType.CONTENT).value, 'hello world');
    });

    it(String.raw`escaped \{{ emits escaped CONTENT for the literal mustache text`, () => {
        const source = String.raw`a\{{b}}c`;
        const tokens = tokenize(source);
        // a  |  {{b}}(escaped)  |  c
        assert.deepEqual(
            tokens.map((t) => [t.type, t.start, t.end]),
            [
                [TokenType.CONTENT, 0, 1],
                [TokenType.CONTENT, 2, 7],
                [TokenType.CONTENT, 7, 8],
                [TokenType.EOF, 8, 8],
            ],
        );
        const esc = tokens[1];
        assert.equal(esc.escaped, true);
        assert.equal(esc.value, '{{b}}');
        assert.equal(tokens[0].escaped, false);
    });

    it(String.raw`even backslashes (\\{{) leave a real mustache`, () => {
        const source = String.raw`a\\{{b}}c`;
        const tokens = tokenize(source);
        // content 'a\\' then a REAL mustache open/id/close then content 'c'
        assert.deepEqual(tokens[0].type, TokenType.CONTENT);
        assert.equal(tokens[0].value, 'a\\\\');
        assert.equal(tokens[1].type, TokenType.OPEN);
        assert.equal(tokens[1].strip, false);
    });

    it('stray }} in content is plain content', () => {
        assert.deepEqual(shape('a }} b'), [
            [TokenType.CONTENT, 0, 6],
            [TokenType.EOF, 6, 6],
        ]);
    });
});

describe('tokenizer — mustache delimiters and strip flags', () => {
    it('lexes {{ }} with an ID', () => {
        assert.deepEqual(shape('{{x}}'), [
            [TokenType.OPEN, 0, 2],
            [TokenType.ID, 2, 3],
            [TokenType.CLOSE, 3, 5],
            [TokenType.EOF, 5, 5],
        ]);
        assert.equal(first('{{x}}', TokenType.OPEN).open, '{{');
        assert.equal(first('{{x}}', TokenType.CLOSE).close, '}}');
    });

    it('lexes triple-stache {{{ }}}', () => {
        const tokens = tokenize('{{{x}}}');
        assert.equal(tokens[0].open, '{{{');
        assert.equal(tokens.at(-2).close, '}}}');
    });

    it('records whitespace-control ~ strip flags on both sides', () => {
        const tokens = tokenize('{{~ x ~}}');
        const open = tokens.find((t) => t.type === TokenType.OPEN);
        const close = tokens.find((t) => t.type === TokenType.CLOSE);
        assert.equal(open.strip, true);
        assert.equal(open.end, 3); // includes the ~
        assert.equal(close.strip, true);
        assert.equal(close.start, 6); // starts at the ~
    });

    it('non-strip mustache has strip:false', () => {
        const tokens = tokenize('{{ x }}');
        assert.equal(tokens.find((t) => t.type === TokenType.OPEN).strip, false);
        assert.equal(tokens.find((t) => t.type === TokenType.CLOSE).strip, false);
    });
});

describe('tokenizer — sigils', () => {
    const cases = [
        ['{{#x}}', '#'],
        ['{{/x}}', '/'],
        ['{{^x}}', '^'],
        ['{{>x}}', '>'],
        ['{{#>x}}', '#>'],
        ['{{*x}}', '*'],
        ['{{#*x}}', '#*'],
        ['{{&x}}', '&'],
    ];
    for (const [source, sigil] of cases) {
        it(`emits SIGIL '${sigil}' for ${source}`, () => {
            const token = first(source, TokenType.SIGIL);
            assert.ok(token, `expected a SIGIL token in ${source}`);
            assert.equal(token.value, sigil);
            assert.equal(token.start, 2);
        });
    }
});

describe('tokenizer — comments', () => {
    it('short comment {{! c }} ends at the first }}', () => {
        const token = first('{{! c }}', TokenType.COMMENT);
        assert.equal(token.value, ' c ');
        assert.equal(token.long, false);
        assert.equal(token.start, 0);
        assert.equal(token.end, 8);
    });

    it('long comment {{!-- c --}} may contain }} and ends at --}}', () => {
        const source = '{{!-- c }} d --}}';
        const token = first(source, TokenType.COMMENT);
        assert.equal(token.value, ' c }} d ');
        assert.equal(token.long, true);
        assert.equal(token.end, source.length);
    });

    it('captures strip flags on a comment', () => {
        const token = first('{{~! c ~}}', TokenType.COMMENT);
        assert.equal(token.strip, true);
        assert.equal(token.closeStrip, true);
    });
});

describe('tokenizer — inside-expression atoms', () => {
    it('segment literal [a b] captures inner text verbatim', () => {
        const token = first('{{a.[b c].d}}', TokenType.SEGMENT);
        assert.equal(token.value, 'b c');
    });

    it('path separators . / and parent ..', () => {
        const seps = tokenize('{{../a/b.c}}').filter((t) => t.type === TokenType.SEP);
        assert.deepEqual(
            seps.map((t) => t.value),
            ['..', '/', '/', '.'],
        );
    });

    it('@ data prefix and = hash assign', () => {
        assert.ok(first('{{@root}}', TokenType.DATA));
        assert.ok(first('{{f k=v}}', TokenType.EQUALS));
    });

    it('string literal with an escaped quote decodes the value', () => {
        const token = first(String.raw`{{"he\"llo"}}`, TokenType.STRING);
        assert.equal(token.value, 'he"llo');
        assert.equal(token.quote, '"');
    });

    it('single-quoted string literal', () => {
        const token = first("{{'ab'}}", TokenType.STRING);
        assert.equal(token.value, 'ab');
        assert.equal(token.quote, "'");
    });

    it('number literals, incl. negative and fractional', () => {
        const nums = tokenize('{{f -5 3.14 0}}').filter((t) => t.type === TokenType.NUMBER);
        assert.deepEqual(
            nums.map((t) => t.value),
            ['-5', '3.14', '0'],
        );
    });

    it('boolean / null / undefined are lexed as ID (parser classifies)', () => {
        const ids = tokenize('{{f true null undefined}}')
            .filter((t) => t.type === TokenType.ID)
            .map((t) => t.value);
        assert.deepEqual(ids, ['f', 'true', 'null', 'undefined']);
    });

    it('subexpression parens', () => {
        const tokens = tokenize('{{sub (x y)}}');
        assert.ok(tokens.some((t) => t.type === TokenType.OPEN_PAREN));
        assert.ok(tokens.some((t) => t.type === TokenType.CLOSE_PAREN));
    });

    it('block-params fence as |a b|', () => {
        const pipes = tokenize('{{#each i as |a b|}}{{/each}}').filter(
            (t) => t.type === TokenType.PIPE,
        );
        assert.equal(pipes.length, 2);
    });

    it('$ and _ are valid id characters', () => {
        const token = first('{{$my_var}}', TokenType.ID);
        assert.equal(token.value, '$my_var');
    });

    it('whitespace inside an expression is emitted with offsets', () => {
        const ws = tokenize('{{ x }}').filter((t) => t.type === TokenType.WHITESPACE);
        assert.equal(ws.length, 2);
        assert.deepEqual(
            ws.map((t) => [t.start, t.end]),
            [
                [2, 3],
                [4, 5],
            ],
        );
    });
});

describe('tokenizer — raw blocks', () => {
    it('lexes {{{{raw}}}}…{{{{/raw}}}} with a verbatim body', () => {
        const source = '{{{{raw}}}}x{{y}}z{{{{/raw}}}}';
        const tokens = tokenize(source);
        assert.deepEqual(
            tokens.map((t) => [t.type, t.start, t.end]),
            [
                [TokenType.RAW_OPEN, 0, 11],
                [TokenType.RAW_CONTENT, 11, 18],
                [TokenType.RAW_CLOSE, 18, 30],
                [TokenType.EOF, 30, 30],
            ],
        );
        assert.equal(tokens[0].name, 'raw');
        assert.equal(tokens[1].value, 'x{{y}}z');
        assert.equal(tokens[2].name, 'raw');
    });
});

describe('tokenizer — final EOF', () => {
    it('always emits a trailing EOF at source.length', () => {
        for (const source of ['', 'x', '{{a}}', '{{{{r}}}}b{{{{/r}}}}']) {
            const tokens = tokenize(source);
            const eof = tokens.at(-1);
            assert.equal(eof.type, TokenType.EOF);
            assert.equal(eof.start, source.length);
            assert.equal(eof.end, source.length);
        }
    });
});

describe('tokenizer — lexical errors', () => {
    const cases = [
        ['{{"abc}}', 'unterminated-string', 2],
        ['{{!-- nope', 'unterminated-comment', 0],
        ['{{{{raw}}}}x', 'unterminated-raw-block', 0],
        ['{{a.[b}}', 'unterminated-segment', 4],
    ];
    for (const [source, kind, offset] of cases) {
        it(`throws TokenizerError (${kind}) at offset ${offset} for ${JSON.stringify(source)}`, () => {
            assert.throws(
                () => tokenize(source),
                (ex) => {
                    assert.ok(ex instanceof TokenizerError);
                    assert.equal(ex.kind, kind);
                    assert.equal(ex.offset, offset);
                    assert.equal(typeof ex.offset, 'number');
                    return true;
                },
            );
        });
    }
});

describe('tokenizer + loc — position conversion', () => {
    it('converts token offsets to 1-based line / 0-based column on multi-line input', () => {
        const source = '{{a}}\n  {{b}}';
        const tokens = tokenize(source);
        const table = buildLineTable(source);
        // second open '{{' is on line 2. Find it (the 2nd OPEN).
        const opens = tokens.filter((t) => t.type === TokenType.OPEN);
        const secondOpen = opens[1];
        const loc = locFromOffsets(table, secondOpen.start, secondOpen.end);
        assert.deepEqual(loc.start, { line: 2, column: 2 });
        assert.deepEqual(loc.end, { line: 2, column: 4 });
    });

    it(String.raw`handles \r\n input for position conversion`, () => {
        const source = '{{a}}\r\n{{b}}';
        const tokens = tokenize(source);
        const table = buildLineTable(source);
        const secondOpen = tokens.filter((t) => t.type === TokenType.OPEN)[1];
        const loc = locFromOffsets(table, secondOpen.start, secondOpen.end);
        assert.deepEqual(loc.start, { line: 2, column: 0 });
    });
});
