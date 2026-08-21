import { createRouterPoolAtoms } from "@t3tools/client-runtime/state/routerPool";

import { connectionAtomRuntime } from "../connection/runtime";

export const routerPoolEnvironment = createRouterPoolAtoms(connectionAtomRuntime);
