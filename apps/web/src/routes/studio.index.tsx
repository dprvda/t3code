import { createFileRoute, redirect } from "@tanstack/react-router";

import { StudioHome } from "../components/studio/StudioHome";

export const Route = createFileRoute("/studio/")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: StudioHome,
});
