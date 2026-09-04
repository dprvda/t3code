import * as NodeOS from "node:os";

import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { cast } from "effect/Function";
import {
  Headers,
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { OtlpTracer } from "effect/unstable/observability";

import * as ServerConfig from "./config.ts";
import { ASSET_ROUTE_PREFIX, resolveAsset } from "./assets/AssetAccess.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["carbonstudio://app", "carbonstudio-dev://app"];
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const CARBON_HTML_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
const CARBON_SKILL_ICON_PATH_PREFIX = "/api/carbon/skills/";
const CARBON_SKILL_ICON_PATH_SUFFIX = "/icon";
const CARBON_SKILL_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const MAX_CARBON_UPLOAD_BYTES = 512 * 1024 * 1024;

const CarbonSkillCardSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.String,
  oneLiner: Schema.String,
  youGiveMe: Schema.Array(Schema.String),
  scripts: Schema.Array(Schema.String),
  artifact: Schema.Struct({
    template: Schema.String,
    kind: Schema.Literals(["page", "document", "file"]),
    output: Schema.String,
  }),
});

export type CarbonSkill = typeof CarbonSkillCardSchema.Type & {
  readonly skillPath: string;
  readonly hasIcon: boolean;
};

export interface CarbonArtifact {
  readonly name: string;
  readonly path: string;
  readonly modifiedAt: string;
}

export function resolveCarbonCodexHome(
  path: Path.Path,
  override: string | undefined = process.env.CARBON_CODEX_HOME,
  homeDir: string = NodeOS.homedir(),
): string {
  const configuredHome = override?.trim();
  return path.resolve(configuredHome || path.join(homeDir, ".carbon-studio", "codex-home"));
}

export function parseCarbonSkillIconId(pathname: string): string | null {
  if (
    !pathname.startsWith(CARBON_SKILL_ICON_PATH_PREFIX) ||
    !pathname.endsWith(CARBON_SKILL_ICON_PATH_SUFFIX)
  ) {
    return null;
  }
  const id = pathname.slice(
    CARBON_SKILL_ICON_PATH_PREFIX.length,
    -CARBON_SKILL_ICON_PATH_SUFFIX.length,
  );
  return CARBON_SKILL_ID_PATTERN.test(id) ? id : null;
}

export function sanitizeCarbonUploadName(name: string): string {
  const sanitized = name.replace(/[\\/\0]+/g, "-").trim();
  return sanitized === "" || sanitized === "." || sanitized === ".." ? "upload" : sanitized;
}

export function carbonUploadNameWithSuffix(name: string, suffix: number): string {
  if (suffix < 2) return name;
  const extensionStart = name.lastIndexOf(".");
  return extensionStart > 0
    ? `${name.slice(0, extensionStart)}-${suffix}${name.slice(extensionStart)}`
    : `${name}-${suffix}`;
}

const saveCarbonUpload = Effect.fn("http.saveCarbonUpload")(function* (
  workspaceRoot: string,
  name: string,
  bytes: Uint8Array,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const uploadsRoot = path.join(workspaceRoot, "uploads");
  const sanitizedName = sanitizeCarbonUploadName(name);
  yield* fileSystem.makeDirectory(uploadsRoot, { recursive: true });

  let suffix = 1;
  let finalName = sanitizedName;
  let filePath = path.join(uploadsRoot, finalName);
  while (yield* fileSystem.exists(filePath)) {
    suffix += 1;
    finalName = carbonUploadNameWithSuffix(sanitizedName, suffix);
    filePath = path.join(uploadsRoot, finalName);
  }

  yield* fileSystem.writeFile(filePath, bytes, { flag: "wx" });
  return { path: filePath, name: finalName, sizeBytes: bytes.byteLength };
});

export const listCarbonSkills = Effect.fn("http.listCarbonSkills")(function* (codexHome: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillsRoot = path.join(codexHome, "skills");
  const skillFolders = yield* fileSystem
    .readDirectory(skillsRoot)
    .pipe(Effect.orElseSucceed(() => []));
  const decodeCard = Schema.decodeUnknownEffect(Schema.fromJsonString(CarbonSkillCardSchema));
  const skills: Array<CarbonSkill> = [];

  for (const skillFolder of skillFolders.sort()) {
    const skillPath = path.resolve(skillsRoot, skillFolder);
    const cardPath = path.join(skillPath, "card.json");
    if (!(yield* fileSystem.exists(cardPath).pipe(Effect.orElseSucceed(() => false)))) {
      continue;
    }

    const cardJson = yield* fileSystem.readFileString(cardPath).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Skipping unreadable Carbon skill manifest.", { cardPath, cause }),
      ),
      Effect.option,
    );
    if (Option.isNone(cardJson)) continue;

    const card = yield* decodeCard(cardJson.value).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Skipping malformed Carbon skill manifest.", { cardPath, cause }),
      ),
      Effect.option,
    );
    if (Option.isNone(card)) continue;

    const iconInfo = yield* fileSystem.stat(path.join(skillPath, "icon.png")).pipe(Effect.option);
    skills.push({
      ...card.value,
      skillPath,
      hasIcon: Option.isSome(iconInfo) && iconInfo.value.type === "File",
    });
  }

  return skills;
});

export const listCarbonArtifacts = Effect.fn("http.listCarbonArtifacts")(function* (
  workspaceRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedArtifactsRoot = path.resolve(resolvedWorkspaceRoot, "artifacts");
  const [canonicalWorkspaceRoot, canonicalArtifactsRoot] = yield* Effect.all([
    fileSystem.realPath(resolvedWorkspaceRoot).pipe(Effect.option),
    fileSystem.realPath(resolvedArtifactsRoot).pipe(Effect.option),
  ]);
  if (Option.isNone(canonicalWorkspaceRoot) || Option.isNone(canonicalArtifactsRoot)) return [];

  // `artifacts` is a boundary, not a portal to another directory. Resolve the
  // workspace separately so a workspace root that is itself a symlink still
  // works, while an `artifacts` symlink is rejected.
  const artifactsRoot = path.resolve(canonicalWorkspaceRoot.value, "artifacts");
  if (canonicalArtifactsRoot.value !== artifactsRoot) return [];

  const artifacts: Array<CarbonArtifact> = [];
  const pendingDirectories = [artifactsRoot];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()!;
    const names = yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));

    for (const name of names.sort()) {
      const lexicalPath = path.resolve(directory, name);
      const canonicalPath = yield* fileSystem.realPath(lexicalPath).pipe(Effect.option);
      if (Option.isNone(canonicalPath)) continue;

      const relativePath = path.relative(artifactsRoot, canonicalPath.value);
      const isWithinArtifacts =
        relativePath !== "" &&
        relativePath !== ".." &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath);
      // A different canonical path means this entry is a symlink (or crosses
      // another filesystem alias). Do not follow it, even when it points back
      // inside the artifact tree: discovery should reflect files the skill
      // actually wrote there, not a surprising second namespace.
      if (!isWithinArtifacts || canonicalPath.value !== lexicalPath) continue;

      const info = yield* fileSystem.stat(canonicalPath.value).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      if (info.value.type === "Directory") {
        pendingDirectories.push(canonicalPath.value);
        continue;
      }
      if (info.value.type !== "File" || Option.isNone(info.value.mtime)) continue;

      artifacts.push({
        name: relativePath.split(path.sep).join("/"),
        path: canonicalPath.value,
        modifiedAt: info.value.mtime.value.toISOString(),
      });
    }
  }

  return artifacts.sort((a, b) => a.name.localeCompare(b.name));
});

export interface CarbonUpload {
  readonly name: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}

export const listCarbonUploads = Effect.fn("http.listCarbonUploads")(function* (
  workspaceRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const uploadsRoot = path.join(workspaceRoot, "uploads");
  const names = yield* fileSystem.readDirectory(uploadsRoot).pipe(Effect.orElseSucceed(() => []));
  const uploads: Array<CarbonUpload> = [];

  for (const name of names.sort()) {
    const filePath = path.resolve(uploadsRoot, name);
    const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File" || Option.isNone(info.value.mtime)) {
      continue;
    }
    uploads.push({
      name,
      path: filePath,
      sizeBytes: Number(info.value.size),
      modifiedAt: info.value.mtime.value.toISOString(),
    });
  }

  return uploads;
});

export interface CarbonWorkspaceEntry {
  readonly name: string;
  readonly kind: "folder" | "file";
}

export const listCarbonWorkspaceEntries = Effect.fn("http.listCarbonWorkspaceEntries")(function* (
  workspaceRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fileSystem.readDirectory(workspaceRoot).pipe(Effect.orElseSucceed(() => []));
  const entries: Array<CarbonWorkspaceEntry> = [];

  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const info = yield* fileSystem.stat(path.resolve(workspaceRoot, name)).pipe(Effect.option);
    if (Option.isNone(info)) continue;
    if (info.value.type === "Directory") entries.push({ name, kind: "folder" });
    else if (info.value.type === "File") entries.push({ name, kind: "file" });
  }

  return entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1,
  );
});

function hasCarbonArtifactsSegment(path: Path.Path, filePath: string): boolean {
  return filePath.includes(`${path.sep}artifacts${path.sep}`);
}

export const resolveCarbonArtifactFile = Effect.fn("http.resolveCarbonArtifactFile")(function* (
  requestedPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(requestedPath) || requestedPath.includes("\0")) return null;

  const lexicalPath = path.resolve(requestedPath);
  if (!hasCarbonArtifactsSegment(path, lexicalPath)) return null;

  const canonicalPath = yield* fileSystem.realPath(lexicalPath).pipe(Effect.option);
  if (Option.isNone(canonicalPath) || !hasCarbonArtifactsSegment(path, canonicalPath.value)) {
    return null;
  }

  const info = yield* fileSystem.stat(canonicalPath.value).pipe(Effect.option);
  return Option.isSome(info) && info.value.type === "File" ? canonicalPath.value : null;
});

export function carbonArtifactResponseHeaders(filePath: string): Record<string, string> {
  const lowerPath = filePath.toLowerCase();
  const isHtml = lowerPath.endsWith(".html") || lowerPath.endsWith(".htm");
  return {
    "Content-Type": isHtml
      ? "text/html; charset=utf-8"
      : (Mime.getType(filePath) ?? "application/octet-stream"),
    "X-Content-Type-Options": "nosniff",
    ...(isHtml ? { "Content-Security-Policy": CARBON_HTML_CONTENT_SECURITY_POLICY } : {}),
  };
}

export function assetResponseHeaders(filePath: string): Record<string, string> {
  const lowerPath = filePath.toLowerCase();
  return {
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    ...(lowerPath.endsWith(".html") || lowerPath.endsWith(".htm")
      ? { "Content-Type": "text/html; charset=utf-8" }
      : {}),
    ...(lowerPath.endsWith(".svg")
      ? { "Content-Security-Policy": SVG_CONTENT_SECURITY_POLICY }
      : {}),
  };
}

export const httpCompressionLayer = HttpRouter.middleware(HttpMiddleware.compression(), {
  global: true,
});

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Dev uses credentialed requests from Vite or the Electron custom origin, so both must be
    // explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.
    //
    // T3CODE_DEV_ALLOWED_ORIGINS covers dev servers reached from a second
    // origin — a tailnet name, a LAN IP, a phone. Browser dev normally proxies
    // through Vite and is same-origin (no preflight at all), so this is a
    // safety net for the desktop renderer and any direct-to-backend caller.
    return HttpRouter.cors({
      ...(devOrigin
        ? {
            allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS, ...config.devAllowedOrigins],
            credentials: true,
          }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }, traceRelayRequest),
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const assetRouteLayer = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* HttpServerResponse.file(asset.path, {
      status: 200,
      headers: assetResponseHeaders(asset.path),
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

export const carbonRouteLayer = HttpRouter.add(
  "GET",
  "/api/carbon/*",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pathname = url.value.pathname;

    if (pathname === "/api/carbon/skills") {
      const codexHome = resolveCarbonCodexHome(path);
      return HttpServerResponse.jsonUnsafe({ skills: yield* listCarbonSkills(codexHome) });
    }

    const skillId = parseCarbonSkillIconId(pathname);
    if (skillId !== null) {
      const iconPath = path.join(resolveCarbonCodexHome(path), "skills", skillId, "icon.png");
      const iconInfo = yield* fileSystem.stat(iconPath).pipe(Effect.option);
      if (Option.isNone(iconInfo) || iconInfo.value.type !== "File") {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return yield* HttpServerResponse.file(iconPath, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "X-Content-Type-Options": "nosniff",
        },
      }).pipe(
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Internal Server Error", { status: 500 }),
        ),
      );
    }

    if (pathname === "/api/carbon/artifacts") {
      const workspaceRoot = url.value.searchParams.get("workspaceRoot");
      if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
        return HttpServerResponse.text("workspaceRoot must be an absolute path", { status: 400 });
      }
      return HttpServerResponse.jsonUnsafe({
        artifacts: yield* listCarbonArtifacts(path.resolve(workspaceRoot)),
      });
    }

    if (pathname === "/api/carbon/uploads") {
      const workspaceRoot = url.value.searchParams.get("workspaceRoot");
      if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
        return HttpServerResponse.text("workspaceRoot must be an absolute path", { status: 400 });
      }
      return HttpServerResponse.jsonUnsafe({
        uploads: yield* listCarbonUploads(path.resolve(workspaceRoot)),
      });
    }

    if (pathname === "/api/carbon/workspace") {
      const workspaceRoot = url.value.searchParams.get("workspaceRoot");
      if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
        return HttpServerResponse.text("workspaceRoot must be an absolute path", { status: 400 });
      }
      return HttpServerResponse.jsonUnsafe({
        entries: yield* listCarbonWorkspaceEntries(path.resolve(workspaceRoot)),
      });
    }

    if (pathname === "/api/carbon/artifacts/file") {
      const requestedPath = url.value.searchParams.get("path");
      if (!requestedPath || !path.isAbsolute(requestedPath)) {
        return HttpServerResponse.text("path must be an absolute path", { status: 400 });
      }
      const artifactPath = yield* resolveCarbonArtifactFile(requestedPath);
      if (!artifactPath) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return yield* HttpServerResponse.file(artifactPath, {
        status: 200,
        headers: carbonArtifactResponseHeaders(artifactPath),
      }).pipe(
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Internal Server Error", { status: 500 }),
        ),
      );
    }

    return HttpServerResponse.text("Not Found", { status: 404 });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const carbonUploadRouteLayer = HttpRouter.add(
  "POST",
  "/api/carbon/upload",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const workspaceRoot = url.value.searchParams.get("workspaceRoot");
    const name = url.value.searchParams.get("name");
    const path = yield* Path.Path;
    if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
      return HttpServerResponse.text("workspaceRoot must be an absolute path", { status: 400 });
    }
    if (!name) {
      return HttpServerResponse.text("name is required", { status: 400 });
    }

    const contentLength = Option.getOrUndefined(Headers.get(request.headers, "content-length"));
    const sizeBytes = Number(contentLength);
    if (
      contentLength === undefined ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes > MAX_CARBON_UPLOAD_BYTES
    ) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Upload must include a Content-Length no larger than 512 MB" },
        { status: 413 },
      );
    }

    const bytes = new Uint8Array(yield* request.arrayBuffer);
    return yield* saveCarbonUpload(path.resolve(workspaceRoot), name, bytes).pipe(
      Effect.map(HttpServerResponse.jsonUnsafe),
      Effect.orElseSucceed(() =>
        HttpServerResponse.jsonUnsafe({ error: "Upload failed" }, { status: 500 }),
      ),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isDevProxiedPath(url.value.pathname)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
        // SPA entry: always revalidate so a redeploy reaches clients on the
        // next plain reload (assets below are hash-named and cache forever).
        headers: { "cache-control": "no-cache" },
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    const isHashedAsset = staticRelativePath.startsWith("assets/");
    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
      headers: isHashedAsset
        ? { "cache-control": "public, max-age=31536000, immutable" }
        : { "cache-control": "no-cache" },
    });
  }),
);
