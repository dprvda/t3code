// @effect-diagnostics nodeBuiltinImport:off - exercises the real filesystem in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import {
  blocksFromLine,
  escapeProjectPath,
  listSubagentRuns,
  readSubagentTranscript,
} from "./subagentTranscripts.ts";

let home: string;
const CWD = "/home/user/my.project";

beforeEach(() => {
  home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "subagent-transcripts-"));
});
afterEach(() => {
  NodeFS.rmSync(home, { recursive: true, force: true });
});

function seedRun(sessionId: string, agentId: string, meta: object, lines: object[]): void {
  const dir = NodePath.join(
    home,
    ".claude",
    "projects",
    escapeProjectPath(CWD),
    sessionId,
    "subagents",
  );
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, `${agentId}.meta.json`), JSON.stringify(meta));
  NodeFS.writeFileSync(
    NodePath.join(dir, `${agentId}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n"),
  );
}

describe("escapeProjectPath", () => {
  it("maps every non-alphanumeric to a dash, matching Claude Code's store", () => {
    expect(escapeProjectPath("/home/dprvd/scratch/t3m0-project")).toBe(
      "-home-dprvd-scratch-t3m0-project",
    );
    expect(escapeProjectPath("/home/user/my.project")).toBe("-home-user-my-project");
  });
});

describe("listSubagentRuns", () => {
  it("collects runs across parent sessions, newest first, with meta", () => {
    seedRun(
      "session-a",
      "agent-aaa1",
      { agentType: "sol", description: "First", model: "gpt-5.6-sol", toolUseId: "call_1" },
      [{ type: "user", message: { role: "user", content: "hi" } }],
    );
    seedRun("session-b", "agent-bbb2", { agentType: "general-purpose", description: "Second" }, [
      { type: "user", message: { role: "user", content: "yo" } },
    ]);
    NodeFS.utimesSync(
      NodePath.join(
        home,
        ".claude",
        "projects",
        escapeProjectPath(CWD),
        "session-a",
        "subagents",
        "agent-aaa1.jsonl",
      ),
      1,
      1,
    );
    const runs = listSubagentRuns(null, CWD, home);
    expect(runs.map((run) => run.id)).toEqual(["agent-bbb2", "agent-aaa1"]);
    expect(runs[1]).toMatchObject({
      agentType: "sol",
      description: "First",
      model: "gpt-5.6-sol",
      toolUseId: "call_1",
      parentSessionId: "session-a",
    });
  });

  it("missing root yields empty", () => {
    expect(listSubagentRuns(null, "/nowhere/at/all", home)).toEqual([]);
  });
});

describe("readSubagentTranscript", () => {
  it("renders text, tool_use and tool_result blocks in order", () => {
    seedRun("session-a", "agent-ccc3", { description: "Run" }, [
      { type: "user", message: { role: "user", content: "Do the thing." } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "file-a\nfile-b" }] },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      },
      { type: "attachment" },
    ]);
    const blocks = readSubagentTranscript(null, CWD, "session-a", "agent-ccc3", home);
    expect(blocks).toEqual([
      { role: "user", text: "Do the thing.", kind: "text" },
      { role: "tool", text: "Bash: ls", kind: "tool_use", toolName: "Bash", command: "ls" },
      { role: "tool", text: "file-a\nfile-b", kind: "tool_result" },
      { role: "assistant", text: "Done.", kind: "text" },
    ]);
  });

  it("rejects malicious ids and returns null for missing transcripts", () => {
    expect(() => readSubagentTranscript(null, CWD, "session-a", "../evil", home)).toThrow(
      /bad agent id/,
    );
    expect(() => readSubagentTranscript(null, CWD, "..", "agent-abc", home)).toThrow(
      /bad session id/,
    );
    expect(readSubagentTranscript(null, CWD, "session-x", "agent-abc", home)).toBeNull();
  });

  it("thinking blocks are omitted", () => {
    expect(
      blocksFromLine({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }] },
      }),
    ).toEqual([]);
  });
});

describe("blocksFromLine structured output", () => {
  it("maps Edit tool_use to a fileEdit block with a readable caption and timestamp", () => {
    expect(
      blocksFromLine({
        type: "assistant",
        timestamp: "2026-08-22T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Edit",
              input: { file_path: "/repo/a.ts", old_string: "x", new_string: "y" },
            },
          ],
        },
      }),
    ).toEqual([
      {
        role: "tool",
        text: "Edit: /repo/a.ts",
        at: "2026-08-22T10:00:00.000Z",
        kind: "tool_use",
        toolName: "Edit",
        toolUseId: "toolu_1",
        fileEdit: { path: "/repo/a.ts", oldText: "x", newText: "y" },
      },
    ]);
  });

  it("maps Write tool_use to a whole-file fileEdit", () => {
    expect(
      blocksFromLine({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_2",
              name: "Write",
              input: { file_path: "/repo/b.md", content: "hello" },
            },
          ],
        },
      }),
    ).toEqual([
      {
        role: "tool",
        text: "Write: /repo/b.md",
        kind: "tool_use",
        toolName: "Write",
        toolUseId: "toolu_2",
        fileEdit: { path: "/repo/b.md", oldText: "", newText: "hello" },
      },
    ]);
  });

  it("pairs tool_result with its call via toolUseId; multi-line commands keep only line one in the caption", () => {
    expect(
      blocksFromLine({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "ls -la\nwc -l" } },
          ],
        },
      }),
    ).toEqual([
      {
        role: "tool",
        text: "Bash: ls -la",
        kind: "tool_use",
        toolName: "Bash",
        toolUseId: "toolu_3",
        command: "ls -la\nwc -l",
      },
    ]);
    expect(
      blocksFromLine({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "total 0" }],
        },
      }),
    ).toEqual([{ role: "tool", text: "total 0", kind: "tool_result", toolUseId: "toolu_3" }]);
  });

  it("unknown tools fall back to a compact input preview", () => {
    expect(
      blocksFromLine({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_4", name: "Mystery", input: { alpha: 1 } }],
        },
      }),
    ).toEqual([
      {
        role: "tool",
        text: 'Mystery: {"alpha":1}',
        kind: "tool_use",
        toolName: "Mystery",
        toolUseId: "toolu_4",
      },
    ]);
  });
});
