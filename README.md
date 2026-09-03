# sfmc-handlebars-parser

A zero-dependency, clean-room Handlebars parser that produces an
`@handlebars/parser`-compatible AST for Salesforce Marketing Cloud (SFMC) tooling.

It parses Handlebars templates (including Handlebars embedded in HTML) into the same
node shapes the reference `@handlebars/parser` emits — 1-based line / 0-based column
locations (in UTF-16 code units), `params` always an array, `hash` present as a key,
and `program` / `inverse` present as keys — so it can drop into tools that were built
against that AST.

**Clean-room note:** this parser is written from the observed public AST behaviour of
`@handlebars/parser` (MIT) and the published Handlebars language specification. No source
was copied from handlebars.js or `@handlebars/parser`. The upstream package is kept only
as a development dependency, used by the capture tooling to freeze the AST/error goldens
this parser is verified against.

This package is used internally by:

- [eslint-plugin-sfmc](https://www.npmjs.com/package/eslint-plugin-sfmc) — Handlebars linting for Marketing Cloud Next

## Installation

```sh
npm install sfmc-handlebars-parser
```

## Usage

```js
import { parse } from 'sfmc-handlebars-parser';

const ast = parse('{{#each items as |item|}}{{item.name}}{{/each}}');

console.log(ast.type); // 'Program'
console.log(ast.body[0].type); // 'BlockStatement'
```

### `parse(input)`

Parses a Handlebars (or HTML-with-Handlebars) source string into the root `Program` node.

It accepts every construct `@handlebars/parser@2.2.2` accepts:

- Mustaches: `{{ }}`, `{{{ }}}` (unescaped), `{{& }}`; `~` whitespace control on any tag.
- Comments: `{{! }}` and `{{!-- --}}`.
- Blocks: `{{#x}}…{{/x}}`, inverse `{{^x}}…{{/x}}`, `{{else}}`, `{{else if …}}` chaining,
  block params `as |a b|`, and empty block bodies.
- Paths: `this`, `.` (current context), `..` (parent), `./`, `../` (parent depth), a
  `{{...}}` mustache (parent path plus a current-context param), `@data` variables,
  segment literals `[…]`, the legacy `/` separator, and identifiers containing `$` / `_`.
- Literals: strings (`"…"` / `'…'` with escapes), numbers (including negative),
  `true` / `false` / `null` / `undefined`.
- Subexpressions `( … )` nested arbitrarily, and hash pairs `key=value`.
- Partials: `{{> p}}`, `{{> (dyn)}}`, `{{> p ctx k=v}}`, `{{#> pb}}…{{/pb}}`.
- Decorators: `{{* d}}`, `{{#*inline "n"}}…{{/inline}}`.
- Raw blocks: `{{{{raw}}}}…{{{{/raw}}}}` (inner `{{ }}` are not parsed).

On a malformed template, `parse` throws. Parse errors mirror the two upstream error
classes: a Jison-class error carries `hash.loc` (`{first_line, first_column, last_line,
last_column}`); an exception-class error carries `lineNumber` / `column`.

```js
import { parse } from 'sfmc-handlebars-parser';

try {
    parse('{{#alpha}}x'); // unclosed block
} catch (ex) {
    console.log(ex.hash.loc); // { first_line, first_column, last_line, last_column }
}
```

## TypeScript

The package ships type declarations. The `parse` signature and the full `AST` node
namespace are exported, so consumers can import both the value and the types:

```ts
import { parse, type AST } from 'sfmc-handlebars-parser';

const program: AST.Program = parse('{{greeting}}');
```

## License

MIT © Joern Berkefeld
