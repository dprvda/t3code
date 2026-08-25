import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Link, useNavigate } from "@tanstack/react-router";
import { ClapperboardIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { newProjectId } from "../../lib/utils";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Field, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { HideWorkspaceChrome } from "./StudioSurface";
import { useStudioTurnSender } from "./useStudioTurn";

function kebabCase(input: string): string {
  return input
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function shortTitle(what: string): string {
  return what.split(/\s+/).slice(0, 4).join(" ");
}

function buildIntakeMessage(client: string, what: string, links: string, due: string): string {
  const parts = [`New project for ${client}: ${what}.`];
  if (links.length > 0) parts.push(`Links: ${links}.`);
  if (due.length > 0) parts.push(`Deadline: ${due}.`);
  return parts.join(" ");
}

export function StudioHome() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const threadShells = useThreadShells();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const createProject = useAtomCommand(projectEnvironment.create);
  const sendTurn = useStudioTurnSender();

  const [wizardOpen, setWizardOpen] = useState(false);
  const [client, setClient] = useState("");
  const [what, setWhat] = useState("");
  const [links, setLinks] = useState("");
  const [due, setDue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lastTouchedByProject = useMemo(() => {
    const byProject = new Map<string, string>();
    for (const shell of threadShells) {
      const key = `${shell.environmentId}:${shell.projectId}`;
      const existing = byProject.get(key);
      if (existing === undefined || shell.updatedAt.localeCompare(existing) > 0) {
        byProject.set(key, shell.updatedAt);
      }
    }
    return byProject;
  }, [threadShells]);

  const sortedProjects = useMemo(() => {
    const touched = (project: (typeof projects)[number]) =>
      lastTouchedByProject.get(`${project.environmentId}:${project.id}`) ?? project.updatedAt;
    return [...projects].sort((a, b) => touched(b).localeCompare(touched(a)));
  }, [projects, lastTouchedByProject]);

  const [resultCounts, setResultCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        projects.map(async (project): Promise<readonly [string, number]> => {
          try {
            const response = await fetch(
              `/api/carbon/artifacts?workspaceRoot=${encodeURIComponent(project.workspaceRoot)}`,
            );
            if (!response.ok) return [project.id, 0];
            const payload: unknown = await response.json();
            const artifacts =
              typeof payload === "object" && payload !== null
                ? (payload as { artifacts?: unknown }).artifacts
                : null;
            return [project.id, Array.isArray(artifacts) ? artifacts.length : 0];
          } catch {
            return [project.id, 0];
          }
        }),
      );
      if (!cancelled) setResultCounts(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [projects]);

  const handleOpenChange = (open: boolean) => {
    if (submitting) return;
    setWizardOpen(open);
    if (!open) setError(null);
  };

  const handleCreate = async () => {
    const trimmedClient = client.trim();
    const trimmedWhat = what.trim();
    if (trimmedClient.length === 0 || trimmedWhat.length === 0) {
      setError("Please tell us who the client is and what we're making.");
      return;
    }
    if (primaryEnvironmentId === null) {
      setError("Still connecting — give it a moment and try again.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const slug = kebabCase(`${trimmedClient} ${shortTitle(trimmedWhat)}`);
      const projectId = newProjectId();
      const defaultModelSelection = resolveDefaultProviderModelSelection(providers, null);
      const createResult = await createProject({
        environmentId: primaryEnvironmentId,
        input: {
          projectId,
          title: `${trimmedClient} — ${shortTitle(trimmedWhat)}`,
          workspaceRoot: `~/CarbonProjects/${slug}`,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection,
        },
      });
      if (createResult._tag === "Failure") {
        const cause = squashAtomCommandFailure(createResult);
        setError(
          cause instanceof Error ? cause.message : "Something went wrong creating the project.",
        );
        return;
      }
      const turn = await sendTurn(
        {
          environmentId: primaryEnvironmentId,
          projectId,
          projectModelSelection: defaultModelSelection,
          thread: null,
        },
        buildIntakeMessage(trimmedClient, trimmedWhat, links.trim(), due.trim()),
      );
      if (!turn.ok) {
        // The project exists; the room still works for a manual first message.
        console.error("Studio: first message failed to send:", turn.error);
      }
      await navigate({ to: "/studio/p/$projectId", params: { projectId } });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <HideWorkspaceChrome />
      <ScrollArea>
        <div className="mx-auto w-full max-w-4xl px-6 py-14 max-sm:px-4 max-sm:py-8">
          <header className="flex flex-wrap items-end justify-between gap-6">
            <div className="flex flex-col gap-1">
              <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                Carbon
              </p>
              <h1 className="font-heading text-3xl font-semibold tracking-tight">Studio</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Pick a project, or start a new one.
              </p>
            </div>
            <Button size="lg" onClick={() => setWizardOpen(true)}>
              <PlusIcon />
              New project
            </Button>
          </header>

          <section className="mt-10">
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                Projects
              </h2>
              {sortedProjects.length > 0 ? (
                <span className="rounded-full border border-border/60 bg-muted/40 px-1.5 text-[11px] leading-4.5 text-muted-foreground tabular-nums">
                  {sortedProjects.length}
                </span>
              ) : null}
            </div>
            {sortedProjects.length === 0 ? (
              <Card className="items-center gap-3 px-6 py-14 text-center">
                <span className="flex size-11 items-center justify-center rounded-xl border border-border/60 bg-muted/40">
                  <ClapperboardIcon className="size-5 text-muted-foreground" />
                </span>
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">No projects yet</p>
                  <p className="text-sm text-muted-foreground">
                    Start your first one — it takes four quick questions.
                  </p>
                </div>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {sortedProjects.map((project) => {
                  const lastTouched =
                    lastTouchedByProject.get(`${project.environmentId}:${project.id}`) ??
                    project.updatedAt;
                  return (
                    <Link
                      key={`${project.environmentId}:${project.id}`}
                      to="/studio/p/$projectId"
                      params={{ projectId: project.id }}
                      className="group rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <Card className="h-full gap-3 p-4 transition-[translate,box-shadow,border-color] duration-150 group-hover:-translate-y-0.5 group-hover:border-border group-hover:shadow-md">
                        <span className="flex size-10 items-center justify-center rounded-xl border border-border/60 bg-muted/40">
                          <ProjectFavicon
                            environmentId={project.environmentId}
                            cwd={project.workspaceRoot}
                            faviconPath={project.faviconPath}
                            className="size-5"
                          />
                        </span>
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="truncate text-sm font-medium">{project.title}</span>
                          <span className="text-xs text-muted-foreground">
                            Last touched {formatRelativeTimeLabel(lastTouched)}
                            {(resultCounts[project.id] ?? 0) > 0
                              ? ` · ${resultCounts[project.id]} result${resultCounts[project.id] === 1 ? "" : "s"}`
                              : ""}
                          </span>
                        </div>
                      </Card>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>

      <Dialog open={wizardOpen} onOpenChange={handleOpenChange}>
        <DialogPopup className="max-w-md" showCloseButton={!submitting}>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>Four quick questions and you're in.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreate();
              }}
            >
              <Field>
                <FieldLabel>Who is the client?</FieldLabel>
                <Input
                  value={client}
                  onChange={(event) => setClient(event.target.value)}
                  placeholder="e.g. Maison Verre"
                  disabled={submitting}
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel>What are we making?</FieldLabel>
                <Input
                  value={what}
                  onChange={(event) => setWhat(event.target.value)}
                  placeholder="e.g. hero film for the spring launch"
                  disabled={submitting}
                />
              </Field>
              <Field>
                <FieldLabel>
                  Links
                  <span className="font-normal text-muted-foreground">
                    Frame.io, docs — optional
                  </span>
                </FieldLabel>
                <Input
                  value={links}
                  onChange={(event) => setLinks(event.target.value)}
                  placeholder="Paste any links here"
                  disabled={submitting}
                />
              </Field>
              <Field>
                <FieldLabel>
                  When is it due?
                  <span className="font-normal text-muted-foreground">optional</span>
                </FieldLabel>
                <Input
                  value={due}
                  onChange={(event) => setDue(event.target.value)}
                  placeholder="e.g. next Thursday"
                  disabled={submitting}
                />
              </Field>
              {error !== null ? (
                <p className="text-sm text-destructive-foreground">{error}</p>
              ) : null}
              {/* Hidden submit so Enter in any field creates the project. */}
              <button type="submit" hidden />
            </form>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={submitting} />}>
              Cancel
            </DialogClose>
            <Button onClick={() => void handleCreate()} disabled={submitting}>
              {submitting ? <Spinner /> : null}
              {submitting ? "Setting things up…" : "Create project"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
