import { createFileRoute, redirect } from "@tanstack/react-router";

import { StudioRoom } from "../components/studio/StudioRoom";

export const Route = createFileRoute("/studio/p/$projectId")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: () => <StudioRoom projectId={Route.useParams().projectId} />,
});
