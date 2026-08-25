import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_MODEL,
  ProviderInstanceId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useCallback } from "react";

import { newMessageId, newThreadId } from "../../lib/utils";
import { resolveDefaultProviderModelSelection } from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

const STUDIO_RUNTIME_MODE = "full-access" as const;
const STUDIO_INTERACTION_MODE = "default" as const;
const STUDIO_FALLBACK_INSTANCE_ID = "codex_carbon";

export interface StudioTurnTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectModelSelection: ModelSelection | null;
  /** Existing thread to continue, or null to create one on this send. */
  readonly thread: {
    readonly id: ThreadId;
    readonly modelSelection: ModelSelection;
  } | null;
}

export type StudioTurnResult =
  | { readonly ok: true; readonly threadId: ThreadId }
  | { readonly ok: false; readonly error: string };

function truncateTitle(text: string): string {
  const singleLine = text.replaceAll(/\s+/g, " ").trim();
  return singleLine.length > 80 ? `${singleLine.slice(0, 79)}…` : singleLine;
}

/**
 * Send one message into a project's conversation. When no thread exists yet,
 * the first send creates it via the turn-start bootstrap (same path the
 * developer composer uses for draft threads).
 */
export function useStudioTurnSender(): (
  target: StudioTurnTarget,
  text: string,
) => Promise<StudioTurnResult> {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const startTurn = useAtomCommand(threadEnvironment.startTurn);

  return useCallback(
    async (target, text) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return { ok: false, error: "Nothing to send." };
      }
      const modelSelection =
        target.thread?.modelSelection ??
        resolveDefaultProviderModelSelection(providers, target.projectModelSelection) ??
        createModelSelection(ProviderInstanceId.make(STUDIO_FALLBACK_INSTANCE_ID), DEFAULT_MODEL);
      const threadId = target.thread?.id ?? newThreadId();
      const createdAt = new Date().toISOString();
      const title = truncateTitle(trimmed);
      const result = await startTurn({
        environmentId: target.environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: trimmed,
            attachments: [],
          },
          modelSelection,
          titleSeed: title,
          runtimeMode: STUDIO_RUNTIME_MODE,
          interactionMode: STUDIO_INTERACTION_MODE,
          ...(target.thread
            ? {}
            : {
                bootstrap: {
                  createThread: {
                    projectId: target.projectId,
                    title,
                    modelSelection,
                    runtimeMode: STUDIO_RUNTIME_MODE,
                    interactionMode: STUDIO_INTERACTION_MODE,
                    branch: null,
                    worktreePath: null,
                    createdAt,
                  },
                },
              }),
          createdAt,
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      return { ok: true, threadId };
    },
    [providers, startTurn],
  );
}
