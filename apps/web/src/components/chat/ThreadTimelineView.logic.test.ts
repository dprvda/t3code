import { describe, expect, it } from "vite-plus/test";

import { deriveSubagentTimelineEntries } from "./ThreadTimelineView.logic";

describe("deriveSubagentTimelineEntries", () => {
  it("maps text blocks to messages and tool_use blocks to work entries", () => {
    const entries = deriveSubagentTimelineEntries([
      { role: "user", text: "find the bug", kind: "text", at: "2026-08-22T10:00:00.000Z" },
      {
        role: "tool",
        text: "Edit: /repo/a.ts",
        kind: "tool_use",
        toolName: "Edit",
        toolUseId: "toolu_1",
        at: "2026-08-22T10:00:01.000Z",
        fileEdit: { path: "/repo/a.ts", oldText: "x", newText: "y" },
      },
      { role: "assistant", text: "done", kind: "text", at: "2026-08-22T10:00:02.000Z" },
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["message", "work", "message"]);
    const [user, work, assistant] = entries;
    expect(user?.kind === "message" && user.message.role).toBe("user");
    expect(assistant?.kind === "message" && assistant.message.role).toBe("assistant");
    if (work?.kind !== "work") throw new Error("expected work entry");
    expect(work.entry.label).toBe("Edit: /repo/a.ts");
    expect(work.entry.itemType).toBe("file_change");
    expect(work.entry.fileEdit).toEqual({ path: "/repo/a.ts", oldText: "x", newText: "y" });
    expect(work.entry.changedFiles).toEqual(["/repo/a.ts"]);
    expect(work.entry.toolLifecycleStatus).toBe("completed");
  });

  it("folds a tool_result into its tool_use's detail; orphans stand alone", () => {
    const entries = deriveSubagentTimelineEntries([
      {
        role: "tool",
        text: "Bash: ls",
        kind: "tool_use",
        toolName: "Bash",
        toolUseId: "toolu_2",
        command: "ls",
      },
      { role: "tool", text: "total 0", kind: "tool_result", toolUseId: "toolu_2" },
      { role: "tool", text: "orphan output", kind: "tool_result", toolUseId: "toolu_missing" },
    ]);
    expect(entries).toHaveLength(2);
    const [bash, orphan] = entries;
    if (bash?.kind !== "work" || orphan?.kind !== "work") throw new Error("expected work rows");
    expect(bash.entry.command).toBe("ls");
    expect(bash.entry.detail).toBe("total 0");
    expect(orphan.entry.detail).toBe("orphan output");
  });

  it("legacy blocks without kind render: tool rows standalone, text as messages", () => {
    const entries = deriveSubagentTimelineEntries([
      { role: "user", text: "prompt" },
      { role: "tool", text: "▸ Bash: ls" },
      { role: "assistant", text: "answer" },
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["message", "work", "message"]);
  });

  it("keeps original order with synthetic timestamps when at is missing", () => {
    const entries = deriveSubagentTimelineEntries([
      { role: "user", text: "a" },
      { role: "assistant", text: "b" },
      { role: "assistant", text: "c", at: "2026-08-22T10:00:00.000Z" },
      { role: "assistant", text: "d" },
    ]);
    const stamps = entries.map((entry) => entry.createdAt);
    const sorted = [...stamps].sort((left, right) => left.localeCompare(right));
    expect(stamps).toEqual(sorted);
  });
});
