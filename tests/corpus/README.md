# Handlebars parity corpus

`BEFORE`-baseline inputs for the AST- and error-parity gates (plan
`drop_handlebars-parser`). Each valid `*.hbs` file parses cleanly under the
`@handlebars/parser` version the plugin currently depends on; each
`errors/*.hbs` file throws. `scripts/capture-golden.mjs` freezes the projected
AST into `tests/golden/ast.baseline.json` and the classified throws into
`tests/golden/errors.baseline.json`.

Identifiers and literals are deliberately altered from any documentation
examples: only the syntactic **shape** is reproduced, never doc text (per the
no-copy-from-sfmc-docs rule). For example the `{!$namespace.Binding}` shape from
the MCN data-binding table is reproduced with invented identifiers
(`{!$sender.PostalLocation}`, `{!$hyperlink.OptOutDestination}`) rather than the
catalogued binding names. Generic helper names are neutral first-party choices.

## Grammar-bullet -> corpus file

| Supported-grammar bullet | Corpus file |
|---|---|
| Simple mustache `{{ }}`, dotted paths | `simple-mustache.hbs` |
| Nested mustache / helper + subexpression | `nested-mustache.hbs` |
| Triple-stache `{{{ }}}` (`escaped:false`) | `triple-stache.hbs` |
| Unescaped ampersand `{{& }}` | `amp-unescaped.hbs` |
| Short comment `{{! }}` | `comment-short.hbs` |
| Long comment `{{!-- --}}` (may contain `}}`) | `comment-long.hbs` |
| Escape `\{{` -> literal `{{` in content | `escaped-mustache.hbs` |
| Escape `\\{{` -> literal `\` + real mustache | `escaped-double-backslash.hbs` |
| Block `{{#if}}{{else}}{{/if}}` | `block-if-else.hbs` |
| `{{else if}}` chain | `block-else-if-chain.hbs` |
| Caret inverse block `{{^x}}...{{/x}}` (valid, path) | `block-caret-inverse.hbs` |
| Block params `as |a b|` | `block-params.hbs` |
| Subexpressions (nested) | `subexpression.hbs` |
| Hash pairs (string / path / literal values) | `hash-pairs.hbs` |
| Literals (string/number/boolean/null/undefined) | `literals.hbs` |
| Literal-as-path (`{{"str"}}`, `{{true}}`, `{{5}}`) | `literal-as-path.hbs` |
| Partials `{{> p}}`, `{{> p ctx k=v}}`, `{{> (dyn)}}` | `partial.hbs` |
| Partial block `{{#> p}}...{{/p}}` | `partial-block.hbs` |
| Decorator `{{* d}}` | `decorator.hbs` |
| Inline decorator block `{{#*inline "n"}}...{{/inline}}` | `decorator-block.hbs` |
| Raw block `{{{{raw}}}}...{{{{/raw}}}}` (inner `{{` not parsed) | `raw-block.hbs` |
| Paths: `this`, `./`, `../`, `@root`/`@data`, segment literal, `@index`/`@key` | `paths-special.hbs` |
| Segment literals `foo.[bar baz]`, `.[0]`, `this.[x y]` | `segment-literal.hbs` |
| Whitespace control `{{~ ~}}` on every tag kind | `whitespace-control.hbs` |
| Empty block bodies (every empty-block table row) | `empty-blocks.hbs` |
| Legacy `/` path separator | `legacy-slash-path.hbs` |
| Numeric-path vs number-literal (`0x1`, `1e3`, `-42`, `3.14`) | `numeric-path-vs-literal.hbs` |
| `$` / `_` / `__c` / `__dlm` identifiers | `dollar-underscore-ids.hbs` |
| Plugin `hbsTester` snippets (helpers, blocks, subexpr) | `plugin-helpers.hbs` |
| MCN data variables `@root`/`@index`/`@key`/`@first`/`@last` (doc-derived shape) | `mcn-data-vars.hbs` |
| MCN block params with `{{#with ... as \| x \|}}` (doc-derived shape) | `mcn-block-params-with.hbs` |
| MCN hash + numeric/string literal args (doc-derived shape) | `mcn-hash-and-literals.hbs` |
| MCN deeply nested multi-line subexpressions (locks `loc` across newlines) | `mcn-nested-subexpr.hbs` |
| `{!$...}` bindings as inert `ContentStatement` content | `binding-content.hbs` |
| Full HTML document with embedded Handlebars (processor path) | `html-embedded.hbs` |

## Error corpus (`errors/`)

Both upstream error classes are covered. `class` is `jison` when the throw
carries `hash.loc`, else `exception`.

| File | Class | Case |
|---|---|---|
| `unclosed-block.hbs` | jison | `{{#alpha}}x` unclosed block (EOF) |
| `unterminated-string.hbs` | jison | `{{foo "bar}}` unterminated string literal |
| `doubled-else.hbs` | jison | `{{else}}{{else}}` doubled inverse |
| `bare-caret.hbs` | jison | bare `{{^}}` (throws at `1:0`) |
| `empty-mustache.hbs` | jison | `{{ }}` empty expression |
| `unexpected-sep.hbs` | jison | `{{.foo}}` unexpected separator token |
| `block-mismatch.hbs` | exception | `{{#alpha}}{{/beta}}` close-tag mismatch |
| `invalid-path.hbs` | exception | `{{foo/../bar}}` `Invalid path:` |
| `unterminated-comment.hbs` | exception | `{{!-- unterminated` lexical (Unrecognized text) |

## Regenerating the goldens

Run from this package root (the parser is resolved from
`../eslint-plugin-sfmc/node_modules/@handlebars/parser`, since this package does
not yet have its own `@handlebars/parser` devDependency installed):

```
node scripts/capture-golden.mjs
```

Overrides:

```
node scripts/capture-golden.mjs --parser <path-to-esm-entry> --out <dir>
```

The script sorts object keys, emits 4-space-indent JSON with a trailing newline,
and preserves `undefined`-valued keys as `{"__undefined__": true}` so
key-presence (e.g. `hash` present-but-undefined) survives JSON round-tripping.
Running it twice produces byte-identical output.
