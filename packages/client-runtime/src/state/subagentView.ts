import { WS_METHODS } from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** On-disk subagent runs and their transcripts for a thread. */
export function createSubagentViewAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  return {
    runs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:subagents:runs",
      tag: WS_METHODS.subagentsList,
      staleTimeMs: 10_000,
    }),
    transcript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:subagents:transcript",
      tag: WS_METHODS.subagentsTranscript,
      staleTimeMs: 5_000,
    }),
  };
}
