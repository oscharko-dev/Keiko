// The instrument of a run (#4209): which lab code measured, and which product build was measured.
//
// `instrumentDigest` is a SHA-256 over the lab sources that decide what a run measures. Two runs are
// comparable only when it is equal, whatever else the checkout contains: a documentation or corpus
// tooling commit must not make yesterday's baseline incomparable, and a changed scorer or driver
// must. The git head of the lab is recorded beside it for people; the digest is what the judge
// compares. `productDistDigest` covers the built JavaScript of the subject checkout, because the
// product runs from `packages/*/dist`, which a git head alone does not pin.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { compareStrings } from "../../lib/compare-strings.mjs";

const LAB_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/** The lab files that decide what a run measures, in the order they are digested. */
export const INSTRUMENT_FILES = Object.freeze([
  "corpus/holdout.mjs",
  "corpus/sequence.mjs",
  "corpus/values.mjs",
  "driver.mjs",
  "evidence-scan.mjs",
  "gateway-calls.mjs",
  "instance.mjs",
  "isolation.mjs",
  "log-text.mjs",
  "progress.mjs",
  "report.mjs",
  "run.mjs",
  "scenario.mjs",
  "score.mjs",
  "scripted-model.mjs",
  "set-files.mjs",
  "unit-failure.mjs",
]);

/** SHA-256 over the name and the content of each file, so a rename and an edit both change it. */
export function digestFiles(names, read) {
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name);
    hash.update("\0");
    hash.update(read(name));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** The digest of this checkout's instrument files. */
export function instrumentDigest() {
  return digestFiles(INSTRUMENT_FILES, (name) => readFileSync(join(LAB_DIRECTORY, name)));
}

function* walk(directory) {
  const entries = readdirSync(directory, { withFileTypes: true }).toSorted((left, right) =>
    compareStrings(left.name, right.name),
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && entry.name.endsWith(".js")) yield path;
  }
}

/**
 * SHA-256 over every built `.js` file under `packages/<name>/dist` of a checkout, by path relative to
 * the checkout; "unavailable" when there is no built package, which also means the product cannot run.
 */
export function productDistDigest(root) {
  const packages = join(root, "packages");
  if (!existsSync(packages)) return "unavailable";
  const dists = readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packages, entry.name, "dist"))
    .filter((dist) => existsSync(dist))
    .toSorted(compareStrings);
  const files = dists.flatMap((dist) => [...walk(dist)]);
  if (files.length === 0) return "unavailable";
  return digestFiles(
    files.map((file) => relative(root, file)),
    (name) => readFileSync(join(root, name)),
  );
}
