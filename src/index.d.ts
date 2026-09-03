// Type declarations for sfmc-handlebars-parser.
//
// Clean-room note: these declarations are written from the OBSERVED runtime AST
// shapes this parser emits (frozen in `tests/golden/ast.baseline.json`, verified
// node-for-node against `@handlebars/parser@2.2.2`) and the published Handlebars
// language spec. No `.d.ts` text was copied from handlebars.js / `@handlebars/parser`.
// In particular `ContentStatement.original` is typed as `string` here — upstream's
// own declarations mistype it as `StripFlags`; that mistake is deliberately not copied.
//
// The `AST` namespace is intentionally exported in VALUE space (`export { AST }`, NOT
// `export type { AST }`) so BOTH of these resolve in downstream consumers:
//   import { parse, type AST } from 'sfmc-handlebars-parser';
//   import type { AST } from 'sfmc-handlebars-parser';
// (the sfmc-language-lsp uses each style in different files).

/**
 * Parses a Handlebars template string into an upstream-compatible AST.
 *
 * The returned tree matches the `@handlebars/parser@2.2.2` node shapes: 1-based
 * line / 0-based column locations (UTF-16 code units), `params` always an array,
 * `hash` present as a key (its value `undefined` when there is no `k=v` pair),
 * and `program` / `inverse` present as keys (their value `undefined` when absent).
 *
 * @param input - The Handlebars (or HTML-with-Handlebars) source to parse.
 * @returns The root `Program` node.
 * @throws On a malformed template — a Jison-class parse error (carrying
 * `hash.loc`) or an exception-class error (carrying `lineNumber` / `column`).
 */
export declare function parse(input: string): AST.Program;

declare namespace AST {
    /**
     * A source position. `line` is 1-based; `column` is 0-based; both count
     * UTF-16 code units (matching upstream and the ESLint/LSP conventions).
     */
    interface Position {
        line: number;
        column: number;
    }

    /**
     * The span of a node in the source. `source` is present with value
     * `undefined` when `parse` is called without a source name.
     */
    interface SourceLocation {
        source?: string;
        start: Position;
        end: Position;
    }

    /**
     * The whitespace-control (`~`) flags for one delimiter pair. Both flags are
     * always present as booleans (they are not read by SFMC tooling but are
     * emitted for upstream parity).
     */
    interface StripFlags {
        open: boolean;
        close: boolean;
    }

    /**
     * Common shape shared by every AST node: a discriminating `type` and a
     * `loc`. On a `Program` with an empty `body`, `loc` may be `undefined`.
     */
    interface Node {
        type: string;
        loc: SourceLocation;
    }

    /**
     * A body of statements. The root program, a block body, an inverse branch,
     * or a partial-/decorator-/raw-block body.
     *
     * `blockParams` is present only when an `as |a b|` fence was written on the
     * owning block (its value is the declared names). `chained` is `true` only on
     * the inverse `Program` that holds an `{{else if}}` chain. `loc` is `undefined`
     * for an empty body (`body: []`).
     */
    interface Program extends Omit<Node, 'loc'> {
        body: Statement[];
        blockParams?: string[];
        chained?: boolean;
        // An empty-body Program carries `loc` as a present key whose value is
        // `undefined` (see the doc comment above and the frozen golden). Overriding
        // the base `Node.loc` here forces consumers to guard with `program?.loc` —
        // reading `program.loc.start` unguarded must NOT typecheck as always-safe.
        // (`Node.loc` stays required for every other node type, which always have a
        // real span; `Omit` is needed because TS forbids widening an inherited
        // required property in an `extends` clause.)
        loc: SourceLocation | undefined;
    }

    /** A `{{ }}` / `{{{ }}}` / `{{& }}` interpolation. */
    interface MustacheStatement extends Node {
        type: 'MustacheStatement';
        path: Expression;
        params: Expression[];
        hash?: Hash;
        escaped: boolean;
        strip: StripFlags;
    }

    /**
     * A `{{#name ...}} ... {{else}} ... {{/name}}` block, or the caret shorthand
     * `{{^name}} ... {{/name}}`. `program` and `inverse` are present as keys with
     * value `undefined` when the corresponding branch is absent.
     */
    interface BlockStatement extends Node {
        type: 'BlockStatement';
        path: PathExpression;
        params: Expression[];
        hash?: Hash;
        program?: Program;
        inverse?: Program;
        openStrip: StripFlags;
        inverseStrip: StripFlags;
        closeStrip: StripFlags;
    }

    /** A run of literal template text between mustaches. */
    interface ContentStatement extends Node {
        type: 'ContentStatement';
        value: string;
        // Upstream mistypes this as `StripFlags`; it is a string. Do not copy that.
        original: string;
    }

    /** A `{{! ... }}` or `{{!-- ... --}}` comment. */
    interface CommentStatement extends Node {
        type: 'CommentStatement';
        value: string;
        strip: StripFlags;
    }

    /** A `{{> name ...}}` partial reference. */
    interface PartialStatement extends Node {
        type: 'PartialStatement';
        name: PathExpression | SubExpression | Literal;
        params: Expression[];
        hash?: Hash;
        indent: string;
        strip: StripFlags;
    }

    /** A `{{#> name}} ... {{/name}}` partial block. */
    interface PartialBlockStatement extends Node {
        type: 'PartialBlockStatement';
        name: PathExpression | SubExpression | Literal;
        params: Expression[];
        hash?: Hash;
        program?: Program;
        openStrip: StripFlags;
        closeStrip: StripFlags;
    }

    /** A `{{* name ...}}` inline decorator. */
    interface Decorator extends Node {
        type: 'Decorator';
        path: Expression;
        params: Expression[];
        hash?: Hash;
        escaped: boolean;
        strip: StripFlags;
    }

    /** A `{{#* name}} ... {{/name}}` decorator block. */
    interface DecoratorBlock extends Node {
        type: 'DecoratorBlock';
        path: PathExpression;
        params: Expression[];
        hash?: Hash;
        program?: Program;
        inverse?: Program;
        openStrip: StripFlags;
        closeStrip: StripFlags;
    }

    /** A parenthesised `( name ... )` helper call used as an argument. */
    interface SubExpression extends Node {
        type: 'SubExpression';
        path: PathExpression;
        params: Expression[];
        hash?: Hash;
    }

    /**
     * A dotted / bracketed / relative path such as `foo.bar`, `../x`, `@root.y`,
     * `this.[a b]`, or a bare `this`.
     *
     * `parts` are the resolved segment strings (segment-literal brackets removed,
     * inner spaces kept: `foo.[bar baz]` -> `["foo","bar baz"]`). `head` is
     * `parts[0]` (or `undefined` for a bare `this`); `tail` is `parts.slice(1)`.
     * `data` is `true` for an `@`-prefixed path; `depth` counts leading `../`;
     * `this` is `true` when the path began with an explicit `this` head that
     * carried further segments. `original` is the raw path text with brackets
     * removed and every separator kept verbatim.
     *
     * The `parts` element type includes `SubExpression` so a scope walker's
     * `typeof part === 'string'` guard type-checks; the parser emits string parts.
     */
    interface PathExpression extends Node {
        type: 'PathExpression';
        data: boolean;
        depth: number;
        parts: Array<string | SubExpression>;
        head?: string;
        tail: string[];
        this: boolean;
        original: string;
    }

    /** The hash (named-argument) map of a call, emitted only when >= 1 pair. */
    interface Hash extends Node {
        type: 'Hash';
        pairs: HashPair[];
    }

    /** One `key=value` named argument. */
    interface HashPair extends Node {
        type: 'HashPair';
        key: string;
        value: Expression;
    }

    /** A `"..."` / `'...'` string literal (its `value`/`original` are the decoded string). */
    interface StringLiteral extends Node {
        type: 'StringLiteral';
        value: string;
        original: string;
    }

    /** A numeric literal (its `value`/`original` are the parsed JS number). */
    interface NumberLiteral extends Node {
        type: 'NumberLiteral';
        value: number;
        original: number;
    }

    /** A `true` / `false` literal. */
    interface BooleanLiteral extends Node {
        type: 'BooleanLiteral';
        value: boolean;
        original: boolean;
    }

    /** A `null` literal (`value`/`original` are `null`). */
    interface NullLiteral extends Node {
        type: 'NullLiteral';
        value: null;
        original: null;
    }

    /** An `undefined` literal (`value`/`original` are the key present with value `undefined`). */
    interface UndefinedLiteral extends Node {
        type: 'UndefinedLiteral';
        value: undefined;
        original: undefined;
    }

    /** Any of the five value literals. */
    type Literal =
        | StringLiteral
        | NumberLiteral
        | BooleanLiteral
        | NullLiteral
        | UndefinedLiteral;

    /**
     * Anything that can appear in a `path` slot, a positional `param`, or a
     * `HashPair` value: a path, a subexpression, or a literal.
     */
    type Expression = PathExpression | SubExpression | Literal;

    /** Anything that can appear directly in a `Program.body`. */
    type Statement =
        | MustacheStatement
        | BlockStatement
        | ContentStatement
        | CommentStatement
        | PartialStatement
        | PartialBlockStatement
        | Decorator
        | DecoratorBlock;

    /**
     * The discriminated union of every node the parser emits. Covers the
     * name-bearing nodes (`PartialStatement` / `PartialBlockStatement` /
     * `Decorator` / `DecoratorBlock`) so a generic AST walker that descends
     * `node.name` type-checks.
     */
    type Nodes =
        | Program
        | Statement
        | SubExpression
        | Expression
        | Hash
        | HashPair;
}

export { AST };
