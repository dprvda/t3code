/**
 * Maps a subagent run's transcript blocks (parsed server-side from Claude
 * Code's on-disk JSONL) into the main chat's TimelineEntry model, so subagent
 * transcripts render with the exact same visuals — tool-group lines, inline
 * StyledFileDiff diffs, command rows — as the chat timeline.
 */
import type { SubagentTranscriptBlock } from "@t3tools/contracts";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";

/** Stable, ordered fallback for blocks whose JSONL line carried no timestamp. */
function syntheticIso(index: number): string {
  return `1970-01-01T00:00:00.${String(index % 1000).padStart(3, "0")}Z`;
}

export function deriveSubagentTimelineEntries(
  blocks: ReadonlyArray<SubagentTranscriptBlock>,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const workByToolUseId = new Map<string, WorkLogEntry>();
  let lastAt: string | null = null;
  for (const [index, block] of blocks.entries()) {
    const createdAt: string = block.at ?? lastAt ?? syntheticIso(index);
    lastAt = createdAt;
    const isToolResult =
      block.kind === "tool_result" || (block.kind === undefined && block.role === "tool");
    if (block.kind === "tool_use") {
      const entry: WorkLogEntry = {
        id: `sub-work-${index}`,
        createdAt,
        turnId: null,
        label: block.text.split("\n")[0] ?? block.text,
        tone: "tool",
        toolLifecycleStatus: "completed",
      };
      if (block.toolUseId !== undefined) {
        entry.toolCallId = block.toolUseId;
        workByToolUseId.set(block.toolUseId, entry);
      }
      if (block.command !== undefined) {
        entry.command = block.command;
      }
      if (block.fileEdit !== undefined) {
        entry.fileEdit = block.fileEdit;
        entry.itemType = "file_change";
        entry.changedFiles = [block.fileEdit.path];
      }
      entries.push({ id: entry.id, kind: "work", createdAt, entry });
      continue;
    }
    if (isToolResult && block.role === "tool") {
      // A result folds into its call's expandable detail; legacy servers
      // (no kind/toolUseId) fall through to a standalone tool row.
      const target =
        block.toolUseId !== undefined ? workByToolUseId.get(block.toolUseId) : undefined;
      if (target !== undefined) {
        if (target.detail === undefined) {
          target.detail = block.text;
        }
        continue;
      }
      const entry: WorkLogEntry = {
        id: `sub-work-${index}`,
        createdAt,
        turnId: null,
        label: block.text.split("\n")[0] ?? block.text,
        detail: block.text,
        tone: "tool",
        toolLifecycleStatus: "completed",
      };
      entries.push({ id: entry.id, kind: "work", createdAt, entry });
      continue;
    }
    const message: ChatMessage = {
      id: `sub-msg-${index}` as ChatMessage["id"],
      role: block.role === "user" ? "user" : "assistant",
      text: block.text,
      turnId: null,
      streaming: false,
      createdAt,
      updatedAt: createdAt,
    };
    entries.push({ id: message.id, kind: "message", createdAt, message });
  }
  return entries;
}
