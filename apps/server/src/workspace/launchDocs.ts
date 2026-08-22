// @effect-diagnostics nodeBuiltinImport:off - pure filesystem scan of a workspace; callers run it inside Effect.
/**
 * Launch docs: the per-workspace selection of docs (and folders of docs)
 * injected as a read-first block into the FIRST message of every new
 * thread in that workspace. The selection lives in the repo at
 * `.t3/launch-docs.json` so the server and any external launch script
 * read the same source of truth:
 *
 *     { "version": 1, "include": ["README.md", "docs/planning/"] }
 *
 * Entries ending in `/` (or naming an existing directory) expand to every
 * `*.md` beneath them at injection time, so docs added later to a selected
 * folder are picked up automatically.
 *
 * @module launchDocs
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { DocBrick } from "./docBricks.ts";

export const LAUNCH_DOCS_FILE = ".t3/launch-docs.json";

/** Directory names never descended into when expanding folders or mapping docs. */
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  "tmp",
]);

// Dot-directories are skipped while descending, except .claude — handoffs
// and agent notes live there and are first-class injection candidates.
function descendInto(name: string): boolean {
  if (IGNORED_DIRS.has(name)) return false;
  if (name.startsWith(".")) return name === ".claude";
  return true;
}

function stat(workspaceRoot: string, rel: string): DocBrick {
  try {
    const chars = NodeFS.statSync(NodePath.join(workspaceRoot, rel)).size;
    return { rel, exists: true, chars, tokens: Math.round(chars / 4) };
  } catch {
    return { rel, exists: false, chars: 0, tokens: 0 };
  }
}

/** Recursive `*.md` rels under `startRel` (sorted), honoring the ignore rules. */
function markdownUnder(workspaceRoot: string, startRel: string, cap: number): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (out.length >= cap || depth > 8) return;
    const abs = NodePath.join(workspaceRoot, rel);
    let entries: NodeFS.Dirent[];
    try {
      entries = NodeFS.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (out.length >= cap) return;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (descendInto(entry.name)) walk(childRel, depth + 1);
      } else if (entry.name.endsWith(".md")) {
        out.push(childRel);
      }
    }
  };
  walk(startRel.replace(/\/+$/, ""), 0);
  return out;
}

/** The stored selection, `[]` on a missing or invalid file. Rels are normalized to `/`. */
export function readLaunchDocsInclude(workspaceRoot: string): string[] {
  try {
    const raw = NodeFS.readFileSync(NodePath.join(workspaceRoot, LAUNCH_DOCS_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const include = (parsed as { include?: unknown }).include;
    if (!Array.isArray(include)) return [];
    return include
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().replace(/\\/g, "/"))
      .filter((entry) => entry !== "");
  } catch {
    return [];
  }
}

/** Persist the selection (creates `.t3/`). Throws on filesystem failure. */
export function writeLaunchDocsInclude(workspaceRoot: string, include: readonly string[]): void {
  const file = NodePath.join(workspaceRoot, LAUNCH_DOCS_FILE);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const body = JSON.stringify({ version: 1, include }, null, 2);
  NodeFS.writeFileSync(file, `${body}\n`);
}

/**
 * Expand the selection into concrete docs: folder entries become their
 * markdown contents (recursive, sorted), file entries are stat'd as-is so
 * missing ones surface with `exists: false`. Deduped by rel, first wins.
 */
export function resolveLaunchDocs(workspaceRoot: string, include: readonly string[]): DocBrick[] {
  const rels: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string): void => {
    if (rels.length >= 200 || seen.has(rel)) return;
    seen.add(rel);
    rels.push(rel);
  };
  for (const entry of include) {
    const isFolder =
      entry.endsWith("/") ||
      (() => {
        try {
          return NodeFS.statSync(NodePath.join(workspaceRoot, entry)).isDirectory();
        } catch {
          return false;
        }
      })();
    if (isFolder) {
      for (const rel of markdownUnder(workspaceRoot, entry, 60)) add(rel);
    } else {
      add(entry);
    }
  }
  return rels.map((rel) => stat(workspaceRoot, rel));
}

/**
 * The read-first block for a new thread's first message — identical wording
 * to the composer docs pill — or `null` when the workspace has no stored
 * selection (or none of it exists on disk). Never throws: a broken config
 * must not block a launch.
 */
export function launchDocsPrefix(workspaceRoot: string): string | null {
  try {
    const include = readLaunchDocsInclude(workspaceRoot);
    if (include.length === 0) return null;
    const existing = resolveLaunchDocs(workspaceRoot, include).filter((brick) => brick.exists);
    if (existing.length === 0) return null;
    return `read these repo docs first, in order, before any other work:\n${existing
      .map((brick) => `- ${brick.rel}`)
      .join("\n")}\n\n`;
  } catch {
    return null;
  }
}

export type DocMapEntry = {
  readonly rel: string;
  readonly kind: "dir" | "doc";
  /** For docs: chars/4 estimate. For dirs: rollup of every doc beneath. */
  readonly tokens: number;
};

/**
 * The workspace's doc map: every markdown file (ignore rules above, capped
 * at 500) plus each ancestor directory that contains one, dir tokens rolled
 * up from their subtrees. Sorted by rel; clients build the tree from it.
 */
export function docMap(workspaceRoot: string): DocMapEntry[] {
  const docs = markdownUnder(workspaceRoot, "", 500).map((rel) => stat(workspaceRoot, rel));
  const dirTokens = new Map<string, number>();
  for (const doc of docs) {
    const segments = doc.rel.split("/").slice(0, -1);
    for (let i = 1; i <= segments.length; i++) {
      const dir = segments.slice(0, i).join("/");
      dirTokens.set(dir, (dirTokens.get(dir) ?? 0) + doc.tokens);
    }
  }
  const entries: DocMapEntry[] = [
    ...[...dirTokens.entries()].map(([rel, tokens]) => ({ rel, kind: "dir" as const, tokens })),
    ...docs.map((doc) => ({ rel: doc.rel, kind: "doc" as const, tokens: doc.tokens })),
  ];
  return entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
