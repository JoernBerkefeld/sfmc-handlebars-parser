import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parse } from '../src/index.js';

describe('sfmc-handlebars-parser package', () => {
    it('exports a parse function', () => {
        assert.equal(typeof parse, 'function');
    });

    it('parse returns a Program for a simple mustache (W2b-1)', () => {
        const ast = parse('{{x}}');
        assert.equal(ast.type, 'Program');
        assert.equal(ast.body.length, 1);
        assert.equal(ast.body[0].type, 'MustacheStatement');
    });
});
