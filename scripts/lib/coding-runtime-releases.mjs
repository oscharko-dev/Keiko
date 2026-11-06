// The reviewed optional npm coding-runtime releases (docs/release/coding-runtime-npm-packages.json)
// and the product release gate that reads them. Kept apart from the runtime publisher so the
// product publisher can apply the gate without loading the runtime package builder.
import { compareStrings } from "./compare-strings.mjs";

export const CODING_RUNTIME_RELEASES_FILE = "docs/release/coding-runtime-npm-packages.json";
const CODING_RUNTIME_PACKAGE_PREFIX = "@oscharko-dev/keiko-coding-runtime-";
const VERSION = /^\d+\.\d+\.\d+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u;

function hasPinnedBytes(entry) {
  return (
    SHA256.test(entry.sha256 ?? "") &&
    INTEGRITY.test(entry.integrity ?? "") &&
    Number.isSafeInteger(entry.sizeBytes) &&
    entry.sizeBytes > 0
  );
}

function checkedEntry(target, entry, version) {
  const valid =
    typeof entry?.name === "string" &&
    entry.tarball === `${entry.name.slice(1).replace("/", "-")}-${version}.tgz` &&
    hasPinnedBytes(entry) &&
    VERSION.test(entry.opencodeVersion ?? "");
  if (!valid) throw new TypeError(`reviewed ${target} entry for ${version} is malformed`);
  return { target, ...entry };
}

/** The reviewed pins of one version, by target; any other version or shape is refused. */
export function reviewedRelease(document, version) {
  if (!VERSION.test(version)) throw new TypeError(`runtime version ${version} is not x.y.z`);
  const release = document?.schemaVersion === 1 ? document.releases?.[version] : undefined;
  const targets = Object.keys(release ?? {}).sort(compareStrings);
  if (targets.length === 0) throw new TypeError(`runtime version ${version} was never reviewed`);
  return targets.map((target) => checkedEntry(target, release[target], version));
}

/**
 * The product release gate for the optional npm coding runtimes. A product release installs the
 * runtime packages its manifest pins, not the OpenCode the checkout approves, so a release cut
 * after an OpenCode upgrade but before the new runtime packages are published and selected would
 * ship the previous engine to every npm installation without a word. Every pinned runtime package
 * must be a reviewed version that carries the currently approved OpenCode. Returns the failures.
 */
export function selectedCodingRuntimeFailures(rootManifest, document, currentOpenCodeVersion) {
  const failures = [];
  const pins = Object.entries(rootManifest?.optionalDependencies ?? {}).filter(([name]) =>
    name.startsWith(CODING_RUNTIME_PACKAGE_PREFIX),
  );
  if (pins.length === 0) failures.push("no optional npm coding-runtime package is pinned");
  for (const [name, version] of pins) {
    let entry;
    try {
      entry = reviewedRelease(document, version).find((candidate) => candidate.name === name);
    } catch (error) {
      failures.push(`${name}@${version}: ${error instanceof Error ? error.message : "unreadable"}`);
      continue;
    }
    if (entry === undefined) {
      failures.push(`${name}@${version} is not a reviewed runtime package`);
    } else if (entry.opencodeVersion !== currentOpenCodeVersion) {
      failures.push(
        `${name}@${version} carries OpenCode ${entry.opencodeVersion}, but this release approves ` +
          `${currentOpenCodeVersion}: publish the runtime packages built from the current pin and ` +
          "select them first (docs/release/release-publish-workflow.md)",
      );
    }
  }
  return failures;
}
