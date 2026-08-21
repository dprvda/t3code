import { createSubagentViewAtoms } from "@t3tools/client-runtime/state/subagentView";

import { connectionAtomRuntime } from "../connection/runtime";

export const subagentViewEnvironment = createSubagentViewAtoms(connectionAtomRuntime);
