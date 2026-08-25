import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Link, useNavigate } from "@tanstack/react-router";
import { FolderIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { newProjectId } from "../../lib/utils";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
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

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [projects],
  );

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
    <div className="fixed inset-0 z-40 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto w-full max-w-3xl px-6 py-12">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Carbon Studio</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a project, or start a new one.
            </p>
          </div>
          {!wizardOpen ? (
            <Button size="lg" onClick={() => setWizardOpen(true)}>
              <PlusIcon />
              New project
            </Button>
          ) : null}
        </header>

        {wizardOpen ? (
          <Card className="mt-8 gap-4 p-6">
            <h2 className="text-lg font-medium">New project</h2>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Who is the client?
              <Input
                value={client}
                onChange={(event) => setClient(event.target.value)}
                placeholder="e.g. Maison Verre"
                className="rounded-lg border border-input bg-popover"
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              What are we making?
              <Input
                value={what}
                onChange={(event) => setWhat(event.target.value)}
                placeholder="e.g. hero film for the spring launch"
                className="rounded-lg border border-input bg-popover"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Links (Frame.io, docs — optional)
              <Input
                value={links}
                onChange={(event) => setLinks(event.target.value)}
                placeholder="Paste any links here"
                className="rounded-lg border border-input bg-popover"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              When is it due? (optional)
              <Input
                value={due}
                onChange={(event) => setDue(event.target.value)}
                placeholder="e.g. next Thursday"
                className="rounded-lg border border-input bg-popover"
              />
            </label>
            {error !== null ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
            <div className="flex items-center gap-2 pt-1">
              <Button onClick={() => void handleCreate()} disabled={submitting}>
                {submitting ? <Spinner /> : null}
                {submitting ? "Setting things up…" : "Create project"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setWizardOpen(false);
                  setError(null);
                }}
                disabled={submitting}
              >
                Cancel
              </Button>
            </div>
          </Card>
        ) : null}

        <section className="mt-10">
          <h2 className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
            Projects
          </h2>
          {sortedProjects.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              No projects yet — start your first one.
            </p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {sortedProjects.map((project) => (
                <li key={`${project.environmentId}:${project.id}`}>
                  <Link
                    to="/studio/p/$projectId"
                    params={{ projectId: project.id }}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:bg-accent/50"
                  >
                    <FolderIcon className="size-4.5 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-medium">{project.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
