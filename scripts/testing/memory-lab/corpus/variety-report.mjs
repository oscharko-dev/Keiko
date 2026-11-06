// Variety report over one or more built corpora (#4208).
//
//   node scripts/testing/memory-lab/corpus/variety-report.mjs --corpus <dir>[,<dir>...]
//
// A corpus built by one generator reports that generator's own figures in its manifest. A corpus from
// several generators is several builds, one directory each; this report reads them together, checks
// every scenario file against the digest in its manifest, and prints the near-duplicate rate, the
// generator share, the turn length spread and the type-token ratio over the union as JSON.
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runMain } from "../../coding-workbench-lab/lab-common.mjs";
import { scenarioDigest, validateScenario } from "../scenario.mjs";
import { varietyReport } from "./variety.mjs";

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${what} is missing or not valid JSON (${error.code ?? error.name})`, {
      cause: error,
    });
  }
}

function scenarioPath(directory, file) {
  const root = resolve(directory);
  const path = resolve(root, String(file));
  if (!path.startsWith(`${root}${sep}scenarios${sep}`))
    throw new RangeError(`a manifest entry points outside ${root}`);
  return path;
}

function recordOf(directory, entry) {
  const scenario = validateScenario(readJson(scenarioPath(directory, entry.file), entry.file));
  if (scenarioDigest(scenario) !== entry.digest)
    throw new Error(`${entry.file} differs from the digest in its manifest`);
  return { generator: entry.generator, userTexts: scenario.turns.map((turn) => turn.user) };
}

/** The union variety figures of built corpora, with the version of each corpus. */
export function corpusVariety(directories) {
  if (directories.length === 0) throw new RangeError("--corpus needs at least one directory");
  const manifests = directories.map((directory) => ({
    directory,
    manifest: readJson(resolve(directory, "manifest.json"), `${directory}/manifest.json`),
  }));
  const records = manifests.flatMap(({ directory, manifest }) =>
    manifest.entries.map((entry) => recordOf(directory, entry)),
  );
  return {
    corpusVersions: manifests.map(({ manifest }) => manifest.corpusVersion),
    ...varietyReport(records),
  };
}

async function main() {
  const { values } = parseArgs({ options: { corpus: { type: "string" } } });
  if (!values.corpus) throw new RangeError("usage: variety-report.mjs --corpus <dir>[,<dir>...]");
  const directories = values.corpus.split(",").map((directory) => directory.trim());
  console.log(JSON.stringify(corpusVariety(directories), null, 2));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(main);
