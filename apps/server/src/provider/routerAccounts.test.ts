// @effect-diagnostics nodeBuiltinImport:off globalDate:off - exercises the real filesystem in a temp dir; epoch fixtures need Date construction.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { claudeWindows, codexWindows, makeRouterAccounts } from "./routerAccounts.ts";

let home: string;

beforeEach(() => {
  home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "router-accounts-"));
  NodeFS.mkdirSync(NodePath.join(home, ".cli-proxy-api", "auth"), { recursive: true });
});
afterEach(() => {
  NodeFS.rmSync(home, { recursive: true, force: true });
});

function seed(file: string, auth: Record<string, unknown>): void {
  NodeFS.writeFileSync(NodePath.join(home, ".cli-proxy-api", "auth", file), JSON.stringify(auth));
}

const fetchNever: typeof fetch = (() => {
  throw new Error("network must not be reached");
}) as never;

describe("window shaping", () => {
  it("claude: five_hour/seven_day map to 5h/week with ISO resets", () => {
    expect(
      claudeWindows({
        five_hour: { utilization: 62.4, resets_at: "2026-08-21T22:00:00Z" },
        seven_day: { utilization: 17 },
      }),
    ).toEqual([
      { label: "5h", pct: 62, resetsAt: "2026-08-21T22:00:00Z" },
      { label: "week", pct: 17, resetsAt: null },
    ]);
  });
  it("codex: windows labeled by duration, epoch resets, deduped, 5h first", () => {
    expect(
      codexWindows({
        rate_limit: {
          primary_window: { used_percent: 1, limit_window_seconds: 604800, reset_at: 1787328000 },
          secondary_window: { used_percent: 55, limit_window_seconds: 18000, reset_at: 1787300000 },
        },
      }),
    ).toEqual([
      { label: "5h", pct: 55, resetsAt: new Date(1787300000 * 1000).toISOString() },
      { label: "week", pct: 1, resetsAt: new Date(1787328000 * 1000).toISOString() },
    ]);
  });
});

describe("makeRouterAccounts", () => {
  it("lists auth files claude-first, deriving provider/email/enabled; disabled rows skip fetches", async () => {
    seed("codex-user@x.com-pro.json", { type: "codex", email: "user@x.com", disabled: true });
    seed("claude-user@x.com.json", { email: "user@x.com", disabled: true });
    NodeFS.writeFileSync(
      NodePath.join(home, ".cli-proxy-api", "auth", "claude-old@x.com.json.disabled"),
      "{}",
    ); // suffix-renamed files are invisible
    const service = makeRouterAccounts(home, fetchNever);
    const rows = await service.list();
    expect(rows.map((row) => [row.file, row.provider, row.enabled])).toEqual([
      ["claude-user@x.com.json", "claude", false],
      ["codex-user@x.com-pro.json", "codex", false],
    ]);
    expect(rows.every((row) => row.windows.length === 0)).toBe(true);
    // rows never leak tokens
    expect(JSON.stringify(rows)).not.toContain("access_token");
  });

  it("setDisabled read-modify-writes the flag and refuses bad file names", async () => {
    seed("claude-a@x.com.json", {
      email: "a@x.com",
      access_token: "secret-token",
      refresh_token: "keep-me",
    });
    const service = makeRouterAccounts(home, fetchNever);
    service.setDisabled("claude-a@x.com.json", true);
    const raw = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(home, ".cli-proxy-api", "auth", "claude-a@x.com.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(raw["disabled"]).toBe(true);
    expect(raw["refresh_token"]).toBe("keep-me"); // merge, never clobber
    expect(() => service.setDisabled("../evil.json", true)).toThrow(/bad auth file/);
    expect(() => service.setDisabled("other.json", true)).toThrow(/bad auth file/);
  });

  it("meters come from the provider usage endpoints with the file's own token", async () => {
    seed("claude-a@x.com.json", { email: "a@x.com", access_token: "tok-claude" });
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: (init?.headers as Record<string, string> | undefined)?.["Authorization"],
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ five_hour: { utilization: 40, resets_at: null } }),
      } as Response;
    }) as typeof fetch;
    const service = makeRouterAccounts(home, fetchFake);
    const rows = await service.list();
    expect(calls).toEqual([
      { url: "https://api.anthropic.com/api/oauth/usage", auth: "Bearer tok-claude" },
    ]);
    expect(rows[0]?.windows).toEqual([{ label: "5h", pct: 40, resetsAt: null }]);
  });
});
