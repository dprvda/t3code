import { createFileRoute } from "@tanstack/react-router";

import { RouterPoolPanel } from "../components/settings/RouterPoolPanel";

export const Route = createFileRoute("/settings/router-pool")({
  component: RouterPoolPanel,
});
