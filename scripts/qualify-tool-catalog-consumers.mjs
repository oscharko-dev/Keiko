import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { catalogCloseoutHead } from "./check-tool-catalog-closeout.mjs";
import { compareStrings } from "./lib/compare-strings.mjs";
import { sha256File } from "./lib/digest.mjs";
import { sha256 } from "./lib/digest.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import {
  TOOL_CATALOG_QUALIFICATION_COMPONENTS,
  TOOL_CATALOG_QUALIFICATION_DIR_ENV,
  TOOL_CATALOG_QUALIFICATION_HEAD_ENV,
  TOOL_CATALOG_QUALIFICATION_PACKAGES,
  validToolCatalogQualificationOutcome,
} from "./lib/tool-catalog-qualification-observation.mjs";

const MAX_ARCHIVE_OUTPUT_BYTES = 128 * 1024 * 1024;

const CONSUMER_TEST_FILES = Object.freeze([
  "packages/keiko-harness/src/catalog-runtime.test.ts",
  "packages/keiko-cli/src/run.test.ts",
  "packages/keiko-server/src/run-engine.test.ts",
  "packages/keiko-sdk/src/run-agent-catalog.test.ts",
  "packages/keiko-server/src/coding-runtime/productionReadOnlyChildRunner.test.ts",
  "packages/keiko-server/src/editor/agentProducerRoute.test.ts",
]);
const OBSERVATION_FIELDS = Object.freeze([
  "schemaVersion",
  "sourceHead",
  "consumer",
  "component",
  "binding",
  "terminalStatus",
  "settlementCount",
  "proof",
]);

function exactFields(value, fields, message) {
  requireQualification(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      isDeepStrictEqual(Object.keys(value).sort(compareStrings), [...fields].sort(compareStrings)),
    message,
  );
}

function validateBinding(binding) {
  exactFields(
    binding,
    ["catalogRevision", "profile", "projectionDigest", "handlerSetDigest"],
    "binding has unexpected fields",
  );
  exactFields(binding.profile, ["id", "version"], "profile has unexpected fields");
  requireQualification(
    /^[a-f0-9]{64}$/u.test(binding.catalogRevision) &&
      /^[a-f0-9]{64}$/u.test(binding.projectionDigest) &&
      /^[a-f0-9]{64}$/u.test(binding.handlerSetDigest) &&
      /^[a-z][a-z0-9-]{0,63}$/u.test(binding.profile.id) &&
      Number.isSafeInteger(binding.profile.version) &&
      binding.profile.version > 0,
    "binding is invalid",
  );
}

function requireQualification(condition, message) {
  if (!condition) throw new TypeError(`Tool catalog consumer qualification: ${message}`);
}

function observationFile(consumer, component) {
  return `${consumer}.${component}.observation.json`;
}

function readObservation(directory, consumer, component, currentHead) {
  const value = JSON.parse(
    readFileSync(join(directory, observationFile(consumer, component)), "utf8"),
  );
  requireQualification(
    isDeepStrictEqual(
      Object.keys(value).sort(compareStrings),
      [...OBSERVATION_FIELDS].sort(compareStrings),
    ),
    "observation has unexpected fields",
  );
  validateBinding(value.binding);
  const proofFields =
    value.proof?.kind === "managed-search-read"
      ? ["kind", "searchSettled", "boundedReadSettled", "causalHandoff"]
      : ["kind"];
  exactFields(value.proof, proofFields, `${component} proof has unexpected fields`);
  requireQualification(
    value.schemaVersion === 1 &&
      value.sourceHead === currentHead &&
      value.consumer === consumer &&
      value.component === component,
    `${component} observation has stale identity`,
  );
  requireQualification(
    validToolCatalogQualificationOutcome(
      component,
      value.terminalStatus,
      value.settlementCount,
      value.proof,
    ),
    `${component} has incomplete canonical execution proof`,
  );
  return value;
}

function bindingFor(observations, consumer) {
  const binding = observations[0]?.binding;
  requireQualification(
    binding !== undefined &&
      observations.every((entry) => isDeepStrictEqual(entry.binding, binding)),
    `${consumer} component bindings differ`,
  );
  return binding;
}

export function readToolCatalogQualificationObservations(directory, currentHead) {
  const expectedFiles = Object.entries(TOOL_CATALOG_QUALIFICATION_COMPONENTS).flatMap(
    ([consumer, components]) => components.map((component) => observationFile(consumer, component)),
  );
  requireQualification(
    isDeepStrictEqual(
      readdirSync(directory).sort(compareStrings),
      expectedFiles.sort(compareStrings),
    ),
    "observation inventory is incomplete or contains unknown files",
  );
  return new Map(
    Object.entries(TOOL_CATALOG_QUALIFICATION_COMPONENTS).map(([consumer, components]) => {
      const observations = components.map((component) =>
        readObservation(directory, consumer, component, currentHead),
      );
      return [consumer, { observations, binding: bindingFor(observations, consumer) }];
    }),
  );
}

export function buildToolCatalogConsumerReports({
  currentHead,
  artifactDigest,
  platform,
  runtime,
  observations,
  packageEvidence,
}) {
  requireQualification(
    packageEvidence instanceof Map &&
      [...observations.keys()].every((consumer) => packageEvidence.has(consumer)),
    "packaged evidence is incomplete",
  );
  return new Map(
    [...observations].map(([consumer, evidence]) => [
      consumer,
      {
        schemaVersion: 1,
        currentHead,
        artifactDigest,
        platform,
        runtime,
        executionKind: consumer === "managed-opencode" ? "real-runtime" : "production-composition",
        status: "passed",
        passed: evidence.observations.length,
        failed: 0,
        skipped: 0,
        binding: evidence.binding,
        components: evidence.observations.map(
          ({ component, terminalStatus, settlementCount, proof }) => ({
            component,
            terminalStatus,
            settlementCount,
            proof,
          }),
        ),
        packages: packageEvidence.get(consumer),
      },
    ]),
  );
}

function tarOutput(args, input) {
  return execFileSync(resolveHostExecutable("tar"), args, {
    ...(input === undefined ? {} : { input }),
    maxBuffer: MAX_ARCHIVE_OUTPUT_BYTES,
  });
}

function archiveEntry(archive, entry) {
  return tarOutput(["-xOzf", archive, entry]);
}

function nestedEntry(archive, entry) {
  return tarOutput(["-xOzf", "-", entry], archive);
}

function filesUnder(directory) {
  const files = [];
  const visit = (current) => {
    for (const name of readdirSync(current).sort(compareStrings)) {
      const path = join(current, name);
      const stat = lstatSync(path);
      requireQualification(
        stat.isDirectory() || stat.isFile(),
        "built dist contains special files",
      );
      if (stat.isDirectory()) visit(path);
      else files.push(relative(directory, path).split("\\").join("/"));
    }
  };
  visit(directory);
  return files;
}

function packageDirectory(name) {
  const match = /^@oscharko-dev\/(?<directory>[a-z0-9-]+)$/u.exec(name);
  requireQualification(match?.groups?.directory !== undefined, "unexpected workspace package");
  return match.groups.directory;
}

function inspectWorkspaceArchive(root, name, archiveBytes) {
  const directory = join(root, "packages", packageDirectory(name), "dist");
  const files = filesUnder(directory);
  const entries = tarOutput(["-tzf", "-"], archiveBytes)
    .toString("utf8")
    .split("\n")
    .filter((entry) => entry.startsWith("package/dist/") && !entry.endsWith("/"))
    .map((entry) => entry.slice("package/dist/".length))
    .sort(compareStrings);
  requireQualification(
    isDeepStrictEqual(entries, files),
    `${name} packaged dist inventory is stale`,
  );
  const fileDigests = files.map((file) => {
    const packaged = nestedEntry(archiveBytes, `package/dist/${file}`);
    const built = readFileSync(join(directory, file));
    requireQualification(packaged.equals(built), `${name} packaged dist bytes are stale`);
    return [file, sha256(built)];
  });
  return {
    name,
    archiveDigest: sha256(archiveBytes),
    fileCount: files.length,
    filesDigest: sha256(JSON.stringify(fileDigests)),
  };
}

/** Proves the staged artifact contains the exact built package bytes exercised at this head. */
export function inspectToolCatalogQualificationPackage(root, artifactPath) {
  const manifest = JSON.parse(archiveEntry(artifactPath, "package/package.json").toString("utf8"));
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  requireQualification(
    manifest.name === rootManifest.name && manifest.version === rootManifest.version,
    "qualified package identity is stale",
  );
  const packages = new Map();
  for (const name of new Set(Object.values(TOOL_CATALOG_QUALIFICATION_PACKAGES).flat())) {
    const descriptor = manifest.dependencies?.[name];
    requireQualification(
      typeof descriptor === "string" && /^file:vendor\/[^/]+\.tgz$/u.test(descriptor),
      `${name} is missing from the staged package`,
    );
    const archiveBytes = archiveEntry(artifactPath, `package/${descriptor.slice("file:".length)}`);
    packages.set(name, inspectWorkspaceArchive(root, name, archiveBytes));
  }
  return new Map(
    Object.entries(TOOL_CATALOG_QUALIFICATION_PACKAGES).map(([consumer, names]) => [
      consumer,
      names.map((name) => packages.get(name)),
    ]),
  );
}

function writeReports(directory, reports, recordedAt) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [consumer, report] of reports) {
    writeFileSync(join(directory, `${consumer}.artifact`), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    writeFileSync(
      join(directory, `${consumer}.receipt.json`),
      `${JSON.stringify(
        {
          scenarioId: consumer,
          commitSha: report.currentHead,
          platform: report.platform,
          testStatus: "passed",
          recordedAt,
          provenance: report.executionKind,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
}

export function runNonManagedConsumerTests(root, observationsDir, currentHead) {
  const env = {
    ...process.env,
    [TOOL_CATALOG_QUALIFICATION_DIR_ENV]: observationsDir,
    [TOOL_CATALOG_QUALIFICATION_HEAD_ENV]: currentHead,
  };
  for (const file of CONSUMER_TEST_FILES) {
    execFileSync("npm", ["exec", "vitest", "run", "--", file, "--reporter=dot"], {
      cwd: root,
      env,
      stdio: "inherit",
    });
  }
}

function requiredPath(argv, flag) {
  const index = argv.indexOf(flag);
  requireQualification(index >= 0 && typeof argv[index + 1] === "string", `missing ${flag}`);
  return resolve(argv[index + 1]);
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const root = process.cwd();
  const currentHead = catalogCloseoutHead(root);
  const observationsDir = requiredPath(argv, "--observations");
  if (argv.includes("--run-nonmanaged")) {
    runNonManagedConsumerTests(root, observationsDir, currentHead);
  }
  const artifactPath = requiredPath(argv, "--artifact");
  const receiptsDir = requiredPath(argv, "--receipts");
  const observations = readToolCatalogQualificationObservations(observationsDir, currentHead);
  const reports = buildToolCatalogConsumerReports({
    currentHead,
    artifactDigest: sha256File(artifactPath),
    platform: `${process.platform}-${process.arch}`,
    runtime: {
      node: process.versions.node,
      product: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    },
    observations,
    packageEvidence: inspectToolCatalogQualificationPackage(root, artifactPath),
  });
  writeReports(receiptsDir, reports, new Date().toISOString());
  console.log("Tool catalog consumer qualification: PASS");
}
