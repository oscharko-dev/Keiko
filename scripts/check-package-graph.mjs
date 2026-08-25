import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { collectWorkspacePackages } from "./workspace-graph.mjs";

const UI_PACKAGE = "@oscharko-dev/keiko-ui";
const NATIVE_TSC = "node node_modules/@typescript/native/bin/tsc";
const BUILD_PACKAGES_SCRIPT =
  "npm run check:typescript-toolchain && node scripts/build-packages.mjs";
const TYPECHECK_SCRIPT = `npm run build:packages && npm run check:package-graph && ${NATIVE_TSC} -p tsconfig.json --noEmit`;
const ALLOWED_WORKSPACE_DEPENDENCIES = new Map([
  [
    "@oscharko-dev/keiko-cli",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-model-gateway",
      "@oscharko-dev/keiko-workspace",
      "@oscharko-dev/keiko-tools",
      "@oscharko-dev/keiko-harness",
      "@oscharko-dev/keiko-workflows",
      "@oscharko-dev/keiko-evaluations",
      "@oscharko-dev/keiko-evidence",
      "@oscharko-dev/keiko-sdk",
      "@oscharko-dev/keiko-server",
      "@oscharko-dev/keiko-verification",
      "@oscharko-dev/keiko-memory-vault",
    ],
  ],
  // Governed Atlassian connector domain leaf (ADR-0128 D1): credential custody over the shared
  // secret vault, the injectable AtlassianHttpPort seam, and the bounded verification probe. It
  // may depend only on keiko-contracts and keiko-security — never on keiko-model-gateway,
  // keiko-local-knowledge, or the server; keiko-server is the sole composition root that
  // implements its ports (vault, metadata store, gatewayFetch-backed transport).
  [
    "@oscharko-dev/keiko-connectors",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  ["@oscharko-dev/keiko-contracts", []],
  // Reusable OS/container egress-isolation strategy (ADR-0043). A near-leaf: its only workspace
  // dependency is keiko-contracts (for the SandboxPolicy/attestation types). Spawning stays in
  // keiko-tools, which depends on this package to apply the wrapper at the single exec boundary.
  ["@oscharko-dev/keiko-sandbox", ["@oscharko-dev/keiko-contracts"]],
  // Browser-tier editor package (ADR-0042). Like keiko-ui it lives in the browser tier; its only
  // permitted workspace dependency is keiko-contracts (type-only where possible). The browser-tier
  // value-import boundary is enforced separately by adr-0042-editor-not-node-domain-values in
  // .dependency-cruiser.cjs.
  ["@oscharko-dev/keiko-editor", ["@oscharko-dev/keiko-contracts"]],
  // The Next app is not part of the package-build solution, but its workspace edges are still
  // governed: #1196 allows the Workspace card host to value-import the browser-tier editor package.
  ["@oscharko-dev/keiko-ui", ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-editor"]],
  [
    "@oscharko-dev/keiko-evaluations",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-model-gateway",
      "@oscharko-dev/keiko-workspace",
      "@oscharko-dev/keiko-tools",
      "@oscharko-dev/keiko-harness",
      "@oscharko-dev/keiko-local-knowledge",
      "@oscharko-dev/keiko-workflows",
      "@oscharko-dev/keiko-verification",
      "@oscharko-dev/keiko-evidence",
    ],
  ],
  [
    "@oscharko-dev/keiko-evidence",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-workspace",
    ],
  ],
  [
    "@oscharko-dev/keiko-harness",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-model-gateway",
      "@oscharko-dev/keiko-workspace",
      "@oscharko-dev/keiko-tools",
      "@oscharko-dev/keiko-evidence",
    ],
  ],
  [
    "@oscharko-dev/keiko-local-knowledge",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-model-gateway",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-workspace",
    ],
  ],
  [
    "@oscharko-dev/keiko-memory-capture",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  [
    "@oscharko-dev/keiko-memory-consolidation",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  [
    "@oscharko-dev/keiko-memory-governance",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  [
    "@oscharko-dev/keiko-memory-retrieval",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  [
    "@oscharko-dev/keiko-memory-vault",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  [
    "@oscharko-dev/keiko-model-gateway",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  [
    "@oscharko-dev/keiko-quality-intelligence",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
  [
    "@oscharko-dev/keiko-sdk",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-model-gateway",
      "@oscharko-dev/keiko-workspace",
      "@oscharko-dev/keiko-tools",
      "@oscharko-dev/keiko-harness",
      "@oscharko-dev/keiko-workflows",
      "@oscharko-dev/keiko-evaluations",
      "@oscharko-dev/keiko-verification",
      "@oscharko-dev/keiko-evidence",
    ],
  ],
  ["@oscharko-dev/keiko-security", ["@oscharko-dev/keiko-contracts"]],
  // Shared governed git core (runner + hardened env + repository-membership resolution +
  // failure classification). A leaf next to keiko-security: only contracts may be imported so
  // the spawn path can never pull in server, tool, or provider code.
  ["@oscharko-dev/keiko-git", ["@oscharko-dev/keiko-contracts"]],
  [
    "@oscharko-dev/keiko-server",
    [
      "@oscharko-dev/keiko-connectors",
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-git",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-model-gateway",
      "@oscharko-dev/keiko-workspace",
      "@oscharko-dev/keiko-sandbox",
      "@oscharko-dev/keiko-tools",
      "@oscharko-dev/keiko-harness",
      "@oscharko-dev/keiko-workflows",
      "@oscharko-dev/keiko-verification",
      "@oscharko-dev/keiko-evidence",
      "@oscharko-dev/keiko-sdk",
      "@oscharko-dev/keiko-local-knowledge",
      "@oscharko-dev/keiko-memory-vault",
      "@oscharko-dev/keiko-memory-governance",
      "@oscharko-dev/keiko-memory-retrieval",
      "@oscharko-dev/keiko-memory-capture",
      "@oscharko-dev/keiko-memory-consolidation",
      "@oscharko-dev/keiko-quality-intelligence",
    ],
  ],
  [
    "@oscharko-dev/keiko-tools",
    [
      "@oscharko-dev/keiko-contracts",
      // KEIKO-0215: git-publish-gateway delegates its remote-unavailable/auth/permission phrase
      // set to keiko-git's classifyGitRemoteFailure so one shared table governs clone/fetch/pull
      // AND push (the local 5-phrase copy had drifted behind keiko-git's 10-phrase table).
      // The dependency-cruiser boundary already permits this edge (adr-0019-direction-3c).
      "@oscharko-dev/keiko-git",
      "@oscharko-dev/keiko-sandbox",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-workspace",
    ],
  ],
  [
    "@oscharko-dev/keiko-verification",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-workspace",
      "@oscharko-dev/keiko-tools",
    ],
  ],
  [
    "@oscharko-dev/keiko-workflows",
    [
      "@oscharko-dev/keiko-contracts",
      "@oscharko-dev/keiko-security",
      "@oscharko-dev/keiko-model-gateway",
      "@oscharko-dev/keiko-workspace",
      "@oscharko-dev/keiko-tools",
      "@oscharko-dev/keiko-harness",
      "@oscharko-dev/keiko-verification",
      "@oscharko-dev/keiko-evidence",
      "@oscharko-dev/keiko-quality-intelligence",
    ],
  ],
  [
    "@oscharko-dev/keiko-workspace",
    ["@oscharko-dev/keiko-contracts", "@oscharko-dev/keiko-security"],
  ],
]);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function workspaceDeps(manifest) {
  return Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith("@oscharko-dev/keiko-"))
    .sort((a, b) => a.localeCompare(b));
}

function workspaceConfigIndex(packages) {
  return new Map(packages.map((pkg) => [resolve(pkg.dir, "tsconfig.json"), pkg]));
}

function referenceConfigPath(owner, entry) {
  const referencePath = entry?.path;
  if (typeof referencePath !== "string" || referencePath.trim() === "") {
    return { failure: `${owner.name}: tsconfig reference must specify a non-empty string path` };
  }
  const resolvedReference = resolve(dirname(owner.configPath), referencePath);
  const configPath =
    basename(resolvedReference) === "tsconfig.json"
      ? resolvedReference
      : join(resolvedReference, "tsconfig.json");
  return { configPath, referencePath };
}

function workspaceReference(owner, entry, knownWorkspaceConfigs) {
  const reference = referenceConfigPath(owner, entry);
  if ("failure" in reference) {
    return reference;
  }
  const workspacePackage = knownWorkspaceConfigs.get(reference.configPath);
  if (!workspacePackage || resolve(workspacePackage.dir) !== dirname(reference.configPath)) {
    return {
      failure: `${owner.name}: tsconfig reference ${JSON.stringify(reference.referencePath)} must resolve to a known workspace package tsconfig.json`,
    };
  }
  return { name: workspacePackage.name };
}

function workspaceRefs(tsconfig, owner, knownWorkspaceConfigs) {
  const failures = [];
  const refs = [];
  if (tsconfig.references !== undefined && !Array.isArray(tsconfig.references)) {
    return { failures: [`${owner.name}: tsconfig references must be an array`], refs };
  }

  for (const entry of tsconfig.references ?? []) {
    const reference = workspaceReference(owner, entry, knownWorkspaceConfigs);
    if ("failure" in reference) {
      failures.push(reference.failure);
      continue;
    }
    refs.push(reference.name);
  }

  refs.sort((left, right) => left.localeCompare(right));
  return { failures, refs };
}

function manifestTargets(manifest) {
  const targets = [];
  if (typeof manifest.main === "string") targets.push(manifest.main);
  if (typeof manifest.types === "string") targets.push(manifest.types);
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === "string") {
      targets.push(value);
      continue;
    }
    for (const nestedValue of Object.values(value ?? {})) {
      if (typeof nestedValue === "string") {
        targets.push(nestedValue);
      }
    }
  }
  return targets;
}

function parseArgs(argv) {
  const rootArg = argv.find((arg) => arg.startsWith("--root="));
  return {
    root: resolve(rootArg ? rootArg.slice("--root=".length) : process.cwd()),
  };
}

function rootScriptFailures(rootManifest) {
  const failures = [];
  if (rootManifest.scripts?.["build:packages"] !== BUILD_PACKAGES_SCRIPT) {
    failures.push(
      `root package.json build:packages must be "${BUILD_PACKAGES_SCRIPT}" (found "${rootManifest.scripts?.["build:packages"] ?? ""}")`,
    );
  }
  if (rootManifest.scripts?.typecheck !== TYPECHECK_SCRIPT) {
    failures.push(
      `root package.json typecheck must be "${TYPECHECK_SCRIPT}" (found "${rootManifest.scripts?.typecheck ?? ""}")`,
    );
  }
  return failures;
}

function solutionRefFailures(packagesSolution, graphPackages, knownWorkspaceConfigs, configPath) {
  const expectedSolutionRefs = graphPackages.map((pkg) => pkg.name);
  const { failures, refs } = workspaceRefs(
    packagesSolution,
    { configPath, name: "tsconfig.packages.json" },
    knownWorkspaceConfigs,
  );
  if (JSON.stringify(refs) !== JSON.stringify(expectedSolutionRefs)) {
    failures.push(
      `tsconfig.packages.json references ${refs.join(", ")} but expected ${expectedSolutionRefs.join(", ")}`,
    );
  }
  return failures;
}

function packageGraphFailures(pkg, tsconfig, knownWorkspaceConfigs) {
  const failures = [];
  const deps = workspaceDeps(pkg.manifest);
  const { failures: refFailures, refs } = workspaceRefs(
    tsconfig,
    { configPath: join(pkg.dir, "tsconfig.json"), name: pkg.name },
    knownWorkspaceConfigs,
  );

  failures.push(...refFailures);
  if (JSON.stringify(refs) !== JSON.stringify(deps)) {
    failures.push(
      `${pkg.name}: tsconfig references ${refs.join(", ")} do not match dependencies ${deps.join(", ")}`,
    );
  }
  failures.push(...workspaceDependencyAllowlistFailures(pkg));
  if (tsconfig.compilerOptions?.rootDir !== "src") {
    failures.push(`${pkg.name}: compilerOptions.rootDir must be "src"`);
  }
  if ((tsconfig.include ?? []).some((entry) => String(entry).includes("../.."))) {
    failures.push(`${pkg.name}: tsconfig include still contains a root-relative path`);
  }
  if (manifestTargets(pkg.manifest).some((target) => target.includes("dist/packages/"))) {
    failures.push(`${pkg.name}: manifest still points at dist/packages/... output`);
  }
  return failures;
}

function workspaceDependencyAllowlistFailures(pkg) {
  const deps = workspaceDeps(pkg.manifest);
  const allowedDeps = ALLOWED_WORKSPACE_DEPENDENCIES.get(pkg.name);
  if (!allowedDeps) {
    return [`${pkg.name}: missing ADR-0019 workspace dependency allowlist entry`];
  }

  const allowed = new Set(allowedDeps);
  const disallowedDeps = deps.filter((dep) => !allowed.has(dep));
  if (disallowedDeps.length === 0) {
    return [];
  }

  return [
    `${pkg.name}: workspace dependencies ${disallowedDeps.join(", ")} are not allowed by the ADR-0019 package graph allowlist`,
  ];
}

export async function checkWorkspacePackageGraph(root) {
  const failures = [];
  const rootManifest = await readJson(join(root, "package.json"));
  const packagesSolution = await readJson(join(root, "tsconfig.packages.json"));
  const packages = await collectWorkspacePackages(root);
  const graphPackages = packages
    .filter((pkg) => pkg.name !== UI_PACKAGE)
    .sort((a, b) => a.name.localeCompare(b.name));
  const knownWorkspaceConfigs = workspaceConfigIndex(packages);

  failures.push(
    ...rootScriptFailures(rootManifest),
    ...solutionRefFailures(
      packagesSolution,
      graphPackages,
      knownWorkspaceConfigs,
      join(root, "tsconfig.packages.json"),
    ),
  );
  const uiPackage = packages.find((pkg) => pkg.name === UI_PACKAGE);
  if (uiPackage) {
    failures.push(...workspaceDependencyAllowlistFailures(uiPackage));
  }
  for (const pkg of graphPackages) {
    const tsconfigPath = join(pkg.dir, "tsconfig.json");
    const tsconfig = await readJson(tsconfigPath);
    failures.push(...packageGraphFailures(pkg, tsconfig, knownWorkspaceConfigs));
  }

  return failures;
}

export async function main(argv = process.argv.slice(2)) {
  const { root } = parseArgs(argv);
  const failures = await checkWorkspacePackageGraph(root);
  if (failures.length > 0) {
    console.error("package-graph: FAIL");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  console.log(
    "package-graph: PASS — workspace references, package emits, and root package build graph are aligned.",
  );
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).endsWith("check-package-graph.mjs");
if (invokedDirectly) {
  await main();
}
