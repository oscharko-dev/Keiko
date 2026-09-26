import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PORTABLE_TARGET_NAMES, reviewedStagingEntryMatches } from "./portable-runtime.mjs";

// Decides whether a dev push can rehearse the stable portable release at all. A tagged run stages
// every target from the reviewed release-impact entry of the current version; when that approval does
// not exist yet, the rehearsal reports a named "not releasable" status and stops without failing, so
// the lane keeps meaning something between two releases instead of standing red.

const STABLE_OR_PRERELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

class PortableRehearsalReadinessError extends Error {}

function fail(message) {
  throw new PortableRehearsalReadinessError(`portable-rehearsal-readiness: ${message}`);
}

export function portableRehearsalReadiness({ catalog, rootPackage }) {
  if (
    typeof rootPackage?.name !== "string" ||
    !STABLE_OR_PRERELEASE_VERSION.test(rootPackage.version)
  ) {
    fail("root package identity is invalid");
  }
  if (!Array.isArray(catalog?.entries)) fail("release-impact catalog entries are invalid");
  const releaseTag = `v${rootPackage.version}`;
  if (rootPackage.version.includes("-")) {
    return {
      ready: false,
      releaseTag,
      reason: `${releaseTag} is a prerelease, and the stable lane rehearses stable versions only`,
    };
  }
  const unstaged = PORTABLE_TARGET_NAMES.filter(
    (target) =>
      catalog.entries.filter((entry) =>
        reviewedStagingEntryMatches(entry, rootPackage, releaseTag, target),
      ).length !== 1,
  );
  if (unstaged.length > 0) {
    return {
      ready: false,
      releaseTag,
      reason: `no single reviewed and approved release-impact entry stages ${unstaged.join(", ")} for ${releaseTag}`,
    };
  }
  return { ready: true, releaseTag, reason: `${releaseTag} is approved for every portable target` };
}

export function runPortableRehearsalReadiness(root = process.cwd(), env = process.env) {
  const rootPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const catalog = JSON.parse(readFileSync(resolve(root, "release-impact.catalog.json"), "utf8"));
  const result = portableRehearsalReadiness({ catalog, rootPackage });
  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `ready=${String(result.ready)}\nrelease-tag=${result.releaseTag}\n`,
    );
  }
  const line = result.ready
    ? `Release rehearsal: ${result.reason}.`
    : `Not releasable yet: ${result.reason}. The rehearsal stops here without failing.`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  process.stdout.write(`${line}\n`);
  return result;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    runPortableRehearsalReadiness();
  } catch (error) {
    process.stderr.write(
      `${error instanceof PortableRehearsalReadinessError ? error.message : "portable-rehearsal-readiness: unreadable package or catalog"}\n`,
    );
    process.exitCode = 1;
  }
}
