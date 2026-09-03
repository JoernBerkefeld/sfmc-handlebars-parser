// Type-only consumer: proves the published `src/index.d.ts` supports the exact
// reads that sfmc-language-lsp (`handlebarsAst.ts`, `handlebarsScopeTracker.ts`,
// `mcnHandlebars.ts`) and eslint-plugin-sfmc (`handlebars-parser.js`) perform.
//
// This file is type-checked by `test:types` (tsc --noEmit, skipLibCheck:false);
// it is never executed. A failure here means the published types cannot express
// a real consumer read.

// Both import styles must resolve (the LSP uses each in different files). The
// runtime specifier resolves to the sibling `src/index.d.ts` via `index.js`.
import { parse, type AST } from '../../src/index.js';
import type { AST as AST2 } from '../../src/index.js';

// `parse` returns a `Program` whose `body` is a readable array of statements.
const program: AST.Program = parse('{{x}}');
const firstStatement: AST.Node = program.body[0];
const _statementType: string = firstStatement.type;

// `astLocToRange(loc: AST.SourceLocation)` reads `start`/`end` Positions;
// `astPositionToLsp(pos: AST.Position)` reads 1-based `line` / 0-based `column`.
function astPositionToLsp(pos: AST2.Position): { line: number; character: number } {
    return { line: pos.line - 1, character: pos.column };
}
function astLocToRange(loc: AST.SourceLocation) {
    return { start: astPositionToLsp(loc.start), end: astPositionToLsp(loc.end) };
}
// `Program.loc` is `SourceLocation | undefined` (empty-body programs carry it as
// a present key with value `undefined`), so a consumer must guard before reading.
if (program.loc) void astLocToRange(program.loc);

// The walker descends body / program / inverse / path / name / params / hash.pairs.
function walk(node: AST.Node, visit: (n: AST.Node) => void): void {
    visit(node);
    const n = node as AST.Node & Record<string, unknown>;
    if (Array.isArray(n.body)) {
        for (const child of n.body as AST.Node[]) walk(child, visit);
    }
    if (n.program) walk(n.program as AST.Node, visit);
    if (n.inverse) walk(n.inverse as AST.Node, visit);
    if (n.path) walk(n.path as AST.Node, visit);
    if (n.name && typeof n.name === 'object') walk(n.name as AST.Node, visit);
    if (Array.isArray(n.params)) {
        for (const p of n.params as AST.Node[]) walk(p, visit);
    }
    if (n.hash && typeof n.hash === 'object') {
        const hash = n.hash as AST.Hash;
        if (Array.isArray(hash.pairs)) {
            for (const pair of hash.pairs) walk(pair.value as AST.Node, visit);
        }
    }
}
// `Program.loc` is `SourceLocation | undefined`, so a `Program` is not structurally
// a `Node` (whose `loc` is required); the walker never reads `loc`, so treat it as a
// `Node` for traversal. A real consumer widens the root the same way.
walk(program as AST.Node, () => {});

// Scope tracker: narrow a BlockStatement, read its `path` PathExpression fields
// (`data` / `depth` / `parts` with a string-part guard), and `program.blockParams`.
function inspectBlock(node: AST.BlockStatement): string | null {
    const path = node.path;
    if (!path || path.type !== 'PathExpression') return null;
    if (path.data || (path.depth ?? 0) > 0) return null;
    const parts = path.parts ?? [];
    if (parts.length !== 1) return null;
    const first = parts[0];
    const params: string[] = node.program?.blockParams ?? [];
    void params;
    if (node.program?.loc) astLocToRange(node.program.loc);
    return typeof first === 'string' ? first.toLowerCase() : null;
}
declare const someBlock: AST.BlockStatement;
void inspectBlock(someBlock);

// mcnHandlebars validator narrowed views: `PathLike` reads type/parts/depth/data/original,
// `CallNode` reads path/params/hash.pairs.
interface PathLike {
    type: string;
    parts?: string[];
    depth?: number;
    data?: boolean;
    original?: string;
}
interface CallNode extends AST.Node {
    path?: PathLike;
    params?: unknown[];
    hash?: { pairs?: unknown[] };
}
declare const call: CallNode;
void call.path?.original;
void call.hash?.pairs;

// Literal narrowing (a HashPair value can be any literal).
declare const pair: AST.HashPair;
const value: AST.Expression = pair.value;
if (value.type === 'NumberLiteral') {
    const n: number = value.value;
    void n;
}
