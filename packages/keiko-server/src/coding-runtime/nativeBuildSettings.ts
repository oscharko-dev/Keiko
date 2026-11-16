import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import {
  activityLogEvent,
  defineActivityLogOperation,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { processServerLogSink } from "../process-log-sink.js";

// The native run's private HOME hides `~/.m2/settings.xml` (mirrors, proxies), `~/.npmrc` (registry)
// and `~/.gradle/gradle.properties`, so a build behind a corporate mirror cannot resolve anything
// (#4271). They are admitted here as SANITIZED copies: Keiko reads the user's file, keeps only the
// allow-listed network-routing settings and drops everything that can carry a credential. The
// real files stay unreadable to the run (`.npmrc` is a kernel credential deny), nothing is
// written back, and the admission is recorded body-free on the Activity Log.

/** Largest settings file read; a larger one is refused rather than truncated. */
const SETTINGS_BYTES_MAX = 262_144;

export const NATIVE_BUILD_MODES = [
  "governed-assist",
  "supervised-coding",
  "autonomous-delivery",
] as const;

/** Below Full access the run has no network, so the user's warm Maven cache opens read-only. */
export function nativeBuildCacheAdmitted(mode: string | undefined): boolean {
  return mode !== "autonomous-delivery";
}

// ---- Maven settings.xml ---------------------------------------------------------------------

const MAVEN_TOP_LEVEL = new Set([
  "proxies",
  "mirrors",
  "profiles",
  "activeProfiles",
  "pluginGroups",
]);
const MAVEN_SENSITIVE_ELEMENT =
  /(password|passwd|passphrase|token|secret|credential|privatekey|apikey|login|username|auth)/iu;
const XML_TAG = /<[^<>]*>/gu;
const URL_USERINFO = /(:\/\/)[^/\s@<>]*@/gu;

interface MavenSanitized {
  readonly xml: string;
  readonly strippedCount: number;
}

function tagName(tag: string): string {
  const match = /^<\/?\s*([A-Za-z_][\w.-]*)/u.exec(tag);
  return match?.[1] ?? "";
}

/** The user's file without comments; undefined for a construct this scanner does not model. */
function withoutComments(xml: string): string | undefined {
  let out = "";
  let index = 0;
  for (;;) {
    const open = xml.indexOf("<!--", index);
    if (open === -1) return out + xml.slice(index);
    const close = xml.indexOf("-->", open + 4);
    if (close === -1) return undefined;
    out += xml.slice(index, open);
    index = close + 3;
  }
}

interface Scan {
  readonly output: string[];
  /** Open elements, outermost first. */
  readonly stack: string[];
  /** Depth of the element being dropped, or -1. */
  skipDepth: number;
  stripped: number;
}

function dropped(scan: Scan, name: string): boolean {
  if (MAVEN_SENSITIVE_ELEMENT.test(name)) return true;
  // `servers` is not in the top-level allow-list; this covers a sensitive element anywhere else.
  return scan.stack.length === 2 && !MAVEN_TOP_LEVEL.has(name);
}

function scanTag(scan: Scan, tag: string): void {
  const name = tagName(tag);
  const closing = tag.startsWith("</");
  const selfClosing = tag.endsWith("/>");
  if (scan.skipDepth !== -1) {
    if (closing) scan.stack.pop();
    else if (!selfClosing) scan.stack.push(name);
    if (scan.stack.length < scan.skipDepth) scan.skipDepth = -1;
    return;
  }
  if (closing) {
    scan.stack.pop();
    scan.output.push(tag);
    return;
  }
  scan.stack.push(name);
  if (name !== "settings" && dropped(scan, name)) {
    scan.stripped += 1;
    if (selfClosing) scan.stack.pop();
    else scan.skipDepth = scan.stack.length;
    return;
  }
  scan.output.push(tag);
  if (selfClosing) scan.stack.pop();
}

/**
 * A Maven `settings.xml` reduced to its network routing: top-level `proxies`, `mirrors`, `profiles`,
 * `activeProfiles` and `pluginGroups`, with every element whose name suggests a credential removed,
 * URL user-info stripped and `servers` dropped entirely. `localRepository` and `offline` are the
 * run's, never the user's. Undefined when the document is not one this scanner models (DOCTYPE,
 * CDATA, unbalanced): nothing is admitted then.
 */
export function sanitizeMavenSettings(
  xml: string,
  run: MavenRunBinding,
): MavenSanitized | undefined {
  const scan = scanMavenSettings(xml);
  if (scan === undefined) return undefined;
  const body = scan.output.slice(1, -1).join("").replaceAll(URL_USERINFO, "$1");
  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n<settings>\n${runElements(run).join("\n")}\n${body}\n</settings>\n`,
    strippedCount: scan.stripped,
  };
}

interface MavenRunBinding {
  readonly localRepository?: string;
  readonly offline: boolean;
}

function runElements(run: MavenRunBinding): readonly string[] {
  return [
    `<offline>${run.offline ? "true" : "false"}</offline>`,
    ...(run.localRepository === undefined
      ? []
      : [`<localRepository>${escapeXml(run.localRepository)}</localRepository>`]),
  ];
}

/** The scan of a settings document, or undefined when it is not one this scanner models. */
function scanMavenSettings(xml: string): Scan | undefined {
  const bare = withoutComments(xml);
  if (bare === undefined || /<!(?:DOCTYPE|\[CDATA\[)/iu.test(bare)) return undefined;
  const scan: Scan = { output: [], stack: [], skipDepth: -1, stripped: 0 };
  let index = 0;
  for (const match of bare.matchAll(XML_TAG)) {
    if (scan.skipDepth === -1 && scan.stack.length > 0)
      scan.output.push(bare.slice(index, match.index));
    index = match.index + match[0].length;
    if (!match[0].startsWith("<?")) scanTag(scan, match[0]);
  }
  const wellFormed = scan.stack.length === 0 && scan.output[0]?.startsWith("<settings") === true;
  return wellFormed ? scan : undefined;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A run with nothing to carry over still gets the run's own offline and cache bindings. */
export function emptyMavenSettings(run: MavenRunBinding): string {
  return sanitizeMavenSettings("<settings></settings>", run)?.xml ?? "<settings></settings>\n";
}

// ---- .npmrc and gradle.properties -----------------------------------------------------------

const NPM_KEYS = new Set([
  "registry",
  "strict-ssl",
  "cafile",
  "proxy",
  "https-proxy",
  "noproxy",
  "fetch-retries",
  "fetch-retry-mintimeout",
  "fetch-retry-maxtimeout",
  "fetch-timeout",
  "legacy-peer-deps",
  "engine-strict",
  "audit",
  "fund",
  "progress",
  "loglevel",
]);
const NPM_SCOPE_REGISTRY = /^@[a-z0-9][\w.-]*:registry$/iu;
const GRADLE_KEYS = new Set([
  "systemProp.http.proxyHost",
  "systemProp.http.proxyPort",
  "systemProp.http.nonProxyHosts",
  "systemProp.https.proxyHost",
  "systemProp.https.proxyPort",
  "systemProp.https.nonProxyHosts",
  "org.gradle.daemon",
  "org.gradle.parallel",
  "org.gradle.caching",
  "org.gradle.workers.max",
  "org.gradle.configureondemand",
]);

interface KeyValueSanitized {
  readonly text: string;
  readonly keptCount: number;
  readonly dropped: number;
}

function splitKeyValue(line: string): { readonly key: string; readonly value: string } | undefined {
  const index = line.indexOf("=");
  if (index <= 0) return undefined;
  return { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
}

function keptValue(value: string): boolean {
  // `${VAR}` would expand a credential from the environment; a URL with user-info carries one.
  return !value.includes("${") && !/:\/\/[^/\s@]*@/u.test(value);
}

function filterKeyValues(text: string, keep: (key: string) => boolean): KeyValueSanitized {
  const kept: string[] = [];
  let droppedCount = 0;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const pair = splitKeyValue(line);
    if (pair !== undefined && keep(pair.key) && keptValue(pair.value)) {
      kept.push(`${pair.key}=${pair.value}`);
    } else {
      droppedCount += 1;
    }
  }
  return {
    text: kept.join("\n") + (kept.length === 0 ? "" : "\n"),
    keptCount: kept.length,
    dropped: droppedCount,
  };
}

/** An `.npmrc` reduced to registry routing; every `_auth*`, token, password and `//host/:` key goes. */
export function sanitizeNpmrc(text: string): KeyValueSanitized {
  return filterKeyValues(text, (key) => NPM_KEYS.has(key) || NPM_SCOPE_REGISTRY.test(key));
}

/** A `gradle.properties` reduced to proxy and daemon settings; credentials and paths go. */
export function sanitizeGradleProperties(text: string): KeyValueSanitized {
  return filterKeyValues(text, (key) => GRADLE_KEYS.has(key));
}

// ---- admission ------------------------------------------------------------------------------

type FileDisposition = "sanitized" | "absent" | "refused";
const CACHE_DISPOSITIONS = ["read-only", "private", "none"] as const;
type CacheDisposition = (typeof CACHE_DISPOSITIONS)[number];
/** The Maven cache can also be refused: a path Maven would split at its commas is not chained. */
const MAVEN_CACHE_DISPOSITIONS = [...CACHE_DISPOSITIONS, "refused"] as const;
type MavenCacheDisposition = (typeof MAVEN_CACHE_DISPOSITIONS)[number];

const NATIVE_BUILD_SETTINGS_OPERATION = defineActivityLogOperation({
  contractKind: "activity-log-operation",
  schemaVersion: 1,
  op: "coding-runtime.native-build-settings.admitted",
  category: "process",
  owner: "keiko-server",
  emitter: "coding-runtime.nativeBuildSettings.recordNativeBuildSettingsAdmitted",
  fields: {
    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },
    launchMode: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...NATIVE_BUILD_MODES, "unknown"],
    },
    mavenSettings: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["sanitized", "absent", "refused"],
    },
    npmConfig: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["sanitized", "absent", "refused"],
    },
    gradleProperties: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: ["sanitized", "absent", "refused"],
    },
    mavenCache: {
      type: "string",
      dataClass: "closed-enum",
      required: true,
      values: [...MAVEN_CACHE_DISPOSITIONS],
    },
    mavenWrapper: {
      type: "string",
      dataClass: "closed-enum",
      required: false,
      values: [...CACHE_DISPOSITIONS],
    },
    strippedElementCount: { type: "integer", dataClass: "count", required: true },
    droppedLineCount: { type: "integer", dataClass: "count", required: true },
  },
  causal: "correlation",
  lifecycle: "state",
  analyzerProjection: "timeline",
  failureClasses: ["coding-runtime-native-policy"],
  proofIds: ["coding-runtime.native-build-settings.admitted.emitted-line"],
  releaseImpact: "patch",
});

export interface NativeBuildSettingsInput {
  readonly runId: string;
  readonly mode: string | undefined;
  /** The user's real home: only Keiko reads it; the run never sees it. */
  readonly realHome: string;
  /** The run's private state root (`home/`, `config/` live below it). */
  readonly stateRoot: string;
  /** The user's Maven repository when it is admitted read-only (`nativeBuildCacheReadRoots`). */
  readonly readOnlyMavenRepository?: string | undefined;
  /** The Maven wrapper's distributions when admitted read-only (`nativeBuildWrapperReadRoots`). */
  readonly readOnlyMavenWrapperDists?: string | undefined;
  readonly activityLog?: ServerLogSink | undefined;
}

export interface NativeBuildSettingsResult {
  readonly env: Readonly<Record<string, string>>;
  /**
   * The JVM system properties every Java process of the run receives (`JAVA_TOOL_OPTIONS`). Java
   * takes `user.home` from the account database and ignores `HOME`, so without them Maven and Gradle
   * would read the user's real `~/.m2` and `~/.gradle` instead of the run's sanitized settings.
   */
  readonly javaProperties: Readonly<Record<string, string>>;
  readonly mavenSettings: FileDisposition;
  readonly npmConfig: FileDisposition;
  readonly gradleProperties: FileDisposition;
  readonly strippedElementCount: number;
  readonly droppedLineCount: number;
}

type Source =
  { readonly state: "absent" | "refused" } | { readonly state: "read"; readonly text: string };

function readSettingsFile(path: string, runId: string): Source {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > SETTINGS_BYTES_MAX) return { state: "refused" };
    return { state: "read", text: readFileSync(path, "utf8") };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { state: "absent" };
    }
    emitSettingsReadFailure(runId, error);
    return { state: "refused" };
  }
}

/** An unreadable settings source is refused, never copied; the failure is reported with the run's id. */
function emitSettingsReadFailure(runId: string, error: unknown): void {
  emitServerDiagnostic(
    undefined,
    serverDiagnosticFromError({
      correlationId: runId,
      operation: "coding-runtime.native-build-settings",
      source: "coding-runtime.native-build-settings.read",
      error,
      redact: () => "native-build-settings-unreadable",
    }),
  );
}

/** What a sanitizer produces: the text to write and how many elements or lines it removed. */
interface Sanitized {
  readonly text: string;
  readonly dropped: number;
}

interface Admitted<T> {
  readonly disposition: FileDisposition;
  readonly value: T | undefined;
}

/** A source file through its sanitizer: a file the sanitizer does not model is refused, never copied. */
function admit<T>(source: Source, sanitize: (text: string) => T | undefined): Admitted<T> {
  if (source.state !== "read") return { disposition: source.state, value: undefined };
  const value = sanitize(source.text);
  return { disposition: value === undefined ? "refused" : "sanitized", value };
}

function writePrivate(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

/**
 * Writes the sanitized build settings into the run's private state and returns the environment
 * that points the toolchains at them. Maven's settings live at `<home>/.m2/settings.xml` (a name no
 * credential deny covers); npm's user config lives under a name that is not `.npmrc` and is bound
 * with `NPM_CONFIG_USERCONFIG`, because the kernel denies the name `.npmrc` anywhere. Below Full
 * access the sanitized Maven settings run offline, with the user's read-only cache chained behind
 * the run's own repository. Java ignores `HOME`, so `javaProperties` carries the private `user.home`
 * and `GRADLE_USER_HOME` points Gradle at the private home.
 */
export function prepareNativeBuildSettings(
  input: NativeBuildSettingsInput,
): NativeBuildSettingsResult {
  const home = join(input.stateRoot, "home");
  const run = mavenRunBinding(input, home);
  const maven = admit(
    readSettingsFile(join(input.realHome, ".m2", "settings.xml"), input.runId),
    (text) => {
      const sanitized = sanitizeMavenSettings(text, run);
      return sanitized === undefined
        ? undefined
        : { text: sanitized.xml, dropped: sanitized.strippedCount };
    },
  );
  const npm = admit(readSettingsFile(join(input.realHome, ".npmrc"), input.runId), sanitizeNpmrc);
  const gradle = admit(
    readSettingsFile(join(input.realHome, ".gradle", "gradle.properties"), input.runId),
    sanitizeGradleProperties,
  );
  const userConfig = join(input.stateRoot, "config", "npm-user-config");
  writePrivate(join(home, ".m2", "settings.xml"), maven.value?.text ?? emptyMavenSettings(run));
  writeAdmitted(join(home, ".gradle", "gradle.properties"), gradle);
  writeAdmitted(userConfig, npm);
  linkMavenWrapperDists(home, input);
  const result: NativeBuildSettingsResult = {
    env: {
      GRADLE_USER_HOME: join(home, ".gradle"),
      ...(npm.value === undefined ? {} : { NPM_CONFIG_USERCONFIG: userConfig }),
    },
    javaProperties: javaProperties(home, input),
    mavenSettings: maven.disposition,
    npmConfig: npm.disposition,
    gradleProperties: gradle.disposition,
    ...droppedCounts(maven, npm, gradle),
  };
  recordNativeBuildSettingsAdmitted(input, result);
  return result;
}

/**
 * Maven writes into its local repository even offline: the run's own, never the user's cache.
 * Maven interpolates `${...}` in settings, so a run home spelling one omits the element; Maven's
 * default, `${user.home}/.m2/repository`, then names the same private repository.
 */
function mavenRunBinding(input: NativeBuildSettingsInput, home: string): MavenRunBinding {
  const localRepository = join(home, ".m2", "repository");
  return {
    offline: nativeBuildCacheAdmitted(input.mode),
    ...(localRepository.includes("${") ? {} : { localRepository }),
  };
}

/**
 * Below Full access the user's read-only Maven cache is chained behind the run's writable
 * repository (Maven 3.9+ `maven.repo.local.tail`): artifacts resolve from it, and everything Maven
 * writes lands in the run's own repository.
 */
function javaProperties(home: string, input: NativeBuildSettingsInput): Record<string, string> {
  const tail = chainedMavenCache(input);
  return {
    "user.home": home,
    ...(tail === undefined
      ? {}
      : { "maven.repo.local.tail": tail, "maven.repo.local.tail.ignoreAvailability": "true" }),
  };
}

/** The read-only cache Maven chains, when one is admitted; Maven splits the tail at commas. */
function chainedMavenCache(input: NativeBuildSettingsInput): string | undefined {
  const cache = input.readOnlyMavenRepository;
  if (!nativeBuildCacheAdmitted(input.mode) || cache === undefined) return undefined;
  return cache.includes(",") ? undefined : cache;
}

function mavenCacheDisposition(input: NativeBuildSettingsInput): MavenCacheDisposition {
  const disposition = readOnlyDisposition(input.mode, input.readOnlyMavenRepository);
  return disposition === "read-only" && chainedMavenCache(input) === undefined
    ? "refused"
    : disposition;
}

/**
 * `./mvnw` looks for its distribution under `$HOME/.m2/wrapper/dists`; the private home links that
 * name to the user's read-only distributions, so an installed wrapper runs as in a standalone shell.
 */
function linkMavenWrapperDists(home: string, input: NativeBuildSettingsInput): void {
  if (input.readOnlyMavenWrapperDists === undefined) return;
  const link = join(home, ".m2", "wrapper", "dists");
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  // A repeated preparation of the same run root replaces its own link instead of failing.
  rmSync(link, { force: true });
  symlinkSync(input.readOnlyMavenWrapperDists, link, "dir");
}

function readOnlyDisposition(mode: string | undefined, root: string | undefined): CacheDisposition {
  if (!nativeBuildCacheAdmitted(mode)) return "private";
  return root === undefined ? "none" : "read-only";
}

function writeAdmitted(path: string, admitted: Admitted<Sanitized>): void {
  if (admitted.value !== undefined) writePrivate(path, admitted.value.text);
}

function droppedCounts(
  maven: Admitted<Sanitized>,
  npm: Admitted<Sanitized>,
  gradle: Admitted<Sanitized>,
): Pick<NativeBuildSettingsResult, "strippedElementCount" | "droppedLineCount"> {
  const count = (admitted: Admitted<Sanitized>): number => admitted.value?.dropped ?? 0;
  return { strippedElementCount: count(maven), droppedLineCount: count(npm) + count(gradle) };
}

function recordNativeBuildSettingsAdmitted(
  input: NativeBuildSettingsInput,
  result: NativeBuildSettingsResult,
): void {
  const mode = NATIVE_BUILD_MODES.find((value) => value === input.mode);
  (input.activityLog ?? processServerLogSink()).write(
    activityLogEvent(
      NATIVE_BUILD_SETTINGS_OPERATION,
      { correlationId: input.runId },
      {
        runId: input.runId,
        launchMode: mode ?? "unknown",
        mavenSettings: result.mavenSettings,
        npmConfig: result.npmConfig,
        gradleProperties: result.gradleProperties,
        mavenCache: mavenCacheDisposition(input),
        mavenWrapper: readOnlyDisposition(input.mode, input.readOnlyMavenWrapperDists),
        strippedElementCount: result.strippedElementCount,
        droppedLineCount: result.droppedLineCount,
      },
    ),
  );
}
