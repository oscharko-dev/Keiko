// Bind live qualification to a forced native build, independently of the caller's current directory.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { sha256, sha256File } from "../../lib/digest.mjs";
import { buildPackages } from "../../build-packages.mjs";
import { isMainModule } from "../../lib/is-main-module.mjs";
import { REPO_ROOT, parseCli, runMain } from "./lab-common.mjs";
import { writeContinuityJson } from "./chat-continuity-campaign.mjs";

const INPUTS = [
  "packages",
  "src",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "tsconfig.packages.json",
  "scripts/build-packages.mjs",
  "scripts/empty-build-output-allowlist.json",
];
const recordPath = (root) =>
  join(root, "node_modules", ".cache", "keiko-chat-continuity-build.json");

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}
function digestPaths(root, paths) {
  return sha256(JSON.stringify(paths.sort().map((path) => [path, sha256File(join(root, path))])));
}
function sourceIdentity(root) {
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...INPUTS]).trim())
    throw new Error("continuity-product-source-must-be-clean");
  const paths = git(root, ["ls-files", "-z", "--", ...INPUTS])
    .split("\0")
    .filter(Boolean);
  return {
    sourceHead: git(root, ["rev-parse", "HEAD"]).trim(),
    productTreeDigest: digestPaths(root, paths),
  };
}
function distributionFiles(root, directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return distributionFiles(root, path);
    if (!entry.isFile()) throw new Error("continuity-build-output-must-be-regular");
    return [relative(root, path).replaceAll("\\", "/")];
  });
}
function currentIdentity(root) {
  const configs = JSON.parse(readFileSync(join(root, "tsconfig.packages.json"), "utf8"));
  const paths = configs.references.flatMap(({ path }) => {
    if (!/^\.\/packages\/[a-z0-9-]+\/tsconfig\.json$/u.test(path))
      throw new Error("continuity-build-project-path-invalid");
    return distributionFiles(root, join(root, dirname(path), "dist"));
  });
  if (paths.length === 0) throw new Error("continuity-build-output-missing");
  return {
    ...sourceIdentity(root),
    productDigestMethod: "sorted-tracked-input-paths-and-sha256-v1",
    distributionDigest: digestPaths(root, paths),
    compilerDigest: sha256File(join(root, "node_modules", "@typescript", "native", "package.json")),
    nodeVersion: process.version,
  };
}

export function recordContinuityBuild(
  root = REPO_ROOT,
  runBuild = (directory) => buildPackages({ root: directory }),
) {
  const before = sourceIdentity(root);
  runBuild(root);
  const identity = currentIdentity(root);
  if (before.productTreeDigest !== identity.productTreeDigest)
    throw new Error("continuity-product-source-changed-during-build");
  const record = { schemaVersion: 1, producer: "native-forced-packages-build", ...identity };
  mkdirSync(dirname(recordPath(root)), { recursive: true });
  writeContinuityJson(recordPath(root), record);
  return record;
}

export function readContinuityBuildIdentity(root = REPO_ROOT) {
  const current = currentIdentity(root);
  let record;
  try {
    record = JSON.parse(readFileSync(recordPath(root), "utf8"));
  } catch {
    throw new Error("continuity-build-provenance-required");
  }
  const fields = [
    "productTreeDigest",
    "distributionDigest",
    "compilerDigest",
    "nodeVersion",
    "productDigestMethod",
  ];
  if (
    record?.schemaVersion !== 1 ||
    record.producer !== "native-forced-packages-build" ||
    !/^[a-f0-9]{40}$/u.test(record.sourceHead ?? "") ||
    fields.some((field) => record[field] !== current[field])
  )
    throw new Error("continuity-build-provenance-stale");
  return { ...current, buildProvenance: record };
}

async function main() {
  const cli = parseCli({
    usage:
      "chat-continuity-build.mjs --build (run before starting other consumers of package dist)",
    options: { build: { type: "boolean" } },
  });
  if (cli.help) return;
  if (!cli.values.build) throw new Error("explicit-build-required");
  console.log(JSON.stringify(recordContinuityBuild()));
}
if (isMainModule(import.meta.url)) runMain(main);
