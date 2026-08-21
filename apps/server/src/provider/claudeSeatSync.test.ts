// @effect-diagnostics nodeBuiltinImport:off - exercises real filesystem scaffolding in a temp dir.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { discoverSeats, mergeTrustedProjects, syncSeatDirs } from "./claudeSeatSync.ts";

let home: string;

beforeEach(() => {
  home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "seat-sync-"));
});
afterEach(() => {
  NodeFS.rmSync(home, { recursive: true, force: true });
});

function seed(rel: string, content = ""): void {
  const p = NodePath.join(home, rel);
  NodeFS.mkdirSync(NodePath.dirname(p), { recursive: true });
  NodeFS.writeFileSync(p, content);
}

describe("discoverSeats", () => {
  it("counts only dirs holding .credentials.json, default first", () => {
    seed(".claude/.credentials.json", "{}");
    seed(".claude-acct2/.credentials.json", "{}");
    NodeFS.mkdirSync(NodePath.join(home, ".claude-acct3")); // scaffolded but not logged in
    expect(discoverSeats(home)).toEqual([
      { name: "acct1", configDir: null },
      { name: "acct2", configDir: NodePath.join(home, ".claude-acct2") },
    ]);
  });
});

describe("mergeTrustedProjects", () => {
  it("adds missing trust entries only, never overwrites the seat's own", () => {
    const { merged, added } = mergeTrustedProjects(
      { projects: { "/a": { trusted: true }, "/b": { trusted: true } } },
      { oauthAccount: { email: "seat@x" }, projects: { "/a": { trusted: false } } },
    );
    expect(added).toBe(1);
    expect((merged.projects as Record<string, unknown>)["/a"]).toEqual({ trusted: false });
    expect((merged.projects as Record<string, unknown>)["/b"]).toEqual({ trusted: true });
    expect(merged.oauthAccount).toEqual({ email: "seat@x" });
  });
});

describe("syncSeatDirs", () => {
  it("links shared dirs into seat dirs and merges trust", () => {
    seed(".claude/projects/proj-hash/transcript.jsonl", "t");
    seed(".claude/skills/s1/SKILL.md", "s");
    seed(".claude.json", JSON.stringify({ projects: { "/repo": { trusted: true } } }));
    seed(".claude-acct2/.credentials.json", "{}");
    seed(".claude-acct2/.claude.json", JSON.stringify({ projects: {} }));

    const notes = syncSeatDirs(home);
    const projLink = NodePath.join(home, ".claude-acct2", "projects");
    expect(NodeFS.lstatSync(projLink).isSymbolicLink()).toBe(true);
    expect(
      NodeFS.readFileSync(NodePath.join(projLink, "proj-hash", "transcript.jsonl"), "utf8"),
    ).toBe("t");
    const seatCfg = JSON.parse(
      NodeFS.readFileSync(NodePath.join(home, ".claude-acct2", ".claude.json"), "utf8"),
    ) as { projects: Record<string, unknown> };
    expect(seatCfg.projects["/repo"]).toEqual({ trusted: true });
    expect(notes.some((n) => n.includes("linked projects"))).toBe(true);
  });

  it("rescues a REAL seat projects dir into shared before linking — never deletes", () => {
    seed(".claude/projects/shared-proj/a.jsonl", "shared");
    seed(".claude-acct2/.credentials.json", "{}");
    seed(".claude-acct2/projects/seat-proj/b.jsonl", "seat-transcript");

    syncSeatDirs(home);
    // seat transcript survived, now reachable through the shared dir
    expect(
      NodeFS.readFileSync(
        NodePath.join(home, ".claude", "projects", "seat-proj", "b.jsonl"),
        "utf8",
      ),
    ).toBe("seat-transcript");
    expect(
      NodeFS.lstatSync(NodePath.join(home, ".claude-acct2", "projects")).isSymbolicLink(),
    ).toBe(true);
  });

  it("is idempotent: a second run changes nothing", () => {
    seed(".claude/projects/p/t.jsonl", "t");
    seed(".claude-acct2/.credentials.json", "{}");
    syncSeatDirs(home);
    expect(syncSeatDirs(home)).toEqual([]);
  });
});
