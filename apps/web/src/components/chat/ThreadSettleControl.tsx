import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CircleCheckIcon, UndoDotIcon } from "lucide-react";

import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

/** Composer pill mirroring the grid pane's settle/unsettle button. */
export function ThreadSettleControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isSettled: boolean;
}) {
  const settleThread = useAtomCommand(threadEnvironment.settle, "thread settle");
  const unsettleThread = useAtomCommand(threadEnvironment.unsettle, "thread unsettle");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            aria-label={props.isSettled ? "Unsettle thread" : "Settle thread"}
            data-chat-thread-settle="true"
            onClick={() => {
              if (props.isSettled) {
                void unsettleThread({
                  environmentId: props.environmentId,
                  input: { threadId: props.threadId, reason: "user" },
                });
              } else {
                void settleThread({
                  environmentId: props.environmentId,
                  input: { threadId: props.threadId },
                });
              }
            }}
          />
        }
      >
        <ComposerControlIcon icon={props.isSettled ? UndoDotIcon : CircleCheckIcon} />
        <span className="hidden lg:inline">{props.isSettled ? "unsettle" : "settle"}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.isSettled ? "Return this thread to the active list" : "Mark this thread settled"}
      </TooltipPopup>
    </Tooltip>
  );
}
