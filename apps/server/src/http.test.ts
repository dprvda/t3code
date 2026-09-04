import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe } from "vite-plus/test";

import {
  assetResponseHeaders,
  carbonArtifactResponseHeaders,
  carbonUploadNameWithSuffix,
  isLoopbackHostname,
  listCarbonArtifacts,
  listCarbonSkills,
  parseCarbonSkillIconId,
  resolveCarbonArtifactFile,
  resolveCarbonCodexHome,
  resolveDevRedirectUrl,
  sanitizeCarbonUploadName,
} from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("assetResponseHeaders", () => {
  it("sandboxes SVG assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("does not apply document policy to raster images", () => {
    expect(assetResponseHeaders("/attachments/user-image.png")).toEqual({
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("declares utf-8 for HTML assets so non-ASCII content renders correctly", () => {
    expect(assetResponseHeaders("/workspace/page.html")).toHaveProperty(
      "Content-Type",
      "text/html; charset=utf-8",
    );
    expect(assetResponseHeaders("/workspace/PAGE.HTM")).toHaveProperty(
      "Content-Type",
      "text/html; charset=utf-8",
    );
  });
});

describe("carbon HTTP helpers", () => {
  it("sanitizes upload names without losing their extension", () => {
    expect(sanitizeCarbonUploadName("../../hero-film.mp4")).toBe("..-..-hero-film.mp4");
    expect(sanitizeCarbonUploadName("mix\\final.wav")).toBe("mix-final.wav");
    expect(sanitizeCarbonUploadName("..")).toBe("upload");
  });

  it("adds collision suffixes before an extension", () => {
    expect(carbonUploadNameWithSuffix("hero-film.mp4", 2)).toBe("hero-film-2.mp4");
    expect(carbonUploadNameWithSuffix("archive", 3)).toBe("archive-3");
  });

  it.effect("lists valid skill cards and skips missing or malformed manifests", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const codexHome = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "carbon-http-skills-",
      });
      const validSkillPath = path.join(codexHome, "skills", "valid-skill");
      const malformedSkillPath = path.join(codexHome, "skills", "malformed-skill");
      const missingCardPath = path.join(codexHome, "skills", "missing-card");
      yield* fileSystem.makeDirectory(validSkillPath, { recursive: true });
      yield* fileSystem.makeDirectory(malformedSkillPath, { recursive: true });
      yield* fileSystem.makeDirectory(missingCardPath, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(validSkillPath, "card.json"),
        `{
          "id": "valid-skill",
          "name": "Valid skill",
          "icon": "icon.png",
          "oneLiner": "Does a useful thing.",
          "youGiveMe": ["Input"],
          "scripts": ["scripts/run.ts"],
          "artifact": {
            "template": "templates/output.html",
            "kind": "page",
            "output": "artifacts/output.html"
          }
        }`,
      );
      yield* fileSystem.writeFileString(path.join(validSkillPath, "icon.png"), "png");
      yield* fileSystem.writeFileString(path.join(malformedSkillPath, "card.json"), "{");

      expect(yield* listCarbonSkills(codexHome)).toEqual([
        {
          id: "valid-skill",
          name: "Valid skill",
          icon: "icon.png",
          oneLiner: "Does a useful thing.",
          youGiveMe: ["Input"],
          scripts: ["scripts/run.ts"],
          artifact: {
            template: "templates/output.html",
            kind: "page",
            output: "artifacts/output.html",
          },
          skillPath: validSkillPath,
          hasIcon: true,
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("lists flat and nested workspace artifacts with modification timestamps", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "carbon-http-artifacts-",
      });
      const artifactsRoot = path.join(workspaceRoot, "artifacts");
      const artifactPath = path.join(artifactsRoot, "check-page.html");
      const nestedArtifactPath = path.join(artifactsRoot, "round-v4", "check-page.html");
      yield* fileSystem.makeDirectory(path.dirname(nestedArtifactPath), { recursive: true });
      yield* fileSystem.writeFileString(artifactPath, "<h1>Check page</h1>");
      yield* fileSystem.writeFileString(nestedArtifactPath, "<h1>Round v4</h1>");

      const artifacts = yield* listCarbonArtifacts(workspaceRoot);
      expect(artifacts).toHaveLength(2);
      expect(artifacts[0]).toMatchObject({
        name: "check-page.html",
        path: artifactPath,
      });
      expect(artifacts[1]).toMatchObject({
        name: "round-v4/check-page.html",
        path: nestedArtifactPath,
      });
      expect(artifacts.every((artifact) => !Number.isNaN(Date.parse(artifact.modifiedAt)))).toBe(
        true,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not follow artifact file or directory symlinks", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "carbon-http-artifacts-",
      });
      const outsideRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "carbon-http-outside-",
      });
      const artifactsRoot = path.join(workspaceRoot, "artifacts");
      const insidePath = path.join(artifactsRoot, "inside.html");
      const outsidePath = path.join(outsideRoot, "outside.html");
      const outsideDirectory = path.join(outsideRoot, "round-v9");
      yield* fileSystem.makeDirectory(artifactsRoot, { recursive: true });
      yield* fileSystem.makeDirectory(outsideDirectory, { recursive: true });
      yield* fileSystem.writeFileString(insidePath, "inside");
      yield* fileSystem.writeFileString(outsidePath, "outside");
      yield* fileSystem.writeFileString(path.join(outsideDirectory, "round.json"), "outside");
      yield* fileSystem.symlink(insidePath, path.join(artifactsRoot, "linked-inside.html"));
      yield* fileSystem.symlink(outsidePath, path.join(artifactsRoot, "linked-outside.html"));
      yield* fileSystem.symlink(outsideDirectory, path.join(artifactsRoot, "linked-round"));

      expect(yield* listCarbonArtifacts(workspaceRoot)).toEqual([
        expect.objectContaining({ name: "inside.html", path: insidePath }),
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects an artifact root that is itself a symlink", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "carbon-http-workspace-",
      });
      const outsideRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "carbon-http-outside-",
      });
      yield* fileSystem.writeFileString(path.join(outsideRoot, "outside.html"), "outside");
      yield* fileSystem.symlink(outsideRoot, path.join(workspaceRoot, "artifacts"));

      expect(yield* listCarbonArtifacts(workspaceRoot)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects traversal and symlink escapes from artifact file paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "carbon-http-workspace-",
      });
      const outsideRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "carbon-http-outside-",
      });
      const artifactsRoot = path.join(workspaceRoot, "artifacts");
      const artifactPath = path.join(artifactsRoot, "inside.html");
      const outsidePath = path.join(outsideRoot, "outside.html");
      const linkedPath = path.join(artifactsRoot, "linked.html");
      yield* fileSystem.makeDirectory(artifactsRoot, { recursive: true });
      yield* fileSystem.writeFileString(artifactPath, "inside");
      yield* fileSystem.writeFileString(outsidePath, "outside");
      yield* fileSystem.symlink(outsidePath, linkedPath);

      expect(yield* resolveCarbonArtifactFile(artifactPath)).toBe(
        yield* fileSystem.realPath(artifactPath),
      );
      expect(
        yield* resolveCarbonArtifactFile(path.join(artifactsRoot, "..", "outside.html")),
      ).toBeNull();
      expect(yield* resolveCarbonArtifactFile(linkedPath)).toBeNull();
      expect(yield* resolveCarbonArtifactFile("relative/artifacts/file.html")).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("validates icon route ids", () => {
    expect(parseCarbonSkillIconId("/api/carbon/skills/check-page-demo/icon")).toBe(
      "check-page-demo",
    );
    expect(parseCarbonSkillIconId("/api/carbon/skills/../icon")).toBeNull();
  });

  it.effect("uses the configured codex home or the Carbon Studio default", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(resolveCarbonCodexHome(path, "/tmp/custom-codex", "/home/test")).toBe(
        "/tmp/custom-codex",
      );
      expect(resolveCarbonCodexHome(path, undefined, "/home/test")).toBe(
        "/home/test/.carbon-studio/codex-home",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("sets restrictive HTML headers and correct raster image types", () => {
    expect(carbonArtifactResponseHeaders("/workspace/artifacts/page.html")).toEqual({
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    });
    expect(carbonArtifactResponseHeaders("/workspace/artifacts/image.png")).toEqual({
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
    });
  });
});
