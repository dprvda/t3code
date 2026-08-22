import { WS_METHODS } from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** CLIProxyAPI router pool: account inventory, membership toggles, logins. */
export function createRouterPoolAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    accounts: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:router:accounts",
      tag: WS_METHODS.routerAccounts,
      staleTimeMs: 30_000,
    }),
    claudeSeats: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:router:claude-seats",
      tag: WS_METHODS.claudeSeats,
      staleTimeMs: 30_000,
    }),
    toggleAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:router:account-toggle",
      tag: WS_METHODS.routerAccountToggle,
      scheduler,
    }),
    loginStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:router:login-start",
      tag: WS_METHODS.routerLoginStart,
      scheduler,
    }),
    loginStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:router:login-status",
      tag: WS_METHODS.routerLoginStatus,
      staleTimeMs: 0,
    }),
  };
}
