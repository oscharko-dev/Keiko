import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readRepoJson(...segments) {
  return JSON.parse(readFileSync(join(REPO_ROOT, ...segments), "utf8"));
}

/** The OpenCode version this checkout approves for its managed coding runtime. */
export function approvedOpenCodeVersion() {
  return readRepoJson("portable-runtime-approvals.json").sidecarRuntimes.find(
    (runtime) => runtime.name === "opencode-compatible",
  ).upstream.version;
}

/**
 * The reviewed runtime pins as they stand once the runtime packages the root manifest selects
 * carry `opencodeVersion`: by default the OpenCode this checkout approves, so the release
 * orchestrator's runtime-selection gate (#4271) passes and a scenario reaches what it tests. A
 * scenario about that gate passes another version.
 */
export function codingRuntimeReleasesForPublishTest(opencodeVersion = approvedOpenCodeVersion()) {
  const document = readRepoJson("docs", "release", "coding-runtime-npm-packages.json");
  const manifest = readRepoJson("package.json");
  const releases = { ...document.releases };
  for (const [name, version] of Object.entries(manifest.optionalDependencies ?? {})) {
    if (!name.startsWith("@oscharko-dev/keiko-coding-runtime-")) continue;
    const release = releases[version] ?? {};
    releases[version] = Object.fromEntries(
      Object.entries(release).map(([target, entry]) => [target, { ...entry, opencodeVersion }]),
    );
  }
  return { ...document, releases };
}

/**
 * Writes those pins to a private file and returns the environment that hands it to
 * `scripts/release-publish.mjs`. The orchestrator honours the override only under NODE_ENV=test.
 */
export function codingRuntimeReleasesEnvForPublishTest(
  releases = codingRuntimeReleasesForPublishTest(),
) {
  const file = join(
    mkdtempSync(join(tmpdir(), "keiko-coding-runtime-releases-")),
    "coding-runtime-npm-packages.json",
  );
  writeFileSync(file, JSON.stringify(releases), "utf8");
  return { NODE_ENV: "test", KEIKO_CODING_RUNTIME_RELEASES_PATH: file };
}
