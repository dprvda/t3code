/**
 * CLIProxyAPI router pool contracts: the router's OAuth account inventory
 * (per-account enable/disable + official quota meters) and login flows run
 * through the router's own CLI. See `apps/server/src/provider/routerAccounts.ts`.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const RouterQuotaWindow = Schema.Struct({
  label: Schema.Literals(["5h", "week"]),
  pct: Schema.Int,
  resetsAt: Schema.NullOr(Schema.String),
});
export type RouterQuotaWindow = typeof RouterQuotaWindow.Type;

export const RouterAccountRow = Schema.Struct({
  file: TrimmedNonEmptyString,
  provider: Schema.Literals(["claude", "codex"]),
  email: Schema.String,
  enabled: Schema.Boolean,
  stale: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  windows: Schema.Array(RouterQuotaWindow),
});
export type RouterAccountRow = typeof RouterAccountRow.Type;

export const RouterAccountsInput = Schema.Struct({
  force: Schema.optional(Schema.Boolean),
});
export type RouterAccountsInput = typeof RouterAccountsInput.Type;

export const RouterAccountsResult = Schema.Struct({
  rows: Schema.Array(RouterAccountRow),
});
export type RouterAccountsResult = typeof RouterAccountsResult.Type;

export const RouterAccountToggleInput = Schema.Struct({
  file: TrimmedNonEmptyString,
  disabled: Schema.Boolean,
});
export type RouterAccountToggleInput = typeof RouterAccountToggleInput.Type;

export const RouterLoginProvider = Schema.Literals(["claude", "codex"]);
export type RouterLoginProvider = typeof RouterLoginProvider.Type;

export const RouterLoginStartInput = Schema.Struct({
  provider: RouterLoginProvider,
});
export type RouterLoginStartInput = typeof RouterLoginStartInput.Type;

export const RouterLoginStatus = Schema.Struct({
  loginId: TrimmedNonEmptyString,
  provider: RouterLoginProvider,
  state: Schema.Literals(["starting", "awaiting-browser", "done", "failed"]),
  url: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
});
export type RouterLoginStatus = typeof RouterLoginStatus.Type;

export const RouterLoginStatusInput = Schema.Struct({
  loginId: TrimmedNonEmptyString,
});
export type RouterLoginStatusInput = typeof RouterLoginStatusInput.Type;

export class RouterPoolError extends Schema.TaggedErrorClass<RouterPoolError>()("RouterPoolError", {
  message: TrimmedNonEmptyString,
}) {}
