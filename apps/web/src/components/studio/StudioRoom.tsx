import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { OrchestrationMessage, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  AppWindowIcon,
  CalendarIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  ImageIcon,
  LinkIcon,
  PackageOpenIcon,
  SparklesIcon,
  UploadCloudIcon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";

import { cn } from "../../lib/utils";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadMessages,
  useThreadShells,
} from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Field, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { HideWorkspaceChrome } from "./StudioSurface";
import { useStudioTurnSender, type StudioTurnTarget } from "./useStudioTurn";

interface StudioSkill {
  readonly id: string;
  readonly name: string;
  readonly oneLiner: string;
  readonly youGiveMe: ReadonlyArray<string>;
  readonly hasIcon: boolean;
  readonly skillPath: string;
}

interface StudioFileEntry {
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number | null;
  readonly modifiedAt: string | null;
}

interface StudioWorkspaceEntry {
  readonly name: string;
  readonly kind: "folder" | "file";
}

interface ProjectVitals {
  readonly client: string | null;
  readonly what: string | null;
  readonly links: ReadonlyArray<string>;
  readonly deadline: string | null;
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
      },
    ];
  });
}

function parseFileEntries(
  payload: unknown,
  key: "artifacts" | "uploads",
): ReadonlyArray<StudioFileEntry> {
  if (typeof payload !== "object" || payload === null) return [];
  const list = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string") return [];
    return [
      {
        path: file.path,
        name:
          typeof file.name === "string" ? file.name : (file.path.split("/").at(-1) ?? file.path),
        sizeBytes: typeof file.sizeBytes === "number" ? file.sizeBytes : null,
        modifiedAt: typeof file.modifiedAt === "string" ? file.modifiedAt : null,
      },
    ];
  });
}

function parseWorkspaceEntries(payload: unknown): ReadonlyArray<StudioWorkspaceEntry> {
  if (typeof payload !== "object" || payload === null) return [];
  const entries = (payload as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.name !== "string") return [];
    return [{ name: item.name, kind: item.kind === "folder" ? "folder" : "file" } as const];
  });
}

/** The wizard writes the intake as the first message; read the vitals back out of it. */
function parseVitals(messages: ReadonlyArray<OrchestrationMessage>): ProjectVitals | null {
  const intake = messages.find(
    (message) => message.role === "user" && message.text.startsWith("New project for "),
  );
  if (intake === undefined) return null;
  const text = intake.text.replaceAll("\n", " ");
  const client = /^New project for (.+?):/.exec(text)?.[1]?.trim() ?? null;
  const deadline = /Deadline:\s*(.+?)\.?\s*$/.exec(text)?.[1]?.trim() ?? null;
  const linksSegment = /Links:\s*(.+?)(?=\s*Deadline:|\s*$)/.exec(text)?.[1] ?? "";
  const links = [...linksSegment.matchAll(/https?:\/\/\S+/g)].map((match) =>
    match[0].replace(/[.,]+$/, ""),
  );
  let what: string | null = null;
  const colonIndex = text.indexOf(":");
  if (client !== null && colonIndex !== -1) {
    what =
      text
        .slice(colonIndex + 1)
        .split(/\s+Links:|\s+Deadline:/)[0]
        ?.trim()
        .replace(/\.$/, "") ?? null;
  }
  return { client, what, links, deadline };
}

function usePolledJson<T>(
  url: string,
  parse: (payload: unknown) => T,
  intervalMs: number,
): T | null {
  const [data, setData] = useState<T | null>(null);
  const parseRef = useRef(parse);
  parseRef.current = parse;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) return;
        const parsed = parseRef.current(await response.json());
        if (!cancelled) setData(parsed);
      } catch {
        // Endpoint unreachable — keep the last known state.
      }
    };
    void load();
    const timer = setInterval(() => void load(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url, intervalMs]);

  return data;
}

const FILE_ICON_BY_EXTENSION: Record<string, ComponentType<{ className?: string }>> = {
  html: AppWindowIcon,
  htm: AppWindowIcon,
  md: FileTextIcon,
  txt: FileTextIcon,
  pdf: FileTextIcon,
  png: ImageIcon,
  jpg: ImageIcon,
  jpeg: ImageIcon,
  gif: ImageIcon,
  webp: ImageIcon,
  svg: ImageIcon,
  mov: ImageIcon,
  mp4: ImageIcon,
};

function fileExtension(path: string): string {
  return path.split(".").at(-1)?.toLowerCase() ?? "";
}

function fileIconFor(path: string): ComponentType<{ className?: string }> {
  return FILE_ICON_BY_EXTENSION[fileExtension(path)] ?? FileIcon;
}

function artifactFileUrl(path: string): string {
  return `/api/carbon/artifacts/file?path=${encodeURIComponent(path)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const MONOGRAM_GRADIENTS = [
  "from-sky-500/85 to-indigo-500/85",
  "from-emerald-500/85 to-teal-500/85",
  "from-amber-500/85 to-orange-500/85",
  "from-rose-500/85 to-pink-500/85",
  "from-violet-500/85 to-purple-500/85",
  "from-cyan-500/85 to-blue-500/85",
];

function monogramGradient(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return MONOGRAM_GRADIENTS[Math.abs(hash) % MONOGRAM_GRADIENTS.length]!;
}

export function StudioRoom({ projectId }: { readonly projectId: string }) {
  const projects = useProjects();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;

  if (project === null) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background text-foreground">
        <HideWorkspaceChrome />
        {bootstrapped ? (
          <>
            <p className="text-sm text-muted-foreground">We couldn't find this project.</p>
            <Button variant="outline" render={<Link to="/studio" />}>
              <ArrowLeftIcon />
              All projects
            </Button>
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
  const vitals = useMemo(() => parseVitals(messages), [messages]);

  const workspaceQuery = encodeURIComponent(project.workspaceRoot);
  const artifacts =
    usePolledJson(
      `/api/carbon/artifacts?workspaceRoot=${workspaceQuery}`,
      (payload) => parseFileEntries(payload, "artifacts"),
      5_000,
    ) ?? [];
  const [uploadsRefreshKey, setUploadsRefreshKey] = useState(0);
  const uploads =
    usePolledJson(
      `/api/carbon/uploads?workspaceRoot=${workspaceQuery}&r=${uploadsRefreshKey}`,
      (payload) => parseFileEntries(payload, "uploads"),
      7_000,
    ) ?? [];
  const workspaceEntries =
    usePolledJson(
      `/api/carbon/workspace?workspaceRoot=${workspaceQuery}`,
      parseWorkspaceEntries,
      15_000,
    ) ?? [];

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
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <HideWorkspaceChrome />
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Button variant="ghost-muted" size="sm" render={<Link to="/studio" />}>
          <ArrowLeftIcon />
          All projects
        </Button>
        <span className="h-4 w-px shrink-0 bg-border/70" aria-hidden />
        <div className="flex min-w-0 items-center gap-2">
          <ProjectFavicon
            environmentId={project.environmentId}
            cwd={project.workspaceRoot}
            faviconPath={project.faviconPath}
            className="size-4"
          />
          <h1 className="truncate text-sm font-semibold">{project.title}</h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {working ? (
            <span className="flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Working on it…
            </span>
          ) : null}
          {vitals?.deadline ? (
            <span className="flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
              <CalendarIcon className="size-3" />
              Due {vitals.deadline}
            </span>
          ) : null}
        </div>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_320px] xl:grid-cols-[320px_minmax(0,1fr)_360px]">
        <aside className="flex min-h-0 flex-col border-r border-border/60">
          <PaneHeader>Things I can do</PaneHeader>
          <ScrollArea scrollFade className="min-h-0 flex-1">
            <div className="flex flex-col gap-2.5 p-3">
              <SkillLibrary onRun={send} workspaceRoot={project.workspaceRoot} />
            </div>
          </ScrollArea>
        </aside>
        <Conversation
          messages={messages}
          working={working}
          sendError={sendError}
          onSend={send}
          markdownCwd={project.workspaceRoot}
          threadRef={threadRef}
          artifacts={artifacts}
        />
        <aside className="flex min-h-0 flex-col border-l border-border/60">
          <ScrollArea scrollFade className="min-h-0 flex-1">
            <div className="flex flex-col">
              <RailSection title="Overview">
                <OverviewSection vitals={vitals} workspaceEntries={workspaceEntries} />
              </RailSection>
              <RailSection title="Files">
                <FilesSection
                  workspaceRoot={project.workspaceRoot}
                  uploads={uploads}
                  onUploaded={() => setUploadsRefreshKey((key) => key + 1)}
                />
              </RailSection>
              <RailSection title="Results">
                <ResultsSection artifacts={artifacts} />
              </RailSection>
            </div>
          </ScrollArea>
        </aside>
      </div>
    </div>
  );
}

function PaneHeader({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center border-b border-border/40 px-4 text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
      {children}
    </div>
  );
}

function RailSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="border-b border-border/40 last:border-b-0">
      <div className="sticky top-0 z-10 flex h-10 items-center bg-background px-4 text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
        {title}
      </div>
      <div className="flex flex-col gap-2.5 px-3 pb-4">{children}</div>
    </section>
  );
}

function EmptyHint({
  icon: Icon,
  children,
}: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-6 text-center">
      <Icon className="size-4 text-muted-foreground/70" />
      <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

function OverviewSection({
  vitals,
  workspaceEntries,
}: {
  readonly vitals: ProjectVitals | null;
  readonly workspaceEntries: ReadonlyArray<StudioWorkspaceEntry>;
}) {
  return (
    <>
      {vitals === null ? (
        <EmptyHint icon={FileTextIcon}>
          Project details show up here after the first message.
        </EmptyHint>
      ) : (
        <Card className="gap-2.5 rounded-xl p-3.5">
          {vitals.client !== null ? <VitalRow label="Client" value={vitals.client} /> : null}
          {vitals.what !== null ? <VitalRow label="Making" value={vitals.what} /> : null}
          {vitals.deadline !== null ? <VitalRow label="Due" value={vitals.deadline} /> : null}
          {vitals.links.length > 0 ? (
            <div className="flex items-start gap-2">
              <span className="w-14 shrink-0 pt-0.5 text-xs text-muted-foreground">Links</span>
              <span className="flex min-w-0 flex-wrap gap-1.5">
                {vitals.links.map((link) => (
                  <a
                    key={link}
                    href={link}
                    target="_blank"
                    rel="noreferrer"
                    className="flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-xs text-foreground transition-colors hover:border-border hover:bg-accent/50"
                  >
                    <LinkIcon className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{new URL(link).hostname}</span>
                  </a>
                ))}
              </span>
            </div>
          ) : null}
        </Card>
      )}
      {workspaceEntries.length > 0 ? (
        <Card className="gap-1.5 rounded-xl p-3.5">
          <p className="mb-1 text-xs text-muted-foreground">In the project folder</p>
          {workspaceEntries.map((entry) => (
            <div key={entry.name} className="flex items-center gap-2 text-sm">
              {entry.kind === "folder" ? (
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{entry.name}</span>
            </div>
          ))}
        </Card>
      ) : null}
    </>
  );
}

function VitalRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-14 shrink-0 pt-0.5 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 text-sm leading-snug">{value}</span>
    </div>
  );
}

function FilesSection({
  workspaceRoot,
  uploads,
  onUploaded,
}: {
  readonly workspaceRoot: string;
  readonly uploads: ReadonlyArray<StudioFileEntry>;
  readonly onUploaded: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const uploadFiles = useCallback(
    async (files: ReadonlyArray<File>) => {
      if (files.length === 0) return;
      setUploadingCount((count) => count + files.length);
      setUploadError(null);
      try {
        for (const file of files) {
          const response = await fetch(
            `/api/carbon/upload?workspaceRoot=${encodeURIComponent(workspaceRoot)}&name=${encodeURIComponent(file.name)}`,
            { method: "POST", body: file },
          );
          if (!response.ok) {
            setUploadError(`Couldn't add ${file.name}.`);
          }
        }
      } catch {
        setUploadError("Upload didn't go through — try again.");
      } finally {
        setUploadingCount((count) => Math.max(0, count - files.length));
        onUploaded();
      }
    },
    [workspaceRoot, onUploaded],
  );

  return (
    <>
      <label
        className={cn(
          "flex cursor-pointer flex-col items-center gap-1 rounded-xl border border-dashed border-border bg-muted/20 px-4 py-5 text-center transition-colors hover:border-ring/60 hover:bg-muted/40",
          dragOver && "border-ring bg-accent/40",
        )}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          void uploadFiles([...event.dataTransfer.files]);
        }}
      >
        <UploadCloudIcon className="size-5 text-muted-foreground" />
        <span className="text-xs font-medium">Drop files here</span>
        <span className="text-[11px] text-muted-foreground">or click to browse</span>
        <input
          type="file"
          multiple
          hidden
          onChange={(event) => {
            void uploadFiles([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
      </label>
      {uploadingCount > 0 ? (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Adding {uploadingCount === 1 ? "file" : `${uploadingCount} files`}…
        </div>
      ) : null}
      {uploadError !== null ? (
        <p className="px-1 text-xs text-destructive-foreground">{uploadError}</p>
      ) : null}
      {uploads.length > 0 ? (
        <Card className="gap-0 divide-y divide-border/50 rounded-xl p-0">
          {uploads.map((upload) => {
            const Icon = fileIconFor(upload.path);
            return (
              <div key={upload.path} className="flex items-center gap-2.5 px-3 py-2">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{upload.name}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {[
                      upload.sizeBytes !== null ? formatBytes(upload.sizeBytes) : null,
                      upload.modifiedAt !== null
                        ? formatRelativeTimeLabel(upload.modifiedAt)
                        : null,
                    ]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </span>
                </span>
              </div>
            );
          })}
        </Card>
      ) : null}
    </>
  );
}

function ResultsSection({ artifacts }: { readonly artifacts: ReadonlyArray<StudioFileEntry> }) {
  if (artifacts.length === 0) {
    return <EmptyHint icon={PackageOpenIcon}>Nothing yet — run a skill.</EmptyHint>;
  }
  return (
    <>
      {artifacts.map((artifact) => {
        const Icon = fileIconFor(artifact.path);
        const extension = fileExtension(artifact.path);
        const isHtml = extension === "html" || extension === "htm";
        const url = artifactFileUrl(artifact.path);
        return (
          <Card
            key={artifact.path}
            className="gap-2.5 rounded-xl p-3 transition-[box-shadow,border-color] duration-150 hover:border-border hover:shadow-sm"
          >
            {isHtml ? (
              <div className="pointer-events-none h-24 overflow-hidden rounded-lg border border-border/60 bg-background">
                <iframe
                  src={url}
                  sandbox=""
                  tabIndex={-1}
                  loading="lazy"
                  title={`Preview of ${artifact.name}`}
                  className="h-48 w-[200%] origin-top-left scale-50"
                />
              </div>
            ) : null}
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
                <Icon className="size-4 text-muted-foreground" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{artifact.name}</span>
                {artifact.modifiedAt !== null ? (
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTimeLabel(artifact.modifiedAt)}
                  </span>
                ) : null}
              </span>
              <Button
                size="xs"
                variant="outline"
                render={<a href={url} target="_blank" rel="noreferrer" />}
              >
                Open
              </Button>
            </div>
          </Card>
        );
      })}
    </>
  );
}

function SkillIconTile({ skill }: { readonly skill: StudioSkill }) {
  const [iconFailed, setIconFailed] = useState(false);
  if (skill.hasIcon && !iconFailed) {
    return (
      <img
        src={`/api/carbon/skills/${encodeURIComponent(skill.id)}/icon`}
        alt=""
        onError={() => setIconFailed(true)}
        className="size-11 shrink-0 rounded-xl border border-border/60 object-cover"
      />
    );
  }
  return (
    <span
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-base font-semibold text-white",
        monogramGradient(skill.id),
      )}
    >
      {skill.name.charAt(0).toUpperCase()}
    </span>
  );
}

function SkillLibrary({
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

  if (skills === null) {
    return (
      <div className="flex justify-center py-10">
        <Spinner className="size-4 text-muted-foreground" />
      </div>
    );
  }
  if (skills.length === 0) {
    return (
      <EmptyHint icon={WandSparklesIcon}>Nothing on the shelf yet — check back soon.</EmptyHint>
    );
  }

  return (
    <>
      {skills.map((skill) => {
        const expanded = expandedId === skill.id;
        return (
          <Card
            key={skill.id}
            className={cn(
              "gap-0 overflow-hidden rounded-xl p-0 transition-[box-shadow,border-color] duration-150 hover:border-border hover:shadow-md",
              expanded && "border-border shadow-md",
            )}
          >
            <button
              type="button"
              className="flex w-full cursor-pointer items-start gap-3 p-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              aria-expanded={expanded}
              onClick={() => setExpandedId(expanded ? null : skill.id)}
            >
              <SkillIconTile skill={skill} />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-sm font-semibold">{skill.name}</span>
                {skill.oneLiner.length > 0 ? (
                  <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
                    {skill.oneLiner}
                  </span>
                ) : null}
                {!expanded && skill.youGiveMe.length > 0 ? (
                  <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground/75">
                    You give me: {skill.youGiveMe.join(" · ")}
                  </span>
                ) : null}
              </span>
            </button>
            {expanded ? (
              <form
                className="flex flex-col gap-3 border-t border-border/60 bg-muted/32 p-3.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runSkill(skill);
                }}
              >
                {skill.youGiveMe.map((label) => (
                  <Field key={label}>
                    <FieldLabel className="text-xs sm:text-xs">{label}</FieldLabel>
                    <Input
                      size="sm"
                      value={answers[`${skill.id}:${label}`] ?? ""}
                      onChange={(event) =>
                        setAnswers((existing) => ({
                          ...existing,
                          [`${skill.id}:${label}`]: event.target.value,
                        }))
                      }
                    />
                  </Field>
                ))}
                <Button type="submit" size="sm" disabled={runningId !== null}>
                  {runningId === skill.id ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <SparklesIcon className="size-3.5" />
                  )}
                  Go
                </Button>
              </form>
            ) : null}
          </Card>
        );
      })}
    </>
  );
}

function Conversation({
  messages,
  working,
  sendError,
  onSend,
  markdownCwd,
  threadRef,
  artifacts,
}: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly working: boolean;
  readonly sendError: string | null;
  readonly onSend: (text: string) => Promise<boolean>;
  readonly markdownCwd: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly artifacts: ReadonlyArray<StudioFileEntry>;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const openedAtRef = useRef(new Date().toISOString());
  const [dismissedResultPath, setDismissedResultPath] = useState<string | null>(null);

  const freshResult = useMemo(() => {
    const candidates = artifacts
      .filter(
        (artifact) => artifact.modifiedAt !== null && artifact.modifiedAt > openedAtRef.current,
      )
      .sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""));
    const newest = candidates[0] ?? null;
    return newest !== null && newest.path !== dismissedResultPath ? newest : null;
  }, [artifacts, dismissedResultPath]);

  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          message.text.trim().length > 0,
      ),
    [messages],
  );

  const getViewport = (): HTMLElement | null => {
    const viewport = scrollRootRef.current?.querySelector('[data-slot="scroll-area-viewport"]');
    return viewport instanceof HTMLElement ? viewport : null;
  };

  const hasOpenedAtBottomRef = useRef(false);
  useEffect(() => {
    const viewport = getViewport();
    if (viewport === null || visibleMessages.length === 0) return;
    if (!hasOpenedAtBottomRef.current) {
      // Opening the room lands on the latest exchange, not the top of history.
      hasOpenedAtBottomRef.current = true;
      viewport.scrollTo({ top: viewport.scrollHeight });
      return;
    }
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    // Follow the conversation unless the reader has scrolled up into history.
    if (distanceFromBottom < 240) {
      viewport.scrollTo({ top: viewport.scrollHeight });
    }
  }, [visibleMessages, working]);

  const submit = async () => {
    const text = draft.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    try {
      const sent = await onSend(text);
      if (sent) {
        setDraft("");
        // The sender's own message always comes into view.
        requestAnimationFrame(() => {
          const viewport = getViewport();
          if (viewport !== null) viewport.scrollTo({ top: viewport.scrollHeight });
        });
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="flex min-h-0 flex-col">
      <ScrollArea ref={scrollRootRef} scrollFade className="min-h-0 flex-1">
        {visibleMessages.length === 0 && !working ? (
          <div className="flex h-full items-center justify-center px-6">
            <p className="text-placeholder text-sm">
              Say hello — or run something from the shelf on the left.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-5 py-6">
            {visibleMessages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="group flex flex-col items-end gap-1">
                  <div className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
                    <div className="text-sm leading-relaxed whitespace-pre-wrap">
                      {message.text}
                    </div>
                  </div>
                  <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                    <span className="text-muted-foreground">
                      {formatRelativeTimeLabel(message.createdAt)}
                    </span>
                  </div>
                </div>
              ) : (
                <div key={message.id} className="group/assistant relative min-w-0 px-1 py-0.5">
                  <ChatMarkdown
                    text={message.text}
                    cwd={markdownCwd}
                    threadRef={threadRef ?? undefined}
                    isStreaming={message.streaming}
                  />
                  {!message.streaming ? (
                    <div className="mt-1.5 flex items-center gap-2 text-xs tabular-nums opacity-0 transition-opacity duration-200 group-hover/assistant:opacity-100">
                      <span className="text-muted-foreground">
                        {formatRelativeTimeLabel(message.updatedAt)}
                      </span>
                    </div>
                  ) : null}
                </div>
              ),
            )}
            {working ? (
              <div className="flex items-center gap-2 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
                <Spinner className="size-3.5" />
                Working on it…
              </div>
            ) : null}
          </div>
        )}
      </ScrollArea>
      <div className="shrink-0 px-4 pt-1 pb-4">
        {freshResult !== null ? (
          <div className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2.5 rounded-xl border border-border/70 bg-card px-3 py-2 shadow-xs/5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40">
              <AppWindowIcon className="size-3.5 text-muted-foreground" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              New result: <span className="font-medium">{freshResult.name}</span>
            </span>
            <Button
              size="xs"
              variant="outline"
              render={
                <a href={artifactFileUrl(freshResult.path)} target="_blank" rel="noreferrer" />
              }
            >
              Open
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Dismiss"
              onClick={() => setDismissedResultPath(freshResult.path)}
            >
              <XIcon />
            </Button>
          </div>
        ) : null}
        {sendError !== null ? (
          <p className="mx-auto mb-2 w-full max-w-3xl px-1 text-xs text-destructive-foreground">
            That didn't go through: {sendError}
          </p>
        ) : null}
        <div className="chat-composer-glass-shell relative mx-auto w-full max-w-3xl">
          <div className="chat-composer-glass-host relative z-10 w-full rounded-[22px]">
            <form
              className="relative z-10 flex items-end gap-3 py-3 ps-4.5 pe-3"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <textarea
                rows={1}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                placeholder="Ask anything…"
                disabled={sending}
                className="field-sizing-content max-h-40 min-w-0 flex-1 resize-none self-center bg-transparent py-1 text-[15px] leading-6 outline-none placeholder:text-placeholder sm:text-sm"
              />
              <button
                type="submit"
                aria-label="Send"
                disabled={sending || draft.trim().length === 0}
                className="mb-0.5 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-message-action text-message-action-foreground transition-colors hover:bg-message-action-hover disabled:cursor-default disabled:opacity-30"
              >
                {sending ? (
                  <Spinner className="size-4" />
                ) : (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M8 3L8 13M8 3L4 7M8 3L12 7"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    </section>
  );
}
