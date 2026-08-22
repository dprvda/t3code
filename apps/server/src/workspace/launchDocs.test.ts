// @effect-diagnostics nodeBuiltinImport:off - exercises the real filesystem in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import {
  LAUNCH_DOCS_FILE,
  docMap,
  launchDocsPrefix,
  readLaunchDocsInclude,
  resolveLaunchDocs,
  writeLaunchDocsInclude,
} from "./launchDocs.ts";

let root: string;

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "launch-docs-"));
});
afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, content: string): void {
  const p = NodePath.join(root, rel);
  NodeFS.mkdirSync(NodePath.dirname(p), { recursive: true });
  NodeFS.writeFileSync(p, content);
}

describe("launch docs config", () => {
  it("write/read roundtrip normalizes and keeps order", () => {
    writeLaunchDocsInclude(root, ["README.md", "docs/planning/", " docs\\PLAN.md "]);
    expect(readLaunchDocsInclude(root)).toEqual(["README.md", "docs/planning/", "docs/PLAN.md"]);
    const raw = JSON.parse(NodeFS.readFileSync(NodePath.join(root, LAUNCH_DOCS_FILE), "utf8"));
    expect(raw.version).toBe(1);
  });

  it("missing or invalid config reads as empty", () => {
    expect(readLaunchDocsInclude(root)).toEqual([]);
    seed(LAUNCH_DOCS_FILE, "not json");
    expect(readLaunchDocsInclude(root)).toEqual([]);
    seed(LAUNCH_DOCS_FILE, JSON.stringify({ include: "docs/" }));
    expect(readLaunchDocsInclude(root)).toEqual([]);
    seed(LAUNCH_DOCS_FILE, JSON.stringify({ include: ["a.md", 7, "  "] }));
    expect(readLaunchDocsInclude(root)).toEqual(["a.md"]);
  });
});

describe("resolveLaunchDocs", () => {
  it("expands folders recursively, sorted, deduped against explicit files", () => {
    seed("docs/planning/b.md", "bb\n");
    seed("docs/planning/a.md", "aa\n");
    seed("docs/planning/deep/c.md", "cc\n");
    seed("docs/planning/skip.txt", "not markdown\n");
    seed("docs/top.md", "top\n");
    const bricks = resolveLaunchDocs(root, ["docs/planning/a.md", "docs/planning/", "gone.md"]);
    expect(bricks.map((b) => [b.rel, b.exists])).toEqual([
      ["docs/planning/a.md", true],
      ["docs/planning/b.md", true],
      ["docs/planning/deep/c.md", true],
      ["gone.md", false],
    ]);
  });

  it("folder entries without a trailing slash expand too; ignored dirs stay out", () => {
    seed("docs/a.md", "a\n");
    seed("docs/node_modules/x.md", "x\n");
    seed("docs/.hidden/y.md", "y\n");
    seed(".claude/handoffs/h.md", "h\n");
    expect(resolveLaunchDocs(root, ["docs", ".claude/handoffs/"]).map((b) => b.rel)).toEqual([
      "docs/a.md",
      ".claude/handoffs/h.md",
    ]);
  });
});

describe("launchDocsPrefix", () => {
  it("formats the composer read-first block from existing docs only", () => {
    seed("docs/a.md", "a\n");
    writeLaunchDocsInclude(root, ["docs/a.md", "missing.md"]);
    expect(launchDocsPrefix(root)).toBe(
      "read these repo docs first, in order, before any other work:\n- docs/a.md\n\n",
    );
  });

  it("null when unconfigured or nothing exists", () => {
    expect(launchDocsPrefix(root)).toBeNull();
    writeLaunchDocsInclude(root, ["missing.md"]);
    expect(launchDocsPrefix(root)).toBeNull();
  });
});

describe("docMap", () => {
  it("lists docs and ancestor dirs with token rollups, sorted", () => {
    seed("README.md", "12345678"); // 8 chars -> 2 tokens
    seed("docs/planning/plan.md", "1234"); // 1 token
    seed("docs/spec.md", "12345678"); // 2 tokens
    seed("node_modules/pkg/x.md", "ignored");
    expect(docMap(root)).toEqual([
      { rel: "README.md", kind: "doc", tokens: 2 },
      { rel: "docs", kind: "dir", tokens: 3 },
      { rel: "docs/planning", kind: "dir", tokens: 1 },
      { rel: "docs/planning/plan.md", kind: "doc", tokens: 1 },
      { rel: "docs/spec.md", kind: "doc", tokens: 2 },
    ]);
  });

  it("empty repo maps to nothing", () => {
    expect(docMap(root)).toEqual([]);
  });
});
