import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, posix, relative, resolve, sep } from "node:path";

import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const FIXTURE_ROOT = "tests/architecture/fixtures";

const PROVIDER_SDK_PATTERN = /^(openai($|\/)|@anthropic-ai\/|[^/]+-ai-sdk($|\/))/;
const MODEL_GATEWAY_PROVIDER_RUNTIME_INTERNAL_PATTERN =
  /^@oscharko-dev\/keiko-model-gateway\/internal\/(openai-adapter|normalize)($|\/)/;
const MODEL_GATEWAY_PROVIDER_RUNTIME_DEEP_PATH_PATTERN =
  /^(node_modules\/@oscharko-dev\/keiko-model-gateway\/|packages\/keiko-model-gateway\/)(src|dist)\/(openai-adapter|normalize)(\.[cm]?[jt]s)?($|\/)/;
const OWNED_ROOT_INTERNAL_PREFIX = "@oscharko-dev/keiko-workspace/internal/";
const OWNED_ROOT_CONTAINMENT_SPECIFIER = `${OWNED_ROOT_INTERNAL_PREFIX}owned-root`;
const OWNED_ROOT_MINT_SPECIFIER = `${OWNED_ROOT_INTERNAL_PREFIX}owned-root-mint`;
const OWNED_ROOT_PRESERVE_SPECIFIER = `${OWNED_ROOT_INTERNAL_PREFIX}owned-root-preserve`;
const OWNED_ROOT_LOOKUP_SPECIFIER = `${OWNED_ROOT_INTERNAL_PREFIX}owned-root-lookup`;
const OWNED_ROOT_IMPLEMENTATION_SPECIFIER = `${OWNED_ROOT_INTERNAL_PREFIX}owned-root-authority`;
const ownedRootDeepPathPattern = (moduleName) =>
  new RegExp(
    String.raw`^(node_modules/@oscharko-dev/keiko-workspace/|packages/keiko-workspace/)(src|dist)/${moduleName}(\.[cm]?[jt]s)?($|/)`,
    "u",
  );
const OWNED_ROOT_CONTAINMENT_DEEP_PATH_PATTERN = ownedRootDeepPathPattern("ownedRoot");
const OWNED_ROOT_MINT_DEEP_PATH_PATTERN = ownedRootDeepPathPattern("ownedRootMint");
const OWNED_ROOT_PRESERVE_DEEP_PATH_PATTERN = ownedRootDeepPathPattern("ownedRootPreserve");
const OWNED_ROOT_LOOKUP_DEEP_PATH_PATTERN = ownedRootDeepPathPattern("ownedRootLookup");
const OWNED_ROOT_IMPLEMENTATION_DEEP_PATH_PATTERN = ownedRootDeepPathPattern("ownedRootAuthority");
const OWNED_ROOT_CONTAINMENT_FILES = new Set([
  "packages/keiko-server/src/task-workspace/managed-root.ts",
  "packages/keiko-server/src/task-workspace/reconciliation.ts",
]);
const OWNED_ROOT_MINT_FILES = new Set([
  "packages/keiko-server/src/task-workspace/workspace-root-access.ts",
]);
const OWNED_ROOT_PRESERVE_FILES = new Set([
  "packages/keiko-server/src/grounded-orchestrator.ts",
  "packages/keiko-workspace/src/realpath.ts",
  "packages/keiko-workspace/src/structuralExecution.ts",
]);
const OWNED_ROOT_LOOKUP_FILES = new Set(["packages/keiko-workspace/src/realpath.ts"]);
const OWNED_ROOT_IMPLEMENTATION_FILES = new Set([
  "packages/keiko-workspace/src/ownedRootLookup.ts",
  "packages/keiko-workspace/src/ownedRootMint.ts",
  "packages/keiko-workspace/src/ownedRootPreserve.ts",
]);
const NETWORK_CORE_MODULES = [
  "child_process",
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "dns",
  "worker_threads",
];
const LOCAL_KNOWLEDGE_FORBIDDEN_EXACT = new Set([
  "fetch",
  ...NETWORK_CORE_MODULES,
  ...NETWORK_CORE_MODULES.map((name) => `node:${name}`),
]);
const LOCAL_KNOWLEDGE_FORBIDDEN_PREFIXES = [
  "undici",
  "node-fetch",
  "axios",
  "got",
  "tesseract.js",
  "@google-cloud/vision",
  "@aws-sdk/client-textract",
  "libreoffice-convert",
  "pdf-poppler",
  "sharp",
];
// ADR-0019 v1.1: two reviewed files form one in-memory ANN isolation boundary. The launcher may
// create only the checked-in worker entry, and that entry receives only SharedArrayBuffers plus the
// digest-pinned native path. This is not a general worker capability exception: every other Local
// Knowledge file, and every network/process specifier even in these files, remains denied.
const LOCAL_KNOWLEDGE_ANN_WORKER_FILES = new Set([
  "packages/keiko-local-knowledge/src/retrieval/usearch-ann-index.ts",
  "packages/keiko-local-knowledge/src/retrieval/usearch-index-worker.ts",
]);
const CONTROLLED_TOOLS_FS_ADAPTER_PATTERN =
  /^packages\/keiko-tools\/src\/(_support|exec|writer)\.[cm]?tsx?$/;
// ADR-0128 D1 (Epic #2238): keiko-connectors has no concrete network OR filesystem capability —
// egress arrives through the injected AtlassianHttpPort that keiko-server implements with
// gatewayFetch, and persistence (vault + metadata) through injected ports keiko-server builds.
// Forbidden here: bare fetch, every Node network module, node:fs (incl. fs/promises), the usual
// HTTP client packages, and @oscharko-dev/keiko-model-gateway in EVERY import form (a type-only
// gateway import would still couple the leaf to the gateway surface ADR-0128 D1 rules out).
// Mirrors adr-0019-trust-9-local-knowledge-no-egress.
// Forbidden only as an EXACT specifier (bare or `node:`-prefixed): `fetch` and every Node network
// core module. A deeper subpath of these is not a core-module import.
const CONNECTORS_FORBIDDEN_EXACT = new Set([
  "fetch",
  ...NETWORK_CORE_MODULES,
  ...NETWORK_CORE_MODULES.map((name) => `node:${name}`),
]);
// Forbidden as the specifier itself OR any subpath beneath it (`prefix` or `prefix/...`): node:fs
// (incl. fs/promises), the bare fs, the usual HTTP client packages, and the model gateway.
const CONNECTORS_FORBIDDEN_PREFIXES = [
  "node:fs",
  "fs",
  "undici",
  "node-fetch",
  "axios",
  "got",
  "@oscharko-dev/keiko-model-gateway",
];

function matchesSpecifierPrefix(specifier, prefix) {
  return specifier === prefix || specifier.startsWith(`${prefix}/`);
}

function isLocalKnowledgeForbiddenCapability(specifier) {
  return (
    LOCAL_KNOWLEDGE_FORBIDDEN_EXACT.has(specifier) ||
    LOCAL_KNOWLEDGE_FORBIDDEN_PREFIXES.some((prefix) => matchesSpecifierPrefix(specifier, prefix))
  );
}

function isConnectorsForbiddenCapability(specifier) {
  if (CONNECTORS_FORBIDDEN_EXACT.has(specifier)) return true;
  return CONNECTORS_FORBIDDEN_PREFIXES.some((prefix) => matchesSpecifierPrefix(specifier, prefix));
}

// GEN-ARCH-CODING-RUNTIME-001 — the coding runtime is the server's largest single trust surface
// (170+ files) and hosts the sole public-internet egress lane, yet carried no import-specifier
// policy of its own: a new file could reach for a raw socket, an HTTP client, or a child process
// and no gate would notice. dependency-cruiser cannot answer this — bare `fetch()` and `node:*`
// core specifiers are not resolvable source-graph edges in this repository's configuration (see
// the comment on `adr-0128-connectors-no-direct-egress`) — so this AST rule is the enforcement,
// mirroring `adr-0019-trust-9-local-knowledge-no-egress`.
//
// Two capability classes, each with its own reviewed allow-list. Type-only imports are NOT
// violations: `import type { IncomingMessage }` is erased at build and carries no capability, and
// the route files legitimately type their handlers against it (see `matchesImportKind`).
//
// `researchEgressPort.ts` is deliberately NOT allow-listed for either class. It is documented as
// THE public-internet lane, but it holds no RAW network capability: every outbound hop goes
// through the governed `gatewayFetch` from keiko-model-gateway, under a registered research grant,
// with DNS pinning, host allow-listing and loopback denial applied there. This rule now pins that
// delegation — if that port ever reaches for a raw socket or bare `fetch`, the gate fires.
const CODING_RUNTIME_ROOT = "packages/keiko-server/src/coding-runtime/";
// Raw outbound/socket capability: bare `fetch` plus the network core modules. `child_process` and
// `worker_threads` are handled by the process class below, so they are excluded here.
const CODING_RUNTIME_NETWORK_FORBIDDEN_EXACT = new Set([
  "fetch",
  ...NETWORK_CORE_MODULES.filter(
    (name) => name !== "child_process" && name !== "worker_threads",
  ).flatMap((name) => [name, `node:${name}`]),
]);
const CODING_RUNTIME_PROCESS_FORBIDDEN_EXACT = new Set(
  ["child_process", "worker_threads"].flatMap((name) => [name, `node:${name}`]),
);
// LOOPBACK-only network capability. Neither file performs public-internet egress, and neither is
// granted `researchEgressPort.ts`'s lane: both are confined to `127.0.0.1` sidecar plumbing.
//   * `opencodeRuntimeComposition.ts` — `createServer` builds the loopback tool-bridge the sidecar
//     calls BACK into (inbound, governed tool facade), and its `unauthenticatedHealth` helper calls
//     an INJECTED `fetch` parameter against the sidecar's own `/global/health` endpoint. The
//     syntactic gate cannot distinguish an injected `fetch` binding from the global one.
//   * `opencodeFunctionalHarness/_support.ts` — a test-only functional harness, referenced solely
//     by `productionOpenCodeBackend*.test.ts`. It stands up a fake loopback gateway and drives it.
const CODING_RUNTIME_NETWORK_CAPABILITY_FILES = new Set([
  `${CODING_RUNTIME_ROOT}opencodeRuntimeComposition.ts`,
  `${CODING_RUNTIME_ROOT}opencodeFunctionalHarness/_support.ts`,
]);
// OS-process control. Each file was read and is the process layer itself — it cannot route through
// a workspace/tools port, because those ports are built ON these:
//   * `devLaneRuntimeProcessBackend.ts`   — spawns the managed runtime as a POSIX process-group
//                                           leader for dev-lane checkouts (ADR-0140).
//   * `nativeRuntimeProcessBackend.ts`    — spawns the supervised native runtime helper process.
//   * `productionPortableCodingRuntime.ts`— `spawnSync` during portable-installation verification.
//   * `secureWorkspaceTextReadNodeProcess.ts` — spawns the secure text-read child (empty env,
//                                           `shell: false`, piped stdio) behind the server-owned
//                                           process seam.
//   * `secureWorkspaceTextReadPlatformNode.ts` — `execFile` for platform code-identity inspection.
//   * `windowsPortableAuthenticode.ts`    — `execFile`/`spawnSync` for Windows Authenticode checks.
//   * `opencodeFunctionalHarness/_support.ts` — the test-only harness above; spawns the real
//                                           sidecar under test.
const CODING_RUNTIME_PROCESS_CAPABILITY_FILES = new Set([
  `${CODING_RUNTIME_ROOT}devLaneRuntimeProcessBackend.ts`,
  `${CODING_RUNTIME_ROOT}nativeRuntimeProcessBackend.ts`,
  `${CODING_RUNTIME_ROOT}productionPortableCodingRuntime.ts`,
  `${CODING_RUNTIME_ROOT}secureWorkspaceTextReadNodeProcess.ts`,
  `${CODING_RUNTIME_ROOT}secureWorkspaceTextReadPlatformNode.ts`,
  `${CODING_RUNTIME_ROOT}windowsPortableAuthenticode.ts`,
  `${CODING_RUNTIME_ROOT}opencodeFunctionalHarness/_support.ts`,
]);

// Matched as a prefix, not an exact name: several of these core modules ship a promises subpath
// (`node:dns/promises` is real and grants full resolver capability), so an exact-match set would let
// the capability back in through the subpath — the review finding on the first version of this rule.
// Mirrors CONNECTORS_FORBIDDEN_PREFIXES. `fetch` carries no subpath but matches the same way.
function isCodingRuntimeForbiddenCapability(specifier, path) {
  const forbiddenAs = (prefixes) =>
    [...prefixes].some((prefix) => matchesSpecifierPrefix(specifier, prefix));
  if (forbiddenAs(CODING_RUNTIME_NETWORK_FORBIDDEN_EXACT)) {
    return !CODING_RUNTIME_NETWORK_CAPABILITY_FILES.has(path);
  }
  if (forbiddenAs(CODING_RUNTIME_PROCESS_FORBIDDEN_EXACT)) {
    return !CODING_RUNTIME_PROCESS_CAPABILITY_FILES.has(path);
  }
  return false;
}

// GEN-PERF-CLI-001 — the CLI barrel is evaluated on every `keiko` invocation (the
// root bin imports it), so keiko-cli modules must not STATICALLY value-import the
// heavy workspace package graphs or the keiko-sdk fat barrel at module scope. The
// eager graph cost a measured ~410ms of ESM loading per command (`keiko --version`
// ~440-490ms vs ~80ms once lazy). `import type` (erased at build) and dynamic
// `import()` (the lazy-modules.ts loaders) stay allowed; the light leaves
// (contracts, security, tools, memory-vault, keiko-server/credential-vault) stay
// allowed. dependency-cruiser cannot see this distinction on resolved workspace
// edges in this repository configuration, so this AST rule is the enforcement.
const CLI_HEAVY_PACKAGE_PATTERN =
  /^@oscharko-dev\/keiko-(server|harness|workflows|evaluations|verification|evidence|model-gateway|workspace|quality-intelligence|sdk)($|\/)/;
const CLI_HEAVY_PACKAGE_ALLOWED_SUBPATHS = /^@oscharko-dev\/keiko-server\/credential-vault($|\/)/;

const IMPORT_POLICY_RULES = [
  {
    name: "adr-0175-tool-catalog-pure-imports",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/tool-catalog-pure/`)
        : path.startsWith("packages/keiko-tool-catalog/src/"),
    matchesSpecifier: (specifier, path) => {
      if (/^@oscharko-dev\/keiko-(contracts|security)($|\/)/u.test(specifier)) return false;
      return (
        !specifier.startsWith(".") ||
        !candidateImportPaths(specifier, path).some((candidate) =>
          candidate.startsWith("packages/keiko-tool-catalog/src/"),
        )
      );
    },
    matchesImportKind: (kind) => kind !== "raw-coordinate-lane",
  },
  {
    // ADR-0165 D2: selecting a raw lane through the public search barrel is as
    // sensitive as importing editor-read. Check the property even when its value
    // is indirect; a variable, shorthand or computed literal cannot evade this.
    name: "adr-0165-raw-coordinate-owner",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/raw-coordinate-owner/`)
        : !path.startsWith("packages/keiko-workspace/src/") &&
          path !== "packages/keiko-server/src/editor/workspaceSearchRoutes.ts",
    matchesSpecifier: (specifier) => specifier === "contentLane",
    matchesImportKind: (kind) => kind === "raw-coordinate-lane",
  },
  {
    name: "adr-0005-owned-root-containment-allowed-callers",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/owned-root-containment-allowed-callers/`)
        : /^(packages\/keiko-|src\/)/.test(path) && !OWNED_ROOT_CONTAINMENT_FILES.has(path),
    matchesSpecifier: (specifier, path) =>
      specifier === OWNED_ROOT_CONTAINMENT_SPECIFIER ||
      candidateImportPaths(specifier, path).some((candidate) =>
        OWNED_ROOT_CONTAINMENT_DEEP_PATH_PATTERN.test(candidate),
      ),
  },
  {
    name: "adr-0005-owned-root-mint-allowed-callers",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/owned-root-authority-allowed-callers/`)
        : /^(packages\/keiko-|src\/)/.test(path) && !OWNED_ROOT_MINT_FILES.has(path),
    matchesSpecifier: (specifier, path) =>
      specifier === OWNED_ROOT_MINT_SPECIFIER ||
      candidateImportPaths(specifier, path).some((candidate) =>
        OWNED_ROOT_MINT_DEEP_PATH_PATTERN.test(candidate),
      ),
  },
  {
    name: "adr-0005-owned-root-preserve-allowed-callers",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/owned-root-preserve-allowed-callers/`)
        : /^(packages\/keiko-|src\/)/.test(path) && !OWNED_ROOT_PRESERVE_FILES.has(path),
    matchesSpecifier: (specifier, path) =>
      specifier === OWNED_ROOT_PRESERVE_SPECIFIER ||
      candidateImportPaths(specifier, path).some((candidate) =>
        OWNED_ROOT_PRESERVE_DEEP_PATH_PATTERN.test(candidate),
      ),
  },
  {
    name: "adr-0005-owned-root-lookup-allowed-callers",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/owned-root-lookup-allowed-callers/`)
        : /^(packages\/keiko-|src\/)/.test(path) && !OWNED_ROOT_LOOKUP_FILES.has(path),
    matchesSpecifier: (specifier, path) =>
      specifier === OWNED_ROOT_LOOKUP_SPECIFIER ||
      candidateImportPaths(specifier, path).some((candidate) =>
        OWNED_ROOT_LOOKUP_DEEP_PATH_PATTERN.test(candidate),
      ),
  },
  {
    name: "adr-0005-owned-root-authority-implementation-private",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/owned-root-authority-implementation-private/`)
        : /^(packages\/keiko-|src\/)/.test(path) && !OWNED_ROOT_IMPLEMENTATION_FILES.has(path),
    matchesSpecifier: (specifier, path) =>
      specifier === OWNED_ROOT_IMPLEMENTATION_SPECIFIER ||
      candidateImportPaths(specifier, path).some((candidate) =>
        OWNED_ROOT_IMPLEMENTATION_DEEP_PATH_PATTERN.test(candidate),
      ),
  },
  {
    name: "gen-perf-cli-001-cli-heavy-graphs-load-lazily",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/cli-lazy-heavy-imports/`)
        : path.startsWith("packages/keiko-cli/src/") &&
          path !== "packages/keiko-cli/src/lazy-modules.ts",
    matchesSpecifier: (specifier) =>
      CLI_HEAVY_PACKAGE_PATTERN.test(specifier) &&
      !CLI_HEAVY_PACKAGE_ALLOWED_SUBPATHS.test(specifier),
    // Only a plain static value import/re-export is a violation; `import type`
    // and the memoized dynamic loaders are the sanctioned access paths.
    matchesImportKind: (kind) => kind === "static",
  },
  {
    name: "adr-0019-trust-1-provider-sdk-isolation",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/provider-sdk-isolation/`)
        : /^(packages\/keiko-|src\/)/.test(path) &&
          !/^(packages\/keiko-model-gateway\/src\/|src\/gateway\/)/.test(path),
    matchesSpecifier: (specifier) => PROVIDER_SDK_PATTERN.test(specifier),
  },
  {
    name: "adr-0019-trust-4-no-direct-fs-outside-workspace",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/direct-fs-outside-workspace/`)
        : /^(packages\/keiko-(tools|harness|workflows)\/src\/|src\/(tools|harness|workflows)\/)/.test(
            path,
          ) && !CONTROLLED_TOOLS_FS_ADAPTER_PATTERN.test(path),
    matchesSpecifier: (specifier) => specifier === "node:fs" || specifier === "fs",
  },
  {
    name: "adr-0019-trust-5-patch-routes-through-tools",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/patch-routes-through-tools/`)
        : /^(packages\/keiko-(harness|workflows)\/src\/|src\/(harness|workflows)\/)/.test(path),
    matchesSpecifier: (specifier) =>
      specifier === "node:fs/promises" || specifier === "fs/promises",
  },
  {
    name: "adr-0019-trust-9-local-knowledge-no-egress",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/local-knowledge-no-egress/`)
        : path.startsWith("packages/keiko-local-knowledge/src/"),
    matchesSpecifier: (specifier, path) =>
      isLocalKnowledgeForbiddenCapability(specifier) &&
      !(
        (specifier === "node:worker_threads" || specifier === "worker_threads") &&
        LOCAL_KNOWLEDGE_ANN_WORKER_FILES.has(path)
      ),
  },
  {
    name: "adr-0128-connectors-no-direct-egress",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/connectors-no-egress/`)
        : path.startsWith("packages/keiko-connectors/src/"),
    matchesSpecifier: (specifier) => isConnectorsForbiddenCapability(specifier),
  },
  {
    name: "gen-arch-coding-runtime-restricted-egress",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/coding-runtime-no-egress/`)
        : path.startsWith(CODING_RUNTIME_ROOT),
    matchesSpecifier: (specifier, path) => isCodingRuntimeForbiddenCapability(specifier, path),
    // A fully type-only import is erased at build and grants no capability; the coding-runtime
    // route handlers are typed against `node:http`'s `IncomingMessage`/`ServerResponse` and must
    // stay able to be. Every value-carrying form (static, dynamic, require, bare `fetch` call) is
    // in scope.
    matchesImportKind: (kind) => kind !== "static-type" && kind !== "type",
  },
  {
    name: "adr-0112-provider-runtime-no-internal-bypass",
    matchesFile: (path, mode) =>
      mode === "fixtures"
        ? path.startsWith(`${FIXTURE_ROOT}/provider-runtime-internal-bypass/`)
        : /^(packages\/keiko-|src\/)/.test(path) &&
          !path.startsWith("packages/keiko-model-gateway/src/"),
    matchesSpecifier: (specifier, path) =>
      matchesModelGatewayProviderRuntimeInternalSpecifier(specifier, path),
  },
];

function normalizePath(path) {
  return path.split(sep).join("/");
}

function extensionOf(path) {
  const name = basename(path);
  const firstDot = name.indexOf(".");
  return firstDot === -1 ? "" : name.slice(firstDot);
}

function isSourceFile(path) {
  return SOURCE_EXTENSIONS.has(extensionOf(path));
}

function isProductionTestFile(path) {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    path.includes("/__tests__/") ||
    path.includes("/__test-support__/") ||
    path.includes("/test-support/")
  );
}

async function pathExists(path) {
  return Boolean(await stat(path).catch(() => null));
}

async function collectFiles(dir) {
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)));
      continue;
    }
    if (entry.isFile() && isSourceFile(path)) {
      files.push(path);
    }
  }
  return files;
}

async function collectProductionFiles(root) {
  const files = [];
  files.push(...(await collectFiles(join(root, "src"))));

  const packagesDir = join(root, "packages");
  if (await pathExists(packagesDir)) {
    for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("keiko-")) {
        files.push(...(await collectFiles(join(packagesDir, entry.name, "src"))));
      }
    }
  }

  return files
    .map((file) => ({ file, relativePath: normalizePath(relative(root, file)) }))
    .filter(({ relativePath }) => !isProductionTestFile(relativePath));
}

async function collectFixtureFiles(root) {
  return (await collectFiles(join(root, FIXTURE_ROOT))).map((file) => ({
    file,
    relativePath: normalizePath(relative(root, file)),
  }));
}

function isStringLiteralLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

// Import-kind taxonomy (consumed by a rule's optional matchesImportKind):
//   "static"      — a plain `import`/`export … from` VALUE binding (evaluated at load)
//   "static-type" — a fully type-only `import type`/`export type … from` (erased at build)
//   "type"        — an `import("…")` TYPE position (ImportTypeNode; erased at build)
//   "dynamic"     — a runtime dynamic `import("…")` expression (loads on demand)
//   "require"     — a CommonJS require("…") call (evaluated at call time)
//   "call"        — a non-import call the policies also inspect (e.g. bare fetch)
function moduleSpecifierEntry(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
    if (!isStringLiteralLike(node.moduleSpecifier)) return undefined;
    const typeOnly = ts.isImportDeclaration(node)
      ? node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
      : node.isTypeOnly;
    return {
      node: node.moduleSpecifier,
      specifier: node.moduleSpecifier.text,
      kind: typeOnly ? "static-type" : "static",
    };
  }
  return undefined;
}

function importTypeEntry(node) {
  if (!ts.isImportTypeNode(node)) return undefined;
  const literal = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : null;
  return literal && isStringLiteralLike(literal)
    ? { node: literal, specifier: literal.text, kind: "type" }
    : undefined;
}

function callExpressionEntry(node) {
  if (!ts.isCallExpression(node)) return undefined;
  if (ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
    return { node: node.expression, specifier: "fetch", kind: "call" };
  }
  const [firstArg] = node.arguments;
  if (!firstArg || !isStringLiteralLike(firstArg)) return undefined;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return { node: firstArg, specifier: firstArg.text, kind: "dynamic" };
  }
  if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
    return { node: firstArg, specifier: firstArg.text, kind: "require" };
  }
  return undefined;
}

function importSpecifierEntry(node) {
  if ((ts.isIdentifier(node) || isStringLiteralLike(node)) && node.text === "contentLane") {
    return { node, specifier: node.text, kind: "raw-coordinate-lane" };
  }
  return moduleSpecifierEntry(node) ?? importTypeEntry(node) ?? callExpressionEntry(node);
}

function normalizeImportPath(path) {
  return path.replaceAll("\\", "/");
}

function candidateImportPaths(specifier, relativePath) {
  const normalizedSpecifier = normalizeImportPath(specifier);
  const candidates = [normalizedSpecifier.replace(/^\.\//, "")];
  if (normalizedSpecifier.startsWith(".")) {
    const fromDir = posix.dirname(relativePath);
    candidates.push(posix.normalize(posix.join(fromDir, normalizedSpecifier)));
  }
  return candidates;
}

function matchesModelGatewayProviderRuntimeInternalSpecifier(specifier, relativePath) {
  if (MODEL_GATEWAY_PROVIDER_RUNTIME_INTERNAL_PATTERN.test(specifier)) return true;
  return candidateImportPaths(specifier, relativePath).some((path) =>
    MODEL_GATEWAY_PROVIDER_RUNTIME_DEEP_PATH_PATTERN.test(path),
  );
}

function collectImportSpecifiers(sourceFile) {
  const specifiers = [];

  function visit(node) {
    const entry = importSpecifierEntry(node);
    if (entry) specifiers.push(entry);
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function parseSourceFile(path, text) {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

function violationFor(rule, file, relativePath, sourceFile, specifierEntry) {
  const location = sourceFile.getLineAndCharacterOfPosition(
    specifierEntry.node.getStart(sourceFile),
  );
  return {
    rule: rule.name,
    file: relativePath,
    line: location.line + 1,
    column: location.character + 1,
    specifier: specifierEntry.specifier,
  };
}

async function collectPolicyFiles(root, mode) {
  return mode === "fixtures" ? collectFixtureFiles(root) : collectProductionFiles(root);
}

function matchingRules(relativePath, mode, specifierEntry) {
  return IMPORT_POLICY_RULES.filter(
    (rule) =>
      rule.matchesFile(relativePath, mode) &&
      rule.matchesSpecifier(specifierEntry.specifier, relativePath) &&
      // Rules without matchesImportKind keep their historical behavior: every
      // import form (static, type-only, dynamic, require, call) is in scope.
      (rule.matchesImportKind === undefined || rule.matchesImportKind(specifierEntry.kind)),
  );
}

async function violationsForFile(file, relativePath, mode) {
  const text = await readFile(file, "utf8");
  const sourceFile = parseSourceFile(file, text);
  const violations = [];
  for (const specifierEntry of collectImportSpecifiers(sourceFile)) {
    for (const rule of matchingRules(relativePath, mode, specifierEntry)) {
      violations.push(violationFor(rule, file, relativePath, sourceFile, specifierEntry));
    }
  }
  return violations;
}

export async function checkArchitectureImportPolicy(root, options = {}) {
  const mode = options.mode ?? "production";
  if (mode !== "production" && mode !== "fixtures") {
    throw new Error(`unsupported import-policy mode: ${mode}`);
  }

  const absoluteRoot = resolve(root);
  const files = await collectPolicyFiles(absoluteRoot, mode);
  const violations = [];

  for (const { file, relativePath } of files) {
    violations.push(...(await violationsForFile(file, relativePath, mode)));
  }

  return violations.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    return a.rule.localeCompare(b.rule);
  });
}

export function countImportPolicyViolationsByRule(violations) {
  const counts = new Map();
  for (const violation of violations) {
    counts.set(violation.rule, (counts.get(violation.rule) ?? 0) + 1);
  }
  return counts;
}

function parseArgs(argv) {
  const rootArg = argv.find((arg) => arg.startsWith("--root="));
  return {
    mode: argv.includes("--fixtures") ? "fixtures" : "production",
    root: resolve(rootArg ? rootArg.slice("--root=".length) : process.cwd()),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { mode, root } = parseArgs(argv);
  const violations = await checkArchitectureImportPolicy(root, { mode });
  if (violations.length > 0) {
    console.error("import-policy: FAIL");
    for (const violation of violations) {
      console.error(
        `  - ${violation.rule} at ${violation.file}:${String(violation.line)}:${String(violation.column)} imports ${JSON.stringify(violation.specifier)}`,
      );
    }
    process.exit(1);
  }

  console.log("import-policy: PASS - ADR-0019 import-specifier policies passed.");
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).endsWith("check-import-policy.mjs");
if (invokedDirectly) {
  await main();
}
