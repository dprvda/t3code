/**
 * Compact real-controls composer for read-mostly surfaces (grid panes, the
 * subagent transcripts dialog): the solo composer's core controls — provider
 * model picker, runtime-mode menu, stop/send — driving the same thread
 * commands, without ChatView's full state machine. Selections seed from the
 * thread shell and apply per sent turn; effort and other model options ride
 * the shell's stored selection options untouched.
 */
import type { EnvironmentId, ProviderInstanceId, RuntimeMode, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import { SquareIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { cn, newMessageId } from "~/lib/utils";
import { getAppModelOptionsForInstance, type AppModelOption } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ProviderModelPicker } from "./ProviderModelPicker";

export const PaneComposer = memo(function PaneComposer({
  environmentId,
  threadId,
  placeholder,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly placeholder?: string;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const shell = useThreadShell(threadRef);
  const { environments } = useEnvironments();
  const providerStatuses = useMemo(
    () =>
      environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
        ?.providers ?? [],
    [environments, environmentId],
  );
  const settings = usePrimarySettings();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });

  const instanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings],
  );
  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of instanceEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
    }
    return out;
  }, [instanceEntries, settings]);

  // Seed from the shell per thread; user picks apply to the NEXT sent turn.
  const [modelSelection, setModelSelection] = useState(shell?.modelSelection ?? null);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(shell?.runtimeMode ?? "full-access");
  const [draft, setDraft] = useState("");
  useEffect(() => {
    setModelSelection(shell?.modelSelection ?? null);
    setRuntimeMode(shell?.runtimeMode ?? "full-access");
    setDraft("");
    // reseed only when the pane retargets, not on every shell update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [String(threadId), environmentId]);

  const isRunning = shell?.latestTurn?.state === "running";

  const send = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0 || shell === null || modelSelection === null) return;
    setDraft("");
    void startTurn({
      environmentId,
      input: {
        threadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        modelSelection,
        runtimeMode,
        interactionMode: shell.interactionMode,
      },
    });
  }, [draft, shell, modelSelection, runtimeMode, startTurn, environmentId, threadId]);

  const stop = useCallback(() => {
    void interruptTurn({ environmentId, input: { threadId } });
  }, [interruptTurn, environmentId, threadId]);

  if (shell === null || modelSelection === null) return null;

  return (
    <div className="flex shrink-0 flex-col border-border border-t">
      <input
        value={draft}
        onChange={(changeEvent) => setDraft(changeEvent.target.value)}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === "Enter" && !keyEvent.shiftKey) {
            keyEvent.preventDefault();
            send();
          }
        }}
        placeholder={placeholder ?? "Message this session…"}
        className="min-w-0 bg-transparent px-2.5 pt-1.5 pb-0.5 text-xs outline-none placeholder:text-secondary-label/60"
      />
      <div className="flex items-center gap-0.5 px-1.5 pb-1">
        <ProviderModelPicker
          compact
          activeInstanceId={modelSelection.instanceId}
          model={modelSelection.model}
          lockedProvider={null}
          instanceEntries={instanceEntries}
          keybindings={keybindings}
          modelOptionsByInstance={modelOptionsByInstance}
          onInstanceModelChange={(instanceId, model) =>
            setModelSelection(createModelSelection(instanceId, model))
          }
        />
        <CompactComposerControlsMenu
          interactionMode={shell.interactionMode}
          runtimeMode={runtimeMode}
          showInteractionModeToggle={false}
          onToggleInteractionMode={() => {}}
          onRuntimeModeChange={setRuntimeMode}
        />
        <span className="min-w-0 flex-1" />
        {isRunning ? (
          <button
            type="button"
            aria-label="Stop generation"
            onClick={stop}
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-red-500/90 text-white hover:bg-red-500"
          >
            <SquareIcon className="size-2.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            onClick={send}
            disabled={draft.trim().length === 0}
            className={cn(
              "rounded-md px-2 py-0.5 font-medium text-[11px]",
              draft.trim().length === 0
                ? "text-secondary-label/50"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
});
