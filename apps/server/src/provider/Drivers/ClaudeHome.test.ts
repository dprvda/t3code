import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "", contextWindowTokens: 0 })).toBe(
          process.env,
        );
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect(
          (yield* makeClaudeEnvironment({ homePath, contextWindowTokens: 0 })).CLAUDE_CONFIG_DIR,
        ).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath, continuationGroup: "" })).toBe(
          `claude:home:${resolved}`,
        );
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "", continuationGroup: "" })).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );

    it.effect("contextWindowTokens injects the Claude Code context budget", () =>
      Effect.gen(function* () {
        const env = yield* makeClaudeEnvironment({
          homePath: "~/.claude-router",
          contextWindowTokens: 1_000_000,
        });
        expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("1000000");
        const untouched = yield* makeClaudeEnvironment({ homePath: "", contextWindowTokens: 0 });
        expect(untouched).toBe(process.env);
      }),
    );

    it.effect("an explicit continuation group overrides the home-path identity", () =>
      Effect.gen(function* () {
        const grouped = yield* makeClaudeContinuationGroupKey({
          homePath: "~/.claude-acct2",
          continuationGroup: "max-seats",
        });
        const otherSeat = yield* makeClaudeContinuationGroupKey({
          homePath: "~/.claude-acct3",
          continuationGroup: "max-seats",
        });
        expect(grouped).toBe("claude:group:max-seats");
        expect(otherSeat).toBe(grouped);
        // whitespace-only group falls back to the home identity
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir(), ".claude-acct2");
        expect(
          yield* makeClaudeContinuationGroupKey({
            homePath: "~/.claude-acct2",
            continuationGroup: "  ",
          }),
        ).toBe(`claude:home:${resolved}`);
      }),
    );
  });
});
