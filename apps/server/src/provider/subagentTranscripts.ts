// @effect-diagnostics nodeBuiltinImport:off - reads Claude Code's on-disk session store at the Node boundary; pure parsers exported for tests.
/**
 * Subagent transcript access: Claude Code writes every subagent (Agent tool)
 * run to `<configDir>/projects/<escaped-cwd>/<parentSessionId>/subagents/` as
 * `agent-<id>.jsonl` (the full conversation) plus `agent-<id>.meta.json`
 * (`{agentType, description, toolUseId, model, spawnDepth}`). This module
 * lists a workspace's runs across all parent sessions and renders one run's
 * transcript into simple display blocks.
 *
 * @module subagentTranscripts
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export type SubagentRunSummary = {
  /** file id without extension, e.g. "agent-a70505cc5df674a17" */
  readonly id: string;
  readonly parentSessionId: string;
  readonly agentType: string;
  readonly description: string;
  readonly model: string | null;
  readonly toolUseId: string | null;
  readonly modifiedAt: string;
  readonly sizeBytes: number;
};

export type SubagentTranscriptBlock = {
  readonly role: "user" | "assistant" | "tool";
  readonly text: string;
  /** ISO timestamp of the source JSONL line, when the line carried one. */
  readonly at?: string;
  readonly kind?: "text" | "tool_use" | "tool_result";
  readonly toolName?: string;
  /** Pairs a tool_use with its tool_result across lines. */
  readonly toolUseId?: string;
  /** Bash-style tools: the full command, for the timeline's command rows. */
  readonly command?: string;
  /** File-mutation tools (Edit/Write): the structured diff payload. */
  readonly fileEdit?: { readonly path: string; readonly oldText: string; readonly newText: string };
};

const AGENT_FILE_RE = /^agent-[A-Za-z0-9]+$/;
const MAX_BLOCKS = 400;
const MAX_BLOCK_CHARS = 4000;

/** Claude Code's project-dir escaping: every non-alphanumeric becomes "-". */
export function escapeProjectPath(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function projectRoot(configDir: string | null, cwd: string, home: string): string {
  const base = configDir ?? NodePath.join(home, ".claude");
  return NodePath.join(base, "projects", escapeProjectPath(cwd));
}

export function listSubagentRuns(
  configDir: string | null,
  cwd: string,
  home: string = NodeOS.homedir(),
): SubagentRunSummary[] {
  const root = projectRoot(configDir, cwd, home);
  let sessionDirs: string[];
  try {
    sessionDirs = NodeFS.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const runs: SubagentRunSummary[] = [];
  for (const sessionId of sessionDirs) {
    const dir = NodePath.join(root, sessionId, "subagents");
    let files: string[];
    try {
      files = NodeFS.readdirSync(dir).filter((name) => name.endsWith(".meta.json"));
    } catch {
      continue;
    }
    for (const metaFile of files) {
      const id = metaFile.replace(/\.meta\.json$/, "");
      if (!AGENT_FILE_RE.test(id)) continue;
      try {
        const meta = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, metaFile), "utf8")) as {
          agentType?: string;
          description?: string;
          model?: string;
          toolUseId?: string;
        };
        const transcriptPath = NodePath.join(dir, `${id}.jsonl`);
        const stat = NodeFS.statSync(transcriptPath);
        runs.push({
          id,
          parentSessionId: sessionId,
          agentType: meta.agentType ?? "agent",
          description: meta.description ?? id,
          model: meta.model ?? null,
          toolUseId: meta.toolUseId ?? null,
          modifiedAt: stat.mtime.toISOString(),
          sizeBytes: stat.size,
        });
      } catch {
        /* meta without transcript (still starting) or unreadable — skip */
      }
    }
  }
  runs.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return runs;
}

type SessionLine = {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

function clip(text: string): string {
  return text.length > MAX_BLOCK_CHARS ? `${text.slice(0, MAX_BLOCK_CHARS)}\n… [clipped]` : text;
}

/** Readable one-line caption for a tool call, matching the chat's vocabulary. */
function toolCaption(name: string, input: Record<string, unknown>): string {
  const path = typeof input["file_path"] === "string" ? input["file_path"] : null;
  if (path !== null && (name === "Edit" || name === "Write" || name === "Read")) {
    return `${name}: ${path}`;
  }
  if (typeof input["command"] === "string") {
    return `${name}: ${input["command"].split("\n")[0] ?? ""}`;
  }
  if (typeof input["pattern"] === "string") {
    return `${name}: ${input["pattern"]}`;
  }
  const compact = JSON.stringify(input);
  return compact === "{}" ? name : `${name}: ${clipTo(compact, 200)}`;
}

function clipTo(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Flatten one session-JSONL line's content into display blocks. */
export function blocksFromLine(line: SessionLine): SubagentTranscriptBlock[] {
  if (line.type !== "user" && line.type !== "assistant") return [];
  const role = line.type;
  const at = typeof line.timestamp === "string" ? line.timestamp : undefined;
  const stamp = <T extends SubagentTranscriptBlock>(block: T): T =>
    at === undefined ? block : { ...block, at };
  const content = line.message?.content;
  if (typeof content === "string") {
    return content.trim().length > 0 ? [stamp({ role, text: clip(content), kind: "text" })] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: SubagentTranscriptBlock[] = [];
  for (const part of content as Array<Record<string, unknown>>) {
    if (part["type"] === "text" && typeof part["text"] === "string" && part["text"].trim()) {
      blocks.push(stamp({ role, text: clip(part["text"]), kind: "text" }));
    } else if (part["type"] === "tool_use") {
      const name = typeof part["name"] === "string" ? part["name"] : "tool";
      const input =
        part["input"] !== null && typeof part["input"] === "object"
          ? (part["input"] as Record<string, unknown>)
          : {};
      const toolUseId = typeof part["id"] === "string" ? part["id"] : undefined;
      const block: SubagentTranscriptBlock = stamp({
        role: "tool",
        text: clip(toolCaption(name, input)),
        kind: "tool_use",
        toolName: name,
        ...(toolUseId !== undefined ? { toolUseId } : {}),
      });
      const filePath = typeof input["file_path"] === "string" ? input["file_path"] : null;
      if (name === "Edit" && filePath !== null) {
        blocks.push({
          ...block,
          fileEdit: {
            path: filePath,
            oldText: typeof input["old_string"] === "string" ? input["old_string"] : "",
            newText: typeof input["new_string"] === "string" ? input["new_string"] : "",
          },
        });
      } else if (name === "Write" && filePath !== null) {
        blocks.push({
          ...block,
          fileEdit: {
            path: filePath,
            oldText: "",
            newText: typeof input["content"] === "string" ? input["content"] : "",
          },
        });
      } else if (typeof input["command"] === "string") {
        blocks.push({ ...block, command: clip(input["command"]) });
      } else {
        blocks.push(block);
      }
    } else if (part["type"] === "tool_result") {
      const raw = part["content"];
      const text =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? raw
                .map((entry) =>
                  typeof (entry as Record<string, unknown>)["text"] === "string"
                    ? String((entry as Record<string, unknown>)["text"])
                    : "",
                )
                .join("\n")
            : "";
      const toolUseId = typeof part["tool_use_id"] === "string" ? part["tool_use_id"] : undefined;
      if (text.trim().length > 0) {
        blocks.push(
          stamp({
            role: "tool",
            text: clip(text),
            kind: "tool_result",
            ...(toolUseId !== undefined ? { toolUseId } : {}),
          }),
        );
      }
    }
  }
  return blocks;
}

export function readSubagentTranscript(
  configDir: string | null,
  cwd: string,
  parentSessionId: string,
  agentFileId: string,
  home: string = NodeOS.homedir(),
): SubagentTranscriptBlock[] | null {
  if (!AGENT_FILE_RE.test(agentFileId)) throw new Error(`bad agent id: ${agentFileId}`);
  if (!/^[A-Za-z0-9-]+$/.test(parentSessionId)) {
    throw new Error(`bad session id: ${parentSessionId}`);
  }
  const path = NodePath.join(
    projectRoot(configDir, cwd, home),
    parentSessionId,
    "subagents",
    `${agentFileId}.jsonl`,
  );
  let raw: string;
  try {
    raw = NodeFS.readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const blocks: SubagentTranscriptBlock[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      blocks.push(...blocksFromLine(JSON.parse(line) as SessionLine));
    } catch {
      /* partial write of the last line while the agent still runs */
    }
    if (blocks.length >= MAX_BLOCKS) break;
  }
  return blocks.slice(0, MAX_BLOCKS);
}
