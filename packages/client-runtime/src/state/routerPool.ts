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
    // Poll-friendly command variants: a fresh RPC on every call. The SWR
    // query atoms above serve one-shot reads; polling THROUGH them via the
    // query runner froze the meters (the runner's transient mount reads the
    // cached success and closes its scope, cancelling the revalidation it
    // just started) — the panel showed 38% while the account sat at 94%.
    accountsFetch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:router:accounts-fetch",
      tag: WS_METHODS.routerAccounts,
      scheduler,
    }),
    claudeSeatsFetch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:router:claude-seats-fetch",
      tag: WS_METHODS.claudeSeats,
      scheduler,
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
