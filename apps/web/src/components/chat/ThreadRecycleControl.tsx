import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RecycleIcon } from "lucide-react";
import { useState } from "react";

import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

/**
 * Manual context recycle: ask the server to run the handoff-and-restart flow
 * now (the same flow the threshold reactor runs automatically).
 */
export function ThreadRecycleControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const requestRecycle = useAtomCommand(threadEnvironment.requestRecycle, "thread recycle request");
  const [requested, setRequested] = useState(false);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            aria-label="Recycle session"
            data-chat-thread-recycle="true"
            disabled={requested}
            onClick={() => {
              setRequested(true);
              void requestRecycle({
                environmentId: props.environmentId,
                input: { threadId: props.threadId },
              }).finally(() => {
                // allow another request after the flow has had time to engage
                setTimeout(() => setRequested(false), 10_000);
              });
            }}
          />
        }
      >
        <ComposerControlIcon icon={RecycleIcon} />
        <span className="hidden lg:inline">{requested ? "recycling…" : "recycle"}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        Write a handoff, then restart this session fresh from it
      </TooltipPopup>
    </Tooltip>
  );
}
