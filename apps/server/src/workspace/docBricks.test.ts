// @effect-diagnostics nodeBuiltinImport:off - exercises the real filesystem in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { docBricks } from "./docBricks.ts";

let root: string;

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doc-bricks-"));
});
afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, content: string): void {
  const p = NodePath.join(root, rel);
  NodeFS.mkdirSync(NodePath.dirname(p), { recursive: true });
  NodeFS.writeFileSync(p, content);
}

describe("docBricks", () => {
  it("composes identity, newest handoff, spine docs, and extras — deduped, in order", () => {
    seed("README.md", "# readme\n");
    seed("docs/PLAN.md", "plan\n");
    seed("docs/spec.md", "---\ncontext: spine\n---\nspec body\n");
    seed("docs/other.md", "no marker\n");
    seed(".claude/handoffs/2026-01-01.md", "old handoff\n");
    seed(".claude/handoffs/2026-02-01.md", "new handoff\n");
    NodeFS.utimesSync(NodePath.join(root, ".claude/handoffs/2026-01-01.md"), 1, 1);

    const bricks = docBricks(root, ["docs/spec.md", "custom/notes.md", " "]);
    expect(bricks.map((b) => b.rel)).toEqual([
      "README.md",
      "docs/PLAN.md",
      ".claude/handoffs/2026-02-01.md",
      "docs/spec.md",
      "custom/notes.md",
    ]);
    const readme = bricks[0]!;
    expect(readme.exists).toBe(true);
    expect(readme.chars).toBe(9);
    expect(readme.tokens).toBe(2);
    const missing = bricks.at(-1)!;
    expect(missing).toEqual({ rel: "custom/notes.md", exists: false, chars: 0, tokens: 0 });
  });

  it("empty repo yields no bricks", () => {
    expect(docBricks(root)).toEqual([]);
  });
});
