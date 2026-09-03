# Changelog

All notable changes to this project are documented in GitHub Releases. This file
summarises the same notes for local checkout.

## [0.1.1] — 2026-09-03

### Fixed

- Conditional `exports["."]` now includes `"default": "./src/index.js"` so Node
  `require()` (including `require(esm)` from a CJS consumer such as
  `sfmc-language-lsp`'s CJS build) resolves the package. Published 0.1.0 only
  listed `"import"`, which failed that path.
- `{{...}}` (three-dot path) now parses the way `@handlebars/parser` does: a
  mustache whose path is parent-context `..` with a current-context `.`
  positional param. Bare `{{.}}` / `{{..}}` are accepted as current / parent
  context. `{{.foo}}` still throws.
