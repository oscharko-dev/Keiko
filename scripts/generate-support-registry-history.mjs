#!/usr/bin/env node
// Captures the Activity Log registry of every stable Keiko release that `keiko support analyze`
// must keep validating: each tag v<X> with FIRST_SUPPORTED_RELEASE <= X <= the current product
// version. A tag only discovers a release; the shipped history pins that release's commit, and
// scripts/__tests__/support-registry-history.test.mjs proves every pinned snapshot is that commit's
// exact registry and that no release older than the current version is missing. `npm run
// set-version` regenerates this file, so a release can never ship without its predecessors'
// registries. Runtime admission never accepts a reporter-supplied schema.
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { URL, fileURLToPath } from "node:url";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { compareStableVersions, parseStableVersion } from "./lib/stable-version.mjs";

export const FIRST_SUPPORTED_RELEASE = "1.1.9";
// Inflating a shipped snapshot is bounded at runtime by exactly this ceiling; a release whose
// decoded registry would not fit fails here, at generation, never inside an operator's analysis.
export const MAX_DECODED_SNAPSHOT_BYTES = 4 * 1024 * 1024;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HISTORY_PATH = fileURLToPath(
  new URL(
    "../packages/keiko-activity-log/src/reader/support-registry-history.generated.ts",
    import.meta.url,
  ),
);
const CATALOG_PATH = "docs/observability/op-catalog.generated.json";

function git(execute, args) {
  return execute(resolveHostExecutable("git"), args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function belowBound(release, bound) {
  const order = compareStableVersions(release, bound.release);
  return order < 0 || (bound.inclusive && order === 0);
}

function requiredStableVersion(value, label) {
  const parsed = parseStableVersion(value);
  if (parsed === undefined) throw new TypeError(`${label} is not a stable product version`);
  return parsed;
}

const PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const PRODUCT_VERSION = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?$`,
  "u",
);

// The current product version bounds the history. A stable version includes its own tag once it
// exists; a prerelease precedes its release (SemVer 11), so its history ends strictly below it.
function currentReleaseBound(version) {
  const match = PRODUCT_VERSION.exec(version);
  if (match === null) throw new TypeError("the current version is not a product version");
  return {
    release: match.slice(1, 4).map((part) => Number.parseInt(part, 10)),
    inclusive: match[4] === undefined,
  };
}

/** Stable release tags from the first supported release up to the current product version. */
export function supportedReleases(version, execute = execFileSync) {
  const bound = currentReleaseBound(version);
  const floor = requiredStableVersion(FIRST_SUPPORTED_RELEASE, "the first supported release");
  const releases = git(execute, ["tag", "--list", "v[0-9]*"])
    .split(/\r?\n/u)
    .map((tag) => ({ tag, parsed: parseStableVersion(tag.trim()) }))
    .filter(
      ({ parsed }) =>
        parsed !== undefined &&
        compareStableVersions(parsed, floor) >= 0 &&
        belowBound(parsed, bound),
    )
    .sort((left, right) => compareStableVersions(left.parsed, right.parsed));
  if (releases.length === 0 && compareStableVersions(bound.release, floor) > 0) {
    throw new Error(
      "support-registry-history: no release tag is available; fetch the tags (git fetch --tags).",
    );
  }
  return releases.map(({ tag, parsed }) => ({
    release: parsed.join("."),
    sourceCommit: git(execute, ["rev-parse", "--verify", `${tag.trim()}^{commit}`]).trim(),
  }));
}

function releaseCatalog(execute, release, sourceCommit) {
  try {
    return git(execute, ["show", `${sourceCommit}:${CATALOG_PATH}`]);
  } catch (error) {
    throw new Error(
      `support-registry-history: release ${release} (${sourceCommit}) is not available locally; ` +
        "this needs a full clone with its release tags.",
      { cause: error },
    );
  }
}

// The registration and emitter source anchors locate code in the producing tree; the reader never
// uses them, exactly as the runtime registry omits them.
function readerOperation({ registrationSite: _site, emitterSites: _emitters, ...operation }) {
  return operation;
}

/** One snapshot per distinct registry identity, from the oldest release that shipped it. */
export function captureSupportRegistries(releases, execute = execFileSync) {
  const snapshots = [];
  const seen = new Set();
  for (const { release, sourceCommit } of releases) {
    if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) {
      throw new TypeError("Expected a release commit SHA");
    }
    const registry = JSON.parse(releaseCatalog(execute, release, sourceCommit)).typedRegistry;
    if (seen.has(registry.catalogDigest)) continue;
    seen.add(registry.catalogDigest);
    const identity = {
      registryVersion: registry.schemaVersion,
      schemaDigest: registry.schemaDigest,
      catalogDigest: registry.catalogDigest,
    };
    const text = JSON.stringify({
      ...identity,
      operations: registry.operations.map(readerOperation),
      classes: registry.failureClassCoverage.classes,
    });
    if (Buffer.byteLength(text) > MAX_DECODED_SNAPSHOT_BYTES) {
      throw new RangeError(`the ${release} registry exceeds the decoded snapshot ceiling`);
    }
    snapshots.push({
      release,
      sourceCommit,
      ...identity,
      payload: deflateSync(text, { level: 9 }).toString("base64"),
    });
  }
  return snapshots;
}

function releaseRange(snapshots) {
  if (snapshots.length === 0) return "none";
  const first = snapshots[0].release;
  const last = snapshots.at(-1).release;
  return first === last ? first : `${first}–${last}`;
}

function renderSupportRegistryHistory(snapshots) {
  return `// Generated by scripts/generate-support-registry-history.mjs from the stable release tags.
// Supported releases ${releaseRange(snapshots)}. Never reporter schemas. Regenerated by set-version.
export const MAX_DECODED_SUPPORT_REGISTRY_SNAPSHOT_BYTES = ${String(MAX_DECODED_SNAPSHOT_BYTES)};

export const SUPPORT_RELEASE_REGISTRY_SNAPSHOTS = ${JSON.stringify(snapshots, null, 2)} as const;
`;
}

function currentVersion() {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

export async function generateSupportRegistryHistory({
  version = currentVersion(),
  destination = HISTORY_PATH,
  execute = execFileSync,
  write = writeFileSync,
} = {}) {
  const snapshots = captureSupportRegistries(supportedReleases(version, execute), execute);
  const { format } = await import("prettier");
  write(
    destination,
    await format(renderSupportRegistryHistory(snapshots), {
      parser: "typescript",
      printWidth: 100,
    }),
  );
  return snapshots;
}

export async function main(generate = generateSupportRegistryHistory, io = process.stdout) {
  const snapshots = await generate();
  io.write(
    `support-registry-history: captured ${String(snapshots.length)} release registr` +
      `${snapshots.length === 1 ? "y" : "ies"} (${releaseRange(snapshots)}).\n`,
  );
  return snapshots.length;
}

if (isMainModule(import.meta.url)) await main();
