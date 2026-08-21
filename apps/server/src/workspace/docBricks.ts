// @effect-diagnostics nodeBuiltinImport:off - pure filesystem scan of a workspace; callers run it inside Effect.
/**
 * Doc bricks: the read-first document candidates a thread can be launched
 * with. One place composes them — identity docs, the repo's spine docs
 * (`docs/*.md` whose head declares `context: spine`), the newest handoff,
 * and caller extras — deduped by relative path, each with a chars/4 token
 * estimate (labeled approximate in the UI).
 *
 * Ported from ADE `src/main/lib/doc-bricks.ts` (2026-08-21).
 *
 * @module docBricks
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type DocBrick = {
  readonly rel: string;
  readonly exists: boolean;
  readonly chars: number;
  readonly tokens: number;
};

const IDENTITY = ["NORTHSTAR.md", "OWNER-DIRECTIVES.md", "README.md", "docs/PLAN.md"];

function stat(workspaceRoot: string, rel: string): DocBrick {
  const p = NodePath.isAbsolute(rel) ? rel : NodePath.join(workspaceRoot, rel);
  try {
    const chars = NodeFS.statSync(p).size;
    return { rel, exists: true, chars, tokens: Math.round(chars / 4) };
  } catch {
    return { rel, exists: false, chars: 0, tokens: 0 };
  }
}

function newestHandoff(workspaceRoot: string): string | null {
  const dir = NodePath.join(workspaceRoot, ".claude", "handoffs");
  if (!NodeFS.existsSync(dir)) return null;
  const newest = NodeFS.readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ f, m: NodeFS.statSync(NodePath.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  return newest ? `.claude/handoffs/${newest.f}` : null;
}

function spineDocs(workspaceRoot: string): string[] {
  const out: string[] = [];
  const docsDir = NodePath.join(workspaceRoot, "docs");
  if (!NodeFS.existsSync(docsDir)) return out;
  for (const f of NodeFS.readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .slice(0, 60)) {
    try {
      const head = NodeFS.readFileSync(NodePath.join(docsDir, f), "utf8").slice(0, 300);
      if (/context:\s*spine/.test(head)) out.push(`docs/${f}`);
    } catch {
      /* unreadable = not a candidate */
    }
  }
  return out;
}

// extras = caller-provided rels (doc packs, user-typed paths). Order:
// identity -> handoff -> spine -> extras; first occurrence wins the dedup.
export function docBricks(workspaceRoot: string, extras: readonly string[] = []): DocBrick[] {
  const rels: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string): void => {
    const key = rel.replace(/\\/g, "/");
    if (!seen.has(key)) {
      seen.add(key);
      rels.push(key);
    }
  };
  for (const rel of IDENTITY) {
    if (NodeFS.existsSync(NodePath.join(workspaceRoot, rel))) add(rel);
  }
  const handoff = newestHandoff(workspaceRoot);
  if (handoff) add(handoff);
  for (const rel of spineDocs(workspaceRoot)) add(rel);
  for (const rel of extras) {
    if (rel.trim()) add(rel.trim());
  }
  return rels.map((rel) => stat(workspaceRoot, rel));
}
