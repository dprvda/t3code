import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, FileIcon, SendIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadMessages,
  useThreadShells,
} from "../../state/entities";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { useStudioTurnSender, type StudioTurnTarget } from "./useStudioTurn";

interface StudioSkill {
  readonly id: string;
  readonly name: string;
  readonly oneLiner: string;
  readonly youGiveMe: ReadonlyArray<string>;
  readonly hasIcon: boolean;
  readonly skillPath: string;
  readonly artifact: string;
}

interface StudioArtifact {
  readonly path: string;
  readonly name: string;
}

function parseSkills(payload: unknown): ReadonlyArray<StudioSkill> {
  if (typeof payload !== "object" || payload === null) return [];
  const skills = (payload as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return [];
  return skills.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const skill = entry as Record<string, unknown>;
    if (typeof skill.id !== "string" || typeof skill.name !== "string") return [];
    return [
      {
        id: skill.id,
        name: skill.name,
        oneLiner: typeof skill.oneLiner === "string" ? skill.oneLiner : "",
        youGiveMe: Array.isArray(skill.youGiveMe)
          ? skill.youGiveMe.filter((item): item is string => typeof item === "string")
          : [],
        hasIcon: skill.hasIcon === true,
        skillPath: typeof skill.skillPath === "string" ? skill.skillPath : "",
        artifact: typeof skill.artifact === "string" ? skill.artifact : "",
      },
    ];
  });
}

function parseArtifacts(payload: unknown): ReadonlyArray<StudioArtifact> {
  if (typeof payload !== "object" || payload === null) return [];
  const artifacts = (payload as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(artifacts)) return [];
  return artifacts.flatMap((entry) => {
    if (typeof entry === "string") {
      return [{ path: entry, name: entry.split("/").at(-1) ?? entry }];
    }
    if (typeof entry !== "object" || entry === null) return [];
    const artifact = entry as Record<string, unknown>;
    if (typeof artifact.path !== "string") return [];
    return [
      {
        path: artifact.path,
        name:
          typeof artifact.name === "string"
            ? artifact.name
            : (artifact.path.split("/").at(-1) ?? artifact.path),
      },
    ];
  });
}

export function StudioRoom({ projectId }: { readonly projectId: string }) {
  const projects = useProjects();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;

  if (project === null) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-background text-foreground">
        {bootstrapped ? (
          <>
            <p className="text-sm text-muted-foreground">We couldn't find this project.</p>
            <Link to="/studio" className="text-sm font-medium underline underline-offset-4">
              Back to all projects
            </Link>
          </>
        ) : (
          <Spinner className="size-5 text-muted-foreground" />
        )}
      </div>
    );
  }

  return <StudioRoomBody project={project} />;
}

function StudioRoomBody({ project }: { readonly project: EnvironmentProject }) {
  const threadShells = useThreadShells();
  const sendTurn = useStudioTurnSender();
  const [pendingThreadId, setPendingThreadId] = useState<ThreadId | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const projectThreads = useMemo(
    () =>
      threadShells
        .filter(
          (shell) =>
            shell.environmentId === project.environmentId &&
            shell.projectId === project.id &&
            shell.archivedAt === null,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [threadShells, project.environmentId, project.id],
  );

  const activeShell = projectThreads[0] ?? null;
  const activeThreadId = activeShell?.id ?? pendingThreadId;
  const threadRef = useMemo(
    () => (activeThreadId === null ? null : scopeThreadRef(project.environmentId, activeThreadId)),
    [project.environmentId, activeThreadId],
  );
  const messages = useThreadMessages(threadRef);
  const working = activeShell?.latestTurn?.state === "running";

  const turnTarget: StudioTurnTarget = useMemo(
    () => ({
      environmentId: project.environmentId,
      projectId: project.id,
      projectModelSelection: project.defaultModelSelection,
      thread:
        activeShell === null
          ? null
          : { id: activeShell.id, modelSelection: activeShell.modelSelection },
    }),
    [project.environmentId, project.id, project.defaultModelSelection, activeShell],
  );

  const send = async (text: string): Promise<boolean> => {
    setSendError(null);
    const result = await sendTurn(turnTarget, text);
    if (!result.ok) {
      setSendError(result.error);
      return false;
    }
    if (activeShell === null) {
      setPendingThreadId(result.threadId);
    }
    return true;
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <Link
          to="/studio"
          className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          All projects
        </Link>
        <span className="text-muted-foreground/50">/</span>
        <h1 className="truncate text-sm font-semibold">{project.title}</h1>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)_300px]">
        <SkillShelf onRun={send} workspaceRoot={project.workspaceRoot} />
        <Conversation messages={messages} working={working} sendError={sendError} onSend={send} />
        <ResultsPanel workspaceRoot={project.workspaceRoot} />
      </div>
    </div>
  );
}

function SkillShelf({
  onRun,
  workspaceRoot,
}: {
  readonly onRun: (text: string) => Promise<boolean>;
  readonly workspaceRoot: string;
}) {
  const [skills, setSkills] = useState<ReadonlyArray<StudioSkill> | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [runningId, setRunningId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const response = await fetch("/api/carbon/skills");
        if (!response.ok) throw new Error(`status ${response.status}`);
        const parsed = parseSkills(await response.json());
        if (!cancelled) setSkills(parsed);
      } catch {
        // Not available yet — quietly retry while the page is open.
        if (!cancelled) {
          setSkills((existing) => existing ?? []);
          timer = setTimeout(() => void load(), 15_000);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  const runSkill = async (skill: StudioSkill) => {
    const lines = [
      `Run the skill "${skill.id}": read ${skill.skillPath}/SKILL.md and follow it exactly.`,
      ...skill.youGiveMe.map(
        (label) => `${label}: ${(answers[`${skill.id}:${label}`] ?? "").trim()}`,
      ),
      `Produce the artifact under ${workspaceRoot}/artifacts/.`,
    ];
    setRunningId(skill.id);
    try {
      const sent = await onRun(lines.join("\n"));
      if (sent) setExpandedId(null);
    } finally {
      setRunningId(null);
    }
  };

  return (
    <aside className="min-h-0 overflow-y-auto border-r border-border p-4">
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Things I can do
      </h2>
      {skills === null ? (
        <div className="mt-6 flex justify-center">
          <Spinner className="size-4 text-muted-foreground" />
        </div>
      ) : skills.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Nothing on the shelf yet — check back soon.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {skills.map((skill) => {
            const expanded = expandedId === skill.id;
            return (
              <li
                key={skill.id}
                className="rounded-xl border border-border bg-card transition-colors"
              >
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-start gap-3 p-3 text-left"
                  onClick={() => setExpandedId(expanded ? null : skill.id)}
                >
                  {skill.hasIcon ? (
                    <img
                      src={`/api/carbon/skills/${encodeURIComponent(skill.id)}/icon`}
                      alt=""
                      className="mt-0.5 size-8 shrink-0 rounded-lg object-cover"
                    />
                  ) : (
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-sm font-semibold text-secondary-foreground">
                      {skill.name.charAt(0).toUpperCase()}
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{skill.name}</span>
                    {skill.oneLiner.length > 0 ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {skill.oneLiner}
                      </span>
                    ) : null}
                    {!expanded && skill.youGiveMe.length > 0 ? (
                      <span className="mt-1 block text-[11px] text-muted-foreground/80">
                        You give me: {skill.youGiveMe.join(", ")}
                      </span>
                    ) : null}
                  </span>
                </button>
                {expanded ? (
                  <div className="flex flex-col gap-2 border-t border-border/70 p-3">
                    {skill.youGiveMe.map((label) => (
                      <label
                        key={label}
                        className="flex flex-col gap-1 text-xs font-medium text-muted-foreground"
                      >
                        {label}
                        <Input
                          size="sm"
                          value={answers[`${skill.id}:${label}`] ?? ""}
                          onChange={(event) =>
                            setAnswers((existing) => ({
                              ...existing,
                              [`${skill.id}:${label}`]: event.target.value,
                            }))
                          }
                          className="rounded-lg border border-input bg-popover text-foreground"
                        />
                      </label>
                    ))}
                    <Button
                      size="sm"
                      className="self-end"
                      disabled={runningId !== null}
                      onClick={() => void runSkill(skill)}
                    >
                      {runningId === skill.id ? <Spinner className="size-3.5" /> : null}
                      Go
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

function Conversation({
  messages,
  working,
  sendError,
  onSend,
}: {
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
  }>;
  readonly working: boolean;
  readonly sendError: string | null;
  readonly onSend: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          message.text.trim().length > 0,
      ),
    [messages],
  );

  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null) {
      node.scrollTop = node.scrollHeight;
    }
  }, [visibleMessages, working]);

  const submit = async () => {
    const text = draft.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    try {
      const sent = await onSend(text);
      if (sent) setDraft("");
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="flex min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {visibleMessages.length === 0 && !working ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">
            Say hello, or run something from the shelf on the left.
          </p>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            {visibleMessages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap",
                  message.role === "user"
                    ? "self-end rounded-br-md bg-primary text-primary-foreground"
                    : "self-start rounded-bl-md bg-secondary text-secondary-foreground",
                )}
              >
                {message.text}
              </div>
            ))}
            {working ? (
              <div className="flex items-center gap-2 self-start px-1 text-sm text-muted-foreground">
                <Spinner className="size-3.5" />
                Working on it…
              </div>
            ) : null}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border px-6 py-4">
        {sendError !== null ? (
          <p className="mx-auto mb-2 max-w-2xl text-xs text-destructive-foreground">
            That didn't go through: {sendError}
          </p>
        ) : null}
        <form
          className="mx-auto flex max-w-2xl items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Type a message…"
            className="rounded-xl border border-input bg-popover"
            disabled={sending}
          />
          <Button type="submit" size="icon" disabled={sending || draft.trim().length === 0}>
            {sending ? <Spinner className="size-4" /> : <SendIcon />}
          </Button>
        </form>
      </div>
    </section>
  );
}

function ResultsPanel({ workspaceRoot }: { readonly workspaceRoot: string }) {
  const [artifacts, setArtifacts] = useState<ReadonlyArray<StudioArtifact>>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/carbon/artifacts?workspaceRoot=${encodeURIComponent(workspaceRoot)}`,
        );
        if (!response.ok) return;
        const parsed = parseArtifacts(await response.json());
        if (!cancelled) setArtifacts(parsed);
      } catch {
        // Endpoint not available yet — the empty state stands in.
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspaceRoot]);

  return (
    <aside className="min-h-0 overflow-y-auto border-l border-border p-4">
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Results</h2>
      {artifacts.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Nothing yet — run a skill.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {artifacts.map((artifact) => (
            <li key={artifact.path}>
              <a
                href={`/api/carbon/artifacts/file?path=${encodeURIComponent(artifact.path)}`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm transition-colors hover:bg-accent/50"
              >
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{artifact.name}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
