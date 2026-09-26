#!/usr/bin/env node
// Activity-log op catalog generator (epic #2902, w1-op-catalog).
//
// Keiko's activity log is a machine-reconstruction contract: an autonomous agent replays a
// customer defect from an exported `server.log`, and the `op` field is the vocabulary it greps
// and pattern-matches against. A hand-maintained list of that vocabulary would drift the moment a
// new instrumentation site landed without updating it — exactly the failure
// `route-template.test.ts` already guards against for route literals (see AGENTS.md §7, "a
// fixture never restates a formula the code under test owns"). This generator DERIVES the
// vocabulary from the instrumentation sites instead, so `docs/observability/op-catalog.generated.json`
// is checked-in, generated output pinned by a drift test, never a restated copy.
//
// THREE SHAPES AN OP LITERAL TAKES IN THIS CODEBASE:
//   1. An object-literal property: `{ category: "gateway", op: "gateway.retry.scheduled", ... }`.
//      Most call sites in packages/keiko-server and packages/keiko-local-knowledge use this shape
//      directly against a logger (`log.warn({ op: "...", ... })`).
//   2. A positional argument to a small helper that builds the event object internally, e.g.
//      `gatewayEvent(level, op, correlationId, extra)` in packages/keiko-model-gateway/src/gateway.ts.
//      Most of packages/keiko-model-gateway uses this shape. A helper not listed in
//      POSITIONAL_OP_HELPERS below is invisible to this generator — promote it there, never infer
//      it dynamically, so the table stays an auditable, checked-in fact rather than a guess.
//   3. A top-level `operation` field passed to an approved diagnostic API. These retain the
//      diagnostic owner's label rules and a `diagnostic-operation` source kind; arbitrary payload
//      fields are not operations. Future lifecycle vocabulary is a linked contract, never a
//      fabricated source site. The diagnostic label validator requires built server packages.
//
// WHAT THIS DELIBERATELY DOES NOT DO: parse a full TypeScript AST. A bracket-depth-aware scan
// (splitTopLevelArgs / readValueSpan below) is enough to find the `op` argument or property
// reliably in a codebase this consistently formatted (Prettier, one property per line). When an
// `op` value is neither a string literal nor a two-literal ternary — a template string, a member
// expression, a plain identifier — the generator does not guess: it records `op: "<dynamic>"` at
// that site, so the catalog stays honest about what it cannot enumerate rather than silently
// omitting the site or fabricating a value.
//
// THREE TIERS RESOLVE AN ENTRY'S `category`, IN ORDER:
//   1. Sibling property (findSiblingCategory): a `category: "literal"` a few lines above or below
//      the `op:` property, inside the SAME object literal — the common case.
//   2. Positional-helper category (POSITIONAL_OP_HELPERS): the helper's own table entry names a
//      fixed category, for a call site that never carries one itself (§ shape 2 above).
//   3. File-level category binding (fileCategoryBinding, #2902): some instrumentation sites bind
//      `category` upstream of every `op:` call in the file rather than repeating it at each site —
//      a `.child({ category: "…" })` construction whose returned logger every call site reuses
//      (`local-knowledge-handlers.ts`'s `indexingRouteLog`), or a small wrapper function that
//      hardcodes `category` in its own body before forwarding to the sink
//      (`embedding-batcher.ts`'s `logEmbedding`). Neither shape puts `category` anywhere near the
//      `op:` property, so tiers 1 and 2 cannot see it. When every OTHER `category: "literal"` in
//      the file (comments excluded) agrees on exactly one distinct value, that value is attributed
//      to every remaining "unknown" entry in the same file. When the file contains several
//      distinct values (e.g. `orchestrator.ts` binds both "indexing" and "embedding" depending on
//      the call path) or none at all, there is no single safe answer — every entry stays "unknown"
//      rather than guessed. This tier is deliberately whole-file and deliberately conservative:
//      it trades recall for the guarantee that an attributed category is never a guess.
//
// Exported as `generateOpCatalog()` so scripts/__tests__/op-catalog-drift.test.mjs can regenerate
// in memory and pin it against the checked-in file, and `OP_NAME_PATTERN` so both this generator
// and any future runtime-adjacent check share one definition of a well-formed op name.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import ts from "typescript";

import {
  ACTIVITY_LOG_ANALYZER_PROJECTIONS,
  ACTIVITY_LOG_CATEGORIES,
  ACTIVITY_LOG_COMPATIBILITY_STATES,
  ACTIVITY_LOG_COMPLETENESS_STATES,
  ACTIVITY_LOG_DATA_CLASSES,
  ACTIVITY_LOG_ERROR_KINDS,
  ACTIVITY_LOG_EXEMPTION_BOUNDARIES,
  ACTIVITY_LOG_FIELD_TYPES,
  ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS,
  ACTIVITY_LOG_IMPLEMENTATION_OBLIGATIONS,
  ACTIVITY_LOG_LIFECYCLE_PHASES,
  ACTIVITY_LOG_LOSS_STATES,
  ACTIVITY_LOG_OMITTED_WHEN_EMPTY_FIELD_NAMES,
  ACTIVITY_LOG_RESERVED_FIELD_NAMES,
  ACTIVITY_LOG_REGISTRY_EXEMPTIONS,
  ACTIVITY_LOG_RELEASE_IMPACTS,
  ACTIVITY_LOG_WRITER_CAPABILITY_STATES,
} from "../packages/keiko-contracts/dist/observability.js";
import { ACTIVITY_LOG_FAILURE_CLASS_CONTRACTS } from "../packages/keiko-contracts/dist/activity-log-failure-class-contracts.js";
import { serverDiagnosticFromError } from "../packages/keiko-server/dist/diagnostics-log.js";
import { generateFailureSurfaceInventory } from "./lib/activity-log-failure-surface-inventory.mjs";
import {
  ACTIVITY_LOG_FAILURE_SURFACES,
  FAILURE_SURFACE_INVENTORY_RELATIVE_PATH,
} from "./lib/activity-log-failure-surfaces.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import {
  TOOL_CATALOG_OPERATIONS_PATH,
  toolCatalogOperationsBytes,
} from "./lib/tool-catalog-operations.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const OUTPUT_RELATIVE_PATH = "docs/observability/op-catalog.generated.json";
const RUNTIME_REGISTRY_RELATIVE_PATH =
  "packages/keiko-contracts/src/activity-log-registry.generated.ts";

const REGISTRATION_KEYS = new Set([
  "contractKind",
  "schemaVersion",
  "op",
  "category",
  "owner",
  "emitter",
  "fields",
  "causal",
  "lifecycle",
  "analyzerProjection",
  "failureClasses",
  "proofIds",
  "releaseImpact",
]);
const REGISTRATION_CATEGORIES = new Set(ACTIVITY_LOG_CATEGORIES);
const REGISTRATION_CAUSAL = new Set(["none", "correlation", "parent-correlation"]);
const REGISTRATION_LIFECYCLE = new Set(ACTIVITY_LOG_LIFECYCLE_PHASES);
const REGISTRATION_PROJECTIONS = new Set(ACTIVITY_LOG_ANALYZER_PROJECTIONS);
const REGISTRATION_RELEASE_IMPACTS = new Set(ACTIVITY_LOG_RELEASE_IMPACTS);
const REGISTRATION_FIELD_TYPES = new Set(ACTIVITY_LOG_FIELD_TYPES);
const REGISTRATION_DATA_CLASSES = new Set(ACTIVITY_LOG_DATA_CLASSES);
const REGISTRATION_FIELD_KEYS = new Set([
  "type",
  "dataClass",
  "required",
  "maxLength",
  "maxItems",
  "values",
]);
const FAILURE_CLASS_CONTRACT_KEYS = new Set([
  "contractKind",
  "schemaVersion",
  "failureClass",
  "requiredProductSurfaces",
  "requiredLifecycleOperations",
  "requiredCausalOperations",
  "requiredLossOperations",
  "requiredProofOperations",
  "requiredReplayProofIds",
  "requiredResourceOperations",
  "requiredEvidenceClasses",
  "requiredFrameOperations",
  "requiredCauseOperations",
]);
const REGISTRATION_TOKEN = /^[A-Za-z][A-Za-z0-9._/-]{0,159}$/u;
const REGISTRATION_CLOSED_VALUE = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,159}$/u;
const REGISTRATION_FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const EXEMPTION_KEYS = new Set([
  "contractKind",
  "schemaVersion",
  "id",
  "operation",
  "failureClass",
  "boundary",
  "owner",
  "reason",
  "trackingIssue",
  "expiresOn",
]);
const EXEMPTION_BOUNDARIES = new Set(ACTIVITY_LOG_EXEMPTION_BOUNDARIES);
const EXEMPTION_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
// An exemption is a reviewed, temporary exception: its owner is the package that owns the
// registered operation, and its expiry lies inside one bounded review window, so a record can be
// neither unowned nor effectively permanent.
const ACTIVITY_LOG_EXEMPTION_SCHEMA = {
  schemaVersion: 1,
  scope: "exact-operation-and-failure-class",
  boundaries: ACTIVITY_LOG_EXEMPTION_BOUNDARIES,
  required: [...EXEMPTION_KEYS],
  maximumEntries: 64,
  owner: "registered-operation-owner",
  maximumValidityDays: 180,
};

// A well-formed op: lowercase dot-separated segments, each starting with a letter, hyphens
// allowed within a segment, at most 6 segments and 32 characters per segment. Verified against
// every literal this generator currently extracts (58 distinct `op:` object-literal literals plus
// every positional-helper literal) before being enforced — see the generator's own violations
// output rather than a hand-picked example set.
export const OP_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}(\.[a-z][a-z0-9-]{0,31}){0,5}$/;

const ACTIVITY_LOG_LEVELS = ["debug", "info", "warn", "error"];
const ACTIVITY_LOG_BUILD_CLASSES = ["node-esm"];
const ACTIVITY_LOG_RELEASE_CLASSES = ["stable", "prerelease"];
const ACTIVITY_LOG_PERSISTED_ENVELOPE_CONTRACT = {
  ts: { type: "string", required: true, format: "iso-8601" },
  schemaVersion: { type: "integer", required: true, values: [2] },
  registryVersion: { type: "integer", required: true, minimum: 1 },
  schemaDigest: { type: "string", required: true, format: "sha256-hex" },
  catalogDigest: { type: "string", required: true, format: "sha256-hex" },
  buildClass: { type: "string", required: true, values: ACTIVITY_LOG_BUILD_CLASSES },
  releaseClass: { type: "string", required: true, values: ACTIVITY_LOG_RELEASE_CLASSES },
  platformClass: {
    type: "string",
    required: true,
    pattern: "^(?:darwin|linux|win32|other)-(?:arm64|x64|other)$",
  },
  productVersion: {
    type: "string",
    required: true,
    pattern: String.raw`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`,
  },
  compatibilityState: {
    type: "string",
    required: true,
    values: ACTIVITY_LOG_COMPATIBILITY_STATES,
  },
  writerCapability: {
    type: "string",
    required: true,
    values: ACTIVITY_LOG_WRITER_CAPABILITY_STATES,
  },
  pid: { type: "integer", required: true, minimum: 1, maximum: 2_147_483_647 },
  instanceId: { type: "string", required: true, pattern: "^[a-f0-9]{8}$" },
  seq: { type: "integer", required: true, minimum: 1 },
  level: { type: "string", required: true, values: ACTIVITY_LOG_LEVELS },
  category: { type: "string", required: true, values: ACTIVITY_LOG_CATEGORIES },
  op: { type: "string", required: true, pattern: OP_NAME_PATTERN.source },
  correlationId: {
    type: "string",
    required: "by-causal-contract",
    pattern: "^[A-Za-z0-9._-]{8,128}$",
  },
  parentCorrelationId: {
    type: "string",
    required: "by-parent-causal-contract",
    pattern: "^[A-Za-z0-9._-]{8,128}$",
  },
  durationMs: { type: "number", required: false, minimum: 0 },
  status: { type: "integer", required: false },
  errorKind: { type: "string", required: false, values: ACTIVITY_LOG_ERROR_KINDS },
};

// Codepoint comparison, never `localeCompare`: the catalog's entry order (and, transitively, the
// order files are walked in) is checked-in output pinned by a drift test. `localeCompare` uses the
// runtime's ICU collation and the ambient `LANG`, so the SAME source could sort two different ways
// on two machines — turning the gate red with no source change, or masking a genuine reorder.
function compareCodepoints(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function activityLogSchemaDigestMaterial() {
  return {
    schemaVersion: 1,
    persistedEnvelope: ACTIVITY_LOG_PERSISTED_ENVELOPE_CONTRACT,
    vocabularies: {
      categories: ACTIVITY_LOG_CATEGORIES,
      fieldTypes: ACTIVITY_LOG_FIELD_TYPES,
      dataClasses: ACTIVITY_LOG_DATA_CLASSES,
      completenessStates: ACTIVITY_LOG_COMPLETENESS_STATES,
      lossStates: ACTIVITY_LOG_LOSS_STATES,
      errorKinds: ACTIVITY_LOG_ERROR_KINDS,
      compatibilityStates: ACTIVITY_LOG_COMPATIBILITY_STATES,
      writerCapabilityStates: ACTIVITY_LOG_WRITER_CAPABILITY_STATES,
      levels: ACTIVITY_LOG_LEVELS,
      buildClasses: ACTIVITY_LOG_BUILD_CLASSES,
      releaseClasses: ACTIVITY_LOG_RELEASE_CLASSES,
    },
    globalFields: ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS,
    exemptionBoundaries: ACTIVITY_LOG_EXEMPTION_BOUNDARIES,
    implementationObligations: ACTIVITY_LOG_IMPLEMENTATION_OBLIGATIONS,
    lifecyclePhases: ACTIVITY_LOG_LIFECYCLE_PHASES,
    analyzerProjections: ACTIVITY_LOG_ANALYZER_PROJECTIONS,
    releaseImpacts: ACTIVITY_LOG_RELEASE_IMPACTS,
  };
}

export function activityLogSchemaDigest() {
  return sha256(JSON.stringify(activityLogSchemaDigestMaterial()));
}

// Every workspace package's `src` root, derived from `packages/*` rather than a hand-maintained
// list — a hardcoded list can go stale the moment a new package adds `op:` instrumentation and
// nobody remembers to add it here, and the catalog would then silently stay incomplete with a
// green drift test. Sorted by codepoint so this root list — cosmetic today, since the final
// catalog is sorted by package/op/site regardless — never depends on directory-listing order.
function scannedPackageRoots(repoRoot) {
  const packagesDir = join(repoRoot, "packages");
  const names = readdirSync(packagesDir).filter((name) =>
    statSync(join(packagesDir, name)).isDirectory(),
  );
  const roots = names
    .filter((name) => existsSync(join(packagesDir, name, "src")))
    .map((name) => `packages/${name}/src`);
  return roots.toSorted(compareCodepoints);
}

// Explicit, checked-in table of helper functions/methods whose `op` is a positional argument
// rather than a named object-literal property. Discovered by grepping each scanned package for a
// function accepting an `op: string` parameter (or, for `note`, a returned closure whose type
// annotation does — see the comment on that entry). `argIndex` is 0-based over the call's
// arguments. `file` scopes the match to one file when the identifier is common enough to collide
// (`this.emit`, `note`); omit it when the helper name is unique across the scanned packages.
const POSITIONAL_OP_HELPERS = [
  // gatewayEvent(level, op, correlationId, extra, durationMs?, errorKind?) — category is hardcoded
  // "gateway" in the function body (`return { level, category: "gateway", op, ... }`).
  { name: "gatewayEvent", argIndex: 1, category: "gateway" },
  // retryEvent(context, level, op, durationMs, error, extra) — category hardcoded "gateway".
  { name: "retryEvent", argIndex: 2, category: "gateway" },
  // CircuitBreaker#emit(level, op, extra, correlationId) — private method, category hardcoded
  // "gateway"; scoped to resilience.ts because `emit` alone is a common identifier.
  {
    name: "this.emit",
    argIndex: 1,
    category: "gateway",
    file: "packages/keiko-model-gateway/src/resilience.ts",
  },
  // embeddingEvent(level, op, extra, status?, errorKind?) — category hardcoded "embedding".
  { name: "embeddingEvent", argIndex: 1, category: "embedding" },
  // logGitChangeEvent(deps, op, correlationId, extra) — category hardcoded "process" in the
  // helper body (packages/keiko-server/src/gitChangeRoutes.ts, #3400 Git-connected Chat).
  { name: "logGitChangeEvent", argIndex: 1, category: "process" },
  // logDispatch(log, op, fields) — forwards to embeddingEvent, category "embedding".
  { name: "logDispatch", argIndex: 1, category: "embedding" },
  // logLadderStop(log, request, op, completed, outcome) — category "embedding".
  { name: "logLadderStop", argIndex: 2, category: "embedding" },
  // degradeLogger(log, failure) returns a closure `(op, extra) => log.write(embeddingEvent(...))`
  // bound to a local `const note = degradeLogger(...)`; `note(...)` is where the four
  // "embedding.batch.degrade*"/"embedding.batch.degrading*" literals actually appear as
  // arguments. Scoped to this one file: `note` is too common an identifier to trust elsewhere.
  {
    name: "note",
    argIndex: 0,
    category: "embedding",
    file: "packages/keiko-model-gateway/src/openai-embedding-adapter.ts",
  },
  // logEmbeddingStoreRejected(op, error) — category hardcoded "memory".
  { name: "logEmbeddingStoreRejected", argIndex: 0, category: "memory" },
  // logEmbeddingRetry(options, outcome, op, durationMs, extra) — category "embedding" (via
  // logEmbedding's hardcoded category).
  { name: "logEmbeddingRetry", argIndex: 2, category: "embedding" },
  // logBatchClosed(options, level, op, counts) — category "embedding".
  { name: "logBatchClosed", argIndex: 2, category: "embedding" },
  // adoptPreflightIdentity(state, identity, op) — category "embedding" (via logEmbeddingRun's
  // hardcoded category).
  { name: "adoptPreflightIdentity", argIndex: 2, category: "embedding" },
  // logChatDispatch(log, op, fields) in openai-adapter.ts — category hardcoded "gateway" in the
  // function body. Deliberately its own name (not `logDispatch`) and its own file-scoped entry:
  // the embedding module's `logDispatch` above shares the same (log, op, fields) shape but is
  // hardcoded to category "embedding", and a bare name match would misattribute this chat-layer
  // call site to the wrong category.
  {
    name: "logChatDispatch",
    argIndex: 1,
    category: "gateway",
    file: "packages/keiko-model-gateway/src/openai-adapter.ts",
  },
  // logGitDeliveryApprovalEvent(activityLog, op, operation, correlationId, runId, commitPinned) —
  // category hardcoded "security" in the function body
  // (packages/keiko-server/src/gitDelivery/approvalEvents.ts, #3394 review: pushRoutes.ts's
  // logPushApprovalRequired/logPushApprovalMinted and prRoutes.ts's
  // logPrApprovalRequired/logPrApprovalMinted were four structurally identical functions,
  // consolidated into this one shared writer parameterized by `op` and `operation`).
  { name: "logGitDeliveryApprovalEvent", argIndex: 1, category: "security" },
];

// Exact diagnostic API shapes. Arbitrary `operation` payload fields are not instrumentation.
const DIAGNOSTIC_OBJECT_APIS = [
  { name: "emitServerDiagnostic", argIndex: 1 },
  { name: "serverDiagnosticFromError", argIndex: 0 },
  { name: "defaultServerDiagnosticSink.record", argIndex: 0 },
  {
    name: "sink.record",
    argIndex: 0,
    file: "packages/keiko-server/src/grounded-entailment-stage.ts",
  },
  {
    name: "diagnostics.record",
    argIndex: 0,
    file: "packages/keiko-server/src/coding-runtime/codingRuntimeEventHub.ts",
  },
  {
    name: "diagnostics.record",
    argIndex: 0,
    file: "packages/keiko-server/src/coding-app-session/sessionChannel.ts",
  },
];

// Functions that receive the whole log-event object literal as an argument and hardcode their own
// `category` before forwarding it to the sink (orchestrator.ts's logIndexing/logEmbeddingRun/
// logDocument, #2902 W5). Unlike POSITIONAL_OP_HELPERS, `op` here is a NAMED PROPERTY inside the
// object-literal argument, not a bare positional string — tier 1 (findSiblingCategory) never finds
// a sibling `category:` at these call sites because the category lives inside the callee's body,
// not the caller's object literal, and tier 3 (fileCategoryBinding) backs off for this file because
// it binds two distinct categories ("indexing" and "embedding") depending on which of these three
// functions is called. `file` scopes every entry, exactly like POSITIONAL_OP_HELPERS' scoped
// entries, so a same-named helper anywhere else is never misattributed.
const OBJECT_ARG_CATEGORY_FUNCTIONS = [
  {
    name: "logIndexing",
    category: "indexing",
    file: "packages/keiko-local-knowledge/src/indexing/orchestrator.ts",
  },
  {
    name: "logEmbeddingRun",
    category: "embedding",
    file: "packages/keiko-local-knowledge/src/indexing/orchestrator.ts",
  },
  {
    name: "logDocument",
    category: "indexing",
    file: "packages/keiko-local-knowledge/src/indexing/orchestrator.ts",
  },
];

function packageNameFromRoot(root) {
  const match = /^packages\/([^/]+)\/src$/.exec(root);
  if (match?.[1] === undefined) throw new Error(`Unexpected scanned root shape: ${root}`);
  return match[1];
}

function sourceFilesForRegistry(repoRoot) {
  return scannedPackageRoots(repoRoot).flatMap((root) =>
    walkTsFiles(join(repoRoot, ...root.split("/"))),
  );
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function stringLiteralType(checker, node, propertyName) {
  const property = checker.getTypeAtLocation(node).getProperty(propertyName);
  if (property === undefined) return undefined;
  const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? node;
  const type = checker.getTypeOfSymbolAtLocation(property, declaration);
  return type.isStringLiteral() ? type.value : undefined;
}

const CANONICAL_ACTIVITY_LOG_API =
  /\/packages\/keiko-contracts\/(?:src|dist)\/observability(?:\.d)?\.ts$/u;

function canonicalActivityLogApiName(checker, node) {
  const declaration = checker.getResolvedSignature(node)?.declaration;
  if (declaration === undefined) return undefined;
  const sourcePath = declaration.getSourceFile().fileName.replaceAll("\\", "/");
  if (!CANONICAL_ACTIVITY_LOG_API.test(sourcePath)) return undefined;
  return declaration.name !== undefined && ts.isIdentifier(declaration.name)
    ? declaration.name.text
    : undefined;
}

function typedCallKind(checker, node) {
  if (!ts.isCallExpression(node)) return undefined;
  const apiName = canonicalActivityLogApiName(checker, node);
  if (apiName === "activityLogEvent") return "activity-log-event";
  const expectedKind =
    apiName === "defineActivityLogOperation" ? "activity-log-operation" : undefined;
  return stringLiteralType(checker, node, "contractKind") === expectedKind
    ? expectedKind
    : undefined;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function literalPrimitive(value) {
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return { value: value.text };
  }
  if (ts.isNumericLiteral(value)) return { value: Number(value.text) };
  if (value.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (value.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  return undefined;
}

function constInitializer(checker, identifier) {
  if (checker === undefined) return undefined;
  let symbol = checker.getSymbolAtLocation(identifier);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declarations = symbol?.declarations ?? [];
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0];
  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return undefined;
  }
  return declaration.initializer;
}

function literalRegistryObject(value, checker, seen) {
  const result = Object.create(null);
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = literalRegistryValue(property.expression, checker, seen);
      if (spread === undefined || typeof spread !== "object" || Array.isArray(spread)) {
        return undefined;
      }
      Object.assign(result, spread);
      continue;
    }
    if (!ts.isPropertyAssignment(property)) return undefined;
    const name = propertyNameText(property.name);
    const propertyValue = literalRegistryValue(property.initializer, checker, seen);
    if (name === undefined || propertyValue === undefined) return undefined;
    result[name] = propertyValue;
  }
  return result;
}

function literalRegistryIdentifier(identifier, checker, seen) {
  const initializer = constInitializer(checker, identifier);
  if (initializer === undefined || seen.has(initializer)) return undefined;
  return literalRegistryValue(initializer, checker, new Set([...seen, initializer]));
}

function literalRegistryArray(value, checker, seen) {
  const items = [];
  for (const item of value.elements) {
    if (ts.isSpreadElement(item)) {
      const spread = literalRegistryValue(item.expression, checker, seen);
      if (!Array.isArray(spread)) return undefined;
      items.push(...spread);
      continue;
    }
    const itemValue = literalRegistryValue(item, checker, seen);
    if (itemValue === undefined) return undefined;
    items.push(itemValue);
  }
  return items;
}

function literalRegistryValue(expression, checker, seen = new Set()) {
  const value = unwrapExpression(expression);
  const primitive = literalPrimitive(value);
  if (primitive !== undefined) return primitive.value;
  if (ts.isIdentifier(value)) return literalRegistryIdentifier(value, checker, seen);
  if (ts.isArrayLiteralExpression(value)) return literalRegistryArray(value, checker, seen);
  return ts.isObjectLiteralExpression(value)
    ? literalRegistryObject(value, checker, seen)
    : undefined;
}

function registrySite(repoRoot, sourceFile, node) {
  const relPath = relative(repoRoot, sourceFile.fileName).replaceAll("\\", "/");
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return `${relPath}:${String(line)}`;
}

function registryViolation(code, site, correctiveAction) {
  return { code, site, correctiveAction };
}

function exemptionSite(index) {
  return `typedRegistry.exemptions[${String(index)}]`;
}

function validExpiryDate(value) {
  if (typeof value !== "string" || !EXEMPTION_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validExemptionToken(value) {
  return typeof value === "string" && REGISTRATION_TOKEN.test(value);
}

function validExemptionOperation(value) {
  return typeof value === "string" && OP_NAME_PATTERN.test(value);
}

function validExemptionReason(value) {
  return typeof value === "string" && value.trim().length >= 16 && value.length <= 512;
}

function invalidExemptionField(exemption) {
  if (typeof exemption !== "object" || exemption === null || Array.isArray(exemption)) {
    return "record";
  }
  if (!Object.keys(exemption).every((key) => EXEMPTION_KEYS.has(key))) return "unknown-key";
  const checks = [
    { field: "contractKind", valid: exemption.contractKind === "activity-log-exemption" },
    { field: "schemaVersion", valid: exemption.schemaVersion === 1 },
    { field: "id", valid: validExemptionToken(exemption.id) },
    { field: "operation", valid: validExemptionOperation(exemption.operation) },
    { field: "failureClass", valid: validExemptionToken(exemption.failureClass) },
    { field: "boundary", valid: EXEMPTION_BOUNDARIES.has(exemption.boundary) },
    { field: "owner", valid: validExemptionToken(exemption.owner) },
    { field: "reason", valid: validExemptionReason(exemption.reason) },
    {
      field: "trackingIssue",
      valid: Number.isInteger(exemption.trackingIssue) && exemption.trackingIssue > 0,
    },
    { field: "expiresOn", valid: validExpiryDate(exemption.expiresOn) },
  ];
  return checks.find(({ valid }) => !valid)?.field;
}

function exemptionViolation(code, index, detail, correctiveAction) {
  return {
    ...registryViolation(code, exemptionSite(index), correctiveAction),
    detail,
  };
}

function exemptionScopeViolation(exemption, operations, index) {
  const operation = operations.find((candidate) => candidate.op === exemption.operation);
  if (operation === undefined) {
    return exemptionViolation(
      "exemption-unknown-operation",
      index,
      exemption.operation,
      "Scope the exemption to one registered production operation.",
    );
  }
  if (!operation.failureClasses.includes(exemption.failureClass)) {
    return exemptionViolation(
      "exemption-failure-class-mismatch",
      index,
      exemption.failureClass,
      "Scope the exemption to a failure class declared by the selected operation.",
    );
  }
  if (exemption.owner !== operation.owner) {
    return exemptionViolation(
      "exemption-owner-mismatch",
      index,
      exemption.owner,
      "Assign the exemption to the package that owns the registered operation.",
    );
  }
  return undefined;
}

function exemptionValidityViolation(exemption, index, window) {
  if (exemption.expiresOn < window.today) {
    return exemptionViolation(
      "exemption-expired",
      index,
      exemption.expiresOn,
      "Remove the expired exemption or complete the linked remediation before release.",
    );
  }
  if (exemption.expiresOn > window.latestExpiry) {
    return exemptionViolation(
      "exemption-permanent",
      index,
      exemption.expiresOn,
      `Set an expiry at most ${String(ACTIVITY_LOG_EXEMPTION_SCHEMA.maximumValidityDays)} days ahead; renew only through a new review.`,
    );
  }
  return undefined;
}

function validateExemptionEntry(exemption, index, operations, window, ids) {
  const violations = [];
  const invalidField = invalidExemptionField(exemption);
  if (invalidField !== undefined) {
    return [
      exemptionViolation(
        "exemption-invalid",
        index,
        invalidField,
        "Provide every bounded exemption field and remove any authorization-like extra key.",
      ),
    ];
  }
  if (ids.has(exemption.id)) {
    violations.push(
      exemptionViolation(
        "exemption-duplicate",
        index,
        exemption.id,
        "Give each reviewed exemption one stable unique id.",
      ),
    );
  }
  ids.add(exemption.id);
  const validityViolation = exemptionValidityViolation(exemption, index, window);
  if (validityViolation !== undefined) violations.push(validityViolation);
  const scopeViolation = exemptionScopeViolation(exemption, operations, index);
  if (scopeViolation !== undefined) violations.push(scopeViolation);
  return violations;
}

export function validateActivityLogRegistryExemptions(exemptions, operations, now = new Date()) {
  if (
    !Array.isArray(exemptions) ||
    exemptions.length > ACTIVITY_LOG_EXEMPTION_SCHEMA.maximumEntries
  ) {
    return [
      registryViolation(
        "exemption-registry-invalid",
        "typedRegistry.exemptions",
        "Keep the reviewed exemption registry as a bounded array of exact records.",
      ),
    ];
  }
  const window = {
    today: now.toISOString().slice(0, 10),
    latestExpiry: new Date(
      now.valueOf() + ACTIVITY_LOG_EXEMPTION_SCHEMA.maximumValidityDays * MILLISECONDS_PER_DAY,
    )
      .toISOString()
      .slice(0, 10),
  };
  const ids = new Set();
  return exemptions.flatMap((exemption, index) =>
    validateExemptionEntry(exemption, index, operations, window, ids),
  );
}

function visitSource(sourceFile, visit) {
  const walk = (node) => {
    visit(node);
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
}

function registrationSymbol(checker, call) {
  const parent = call.parent;
  if (!ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name)) return undefined;
  return checker.getSymbolAtLocation(parent.name);
}

function emittedRegistrationSymbol(checker, expression) {
  const value = unwrapExpression(expression);
  if (!ts.isIdentifier(value)) return undefined;
  const symbol = checker.getSymbolAtLocation(value);
  return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function typedRegistryProgram(repoRoot) {
  const rootNames = sourceFilesForRegistry(repoRoot);
  return ts.createProgram({
    rootNames,
    options: {
      baseUrl: repoRoot,
      paths: {
        "@oscharko-dev/keiko-contracts/runtime/observability": [
          "packages/keiko-contracts/src/observability.ts",
        ],
        "@oscharko-dev/keiko-contracts/runtime/pr-description": [
          "packages/keiko-contracts/src/pr-description.ts",
        ],
      },
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      strict: true,
    },
  });
}

export function isTypedRegistrySourceFile(repoRoot, sourceFile) {
  const packagesRoot = `${join(repoRoot, "packages").replaceAll("\\", "/")}/`;
  return sourceFile.fileName.replaceAll("\\", "/").startsWith(packagesRoot);
}

function relevantRegistrySource(sourceFile) {
  return (
    sourceFile.text.includes("defineActivityLogOperation") ||
    sourceFile.text.includes("activityLogEvent")
  );
}

function diagnosticSite(repoRoot, diagnostic) {
  if (diagnostic.file === undefined || diagnostic.start === undefined) return "registry-program";
  return registrySite(repoRoot, diagnostic.file, {
    getStart: () => diagnostic.start,
  });
}

function typedRegistryDiagnostics(program, repoRoot) {
  const diagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
  return diagnostics
    .filter(
      (diagnostic) => diagnostic.file !== undefined && relevantRegistrySource(diagnostic.file),
    )
    .map((diagnostic) => ({
      ...registryViolation(
        "typescript-diagnostic",
        diagnosticSite(repoRoot, diagnostic),
        "Repair the typed Activity Log registration or emission before generating the registry.",
      ),
      detail: `TS${String(diagnostic.code)}`,
    }));
}

function invalidClosedStringArray(value, pattern = REGISTRATION_TOKEN) {
  return (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 64 ||
    value.some((item) => typeof item !== "string" || !pattern.test(item))
  );
}

function invalidOptionalBound(value, maximum) {
  return value !== undefined && (!Number.isInteger(value) || value <= 0 || value > maximum);
}

function validFieldContractShape(contract) {
  return typeof contract === "object" && contract !== null && !Array.isArray(contract);
}

function validFieldContractValues(contract) {
  if (contract.values === undefined) {
    return contract.dataClass !== "closed-enum" || contract.type === "boolean";
  }
  return !invalidClosedStringArray(contract.values, REGISTRATION_CLOSED_VALUE);
}

function fieldContractIsBounded(contract) {
  if (contract.type === "string-array") {
    return (
      contract.maxItems !== undefined &&
      (contract.maxLength !== undefined || contract.values !== undefined)
    );
  }
  if (contract.type !== "string") return true;
  if (contract.dataClass === "completeness-state" || contract.dataClass === "loss-state") {
    return true;
  }
  return contract.maxLength !== undefined || contract.values !== undefined;
}

function invalidFieldContract(name, contract) {
  if (!REGISTRATION_FIELD_NAME.test(name)) return name;
  if (!validFieldContractShape(contract)) return name;
  const valid = [
    Object.keys(contract).every((key) => REGISTRATION_FIELD_KEYS.has(key)),
    REGISTRATION_FIELD_TYPES.has(contract.type),
    REGISTRATION_DATA_CLASSES.has(contract.dataClass),
    typeof contract.required === "boolean",
    !invalidOptionalBound(contract.maxLength, 8192),
    !invalidOptionalBound(contract.maxItems, 64),
    validFieldContractValues(contract),
    fieldContractIsBounded(contract),
  ];
  return valid.every(Boolean) ? undefined : name;
}

function invalidFields(fields) {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return "fields";
  const entries = Object.entries(fields);
  const contextFieldCount = entries.filter(
    ([name]) => ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS[name] === undefined,
  ).length;
  if (contextFieldCount > 48) return "fields";
  for (const [name, contract] of entries) {
    const invalid = invalidFieldContract(name, contract);
    if (invalid !== undefined) return `fields.${invalid}`;
  }
  return undefined;
}

function matchesGlobalFieldContract(actual, expected) {
  return (
    actual.type === expected.type &&
    actual.dataClass === expected.dataClass &&
    actual.required === expected.required &&
    actual.maxLength === undefined &&
    actual.maxItems === undefined &&
    actual.values === undefined
  );
}

function invalidGlobalFieldOverride(fields) {
  for (const [name, expected] of Object.entries(ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS)) {
    const actual = fields[name];
    if (actual !== undefined && !matchesGlobalFieldContract(actual, expected)) return name;
  }
  return undefined;
}

function invalidRegistrationField(value) {
  const fields = invalidFields(value.fields);
  if (fields !== undefined) return fields;
  const checks = [
    { field: "unknown-key", valid: Object.keys(value).every((key) => REGISTRATION_KEYS.has(key)) },
    { field: "contractKind", valid: value.contractKind === "activity-log-operation" },
    { field: "schemaVersion", valid: value.schemaVersion === 1 },
    { field: "op", valid: typeof value.op === "string" && OP_NAME_PATTERN.test(value.op) },
    { field: "category", valid: REGISTRATION_CATEGORIES.has(value.category) },
    {
      field: "owner",
      valid: typeof value.owner === "string" && REGISTRATION_TOKEN.test(value.owner),
    },
    {
      field: "emitter",
      valid: typeof value.emitter === "string" && REGISTRATION_TOKEN.test(value.emitter),
    },
    { field: "causal", valid: REGISTRATION_CAUSAL.has(value.causal) },
    { field: "lifecycle", valid: REGISTRATION_LIFECYCLE.has(value.lifecycle) },
    {
      field: "analyzerProjection",
      valid: REGISTRATION_PROJECTIONS.has(value.analyzerProjection),
    },
    { field: "failureClasses", valid: !invalidClosedStringArray(value.failureClasses) },
    { field: "proofIds", valid: !invalidClosedStringArray(value.proofIds) },
    { field: "releaseImpact", valid: REGISTRATION_RELEASE_IMPACTS.has(value.releaseImpact) },
  ];
  return checks.find(({ valid }) => !valid)?.field;
}

function pushInvalidRegistration(context, site, detail, correctiveAction) {
  context.violations.push({
    ...registryViolation("registration-invalid", site, correctiveAction),
    detail,
  });
}

function rejectInvalidRegistrationField(context, site, value) {
  const invalidField = invalidRegistrationField(value);
  if (invalidField === undefined) return false;
  pushInvalidRegistration(
    context,
    site,
    invalidField,
    "Use the closed ActivityLogOperationRegistration contract and literal bounded metadata.",
  );
  return true;
}

function registrationLiteral(context, node, site) {
  const argument = node.arguments[0];
  const value =
    argument === undefined ? undefined : literalRegistryValue(argument, context.checker);
  if (value !== undefined && typeof value.op === "string") return value;
  context.violations.push(
    registryViolation(
      "registration-not-literal",
      site,
      "Pass one closed object literal with a literal op to defineActivityLogOperation.",
    ),
  );
  return undefined;
}

// Persisted-line redaction omits an empty `frames`/`causeChain` array, so a registration that
// declares one required would reject every failure line without Keiko frames or a cause (#3532:
// found twice as separate product defects). The rule is registry-wide so the class cannot recur.
function rejectRequiredOmittedWhenEmptyField(context, site, fields) {
  const name = ACTIVITY_LOG_OMITTED_WHEN_EMPTY_FIELD_NAMES.find(
    (fieldName) => fields[fieldName]?.required === true,
  );
  if (name === undefined) return false;
  context.violations.push({
    ...registryViolation(
      "registration-omitted-field-required",
      site,
      "Declare frames and causeChain optional: redaction omits an empty array, so a required one rejects every failure line without Keiko frames or a cause.",
    ),
    detail: `fields.${name}`,
  });
  return true;
}

// The sink stamps the envelope names itself and redaction drops a producer value for any of them, so
// a registered field with one of those names never reaches the line as declared (#3532: a skill
// catalog digest persisted as the log format's own catalog digest, a PR-description schema version as
// the envelope's).
function rejectReservedEnvelopeField(context, site, fields) {
  const name = ACTIVITY_LOG_RESERVED_FIELD_NAMES.find(
    (fieldName) => fields[fieldName] !== undefined,
  );
  if (name === undefined) return false;
  context.violations.push({
    ...registryViolation(
      "registration-reserved-field",
      site,
      "Rename the field: the sink stamps a reserved envelope field of that name and redaction drops a producer value for it.",
    ),
    detail: `fields.${name}`,
  });
  return true;
}

function collectTypedRegistration(context, sourceFile, node) {
  if (typedCallKind(context.checker, node) !== "activity-log-operation") return;
  const site = registrySite(context.repoRoot, sourceFile, node);
  const value = registrationLiteral(context, node, site);
  if (value === undefined) return;
  if (rejectInvalidRegistrationField(context, site, value)) return;
  if (rejectRequiredOmittedWhenEmptyField(context, site, value.fields)) return;
  if (rejectReservedEnvelopeField(context, site, value.fields)) return;
  const invalidGlobalField = invalidGlobalFieldOverride(value.fields);
  if (invalidGlobalField !== undefined) {
    pushInvalidRegistration(
      context,
      site,
      `fields.${invalidGlobalField}`,
      "Use the mandatory global completeness and loss field contracts without modification.",
    );
    return;
  }
  const valueWithGlobalFields = {
    ...value,
    fields: { ...ACTIVITY_LOG_GLOBAL_FIELD_CONTRACTS, ...value.fields },
  };
  if (rejectInvalidRegistrationField(context, site, valueWithGlobalFields)) return;
  const operation = { ...valueWithGlobalFields, registrationSite: site, emitterSites: [] };
  context.operations.push(operation);
  const symbol = registrationSymbol(context.checker, node);
  if (symbol !== undefined) context.bySymbol.set(symbol, operation);
}

function collectTypedEmission(context, sourceFile, node) {
  if (typedCallKind(context.checker, node) !== "activity-log-event") return;
  const site = registrySite(context.repoRoot, sourceFile, node);
  const argument = node.arguments[0];
  const symbol =
    argument === undefined ? undefined : emittedRegistrationSymbol(context.checker, argument);
  const operation = symbol === undefined ? undefined : context.bySymbol.get(symbol);
  if (operation === undefined) {
    context.violations.push(
      registryViolation(
        "emission-unregistered",
        site,
        "Pass a local defineActivityLogOperation registration to activityLogEvent.",
      ),
    );
    return;
  }
  operation.emitterSites.push(site);
}

function collectTypedSites(context, sourceFiles, collector) {
  for (const sourceFile of sourceFiles) {
    visitSource(sourceFile, (node) => collector(context, sourceFile, node));
  }
}

function addDuplicateRegistrationViolations(context) {
  const byOp = Map.groupBy(context.operations, (operation) => operation.op);
  for (const [op, registrations] of byOp) {
    if (registrations.length < 2) continue;
    context.violations.push({
      ...registryViolation(
        "registration-duplicate",
        registrations[0].registrationSite,
        "Keep exactly one defineActivityLogOperation registration for each operation.",
      ),
      detail: op,
    });
  }
}

function addMissingEmitterViolations(context) {
  for (const operation of context.operations) {
    if (operation.emitterSites.length > 0) continue;
    context.violations.push({
      ...registryViolation(
        "registration-not-emitted",
        operation.registrationSite,
        "Emit the registered operation through activityLogEvent at its production owner.",
      ),
      detail: operation.op,
    });
  }
}

// An operation is emitted only inside its owner package, which reaches the log through its own
// port. An emission from any other package bypasses that owning port, whatever it imports.
function addOwnerBypassViolations(context) {
  for (const operation of context.operations) {
    const ownerRoot = `packages/${operation.owner}/`;
    for (const site of operation.emitterSites) {
      if (site.startsWith(ownerRoot)) continue;
      context.violations.push({
        ...registryViolation(
          "emission-outside-owner",
          site,
          "Emit the operation inside its owner package through that package's log port, or move " +
            "the registration to the package that emits it.",
        ),
        detail: operation.op,
      });
    }
  }
}

function operationContextFields(operation) {
  return Object.entries(operation.fields)
    .filter(([name]) => name !== "completeness" && name !== "loss")
    .map(([name, contract]) => ({
      name,
      type: contract.type,
      dataClass: contract.dataClass,
      required: contract.required,
    }))
    .toSorted((left, right) => compareCodepoints(left.name, right.name));
}

function operationEvidenceClasses(operation) {
  return [...new Set(Object.values(operation.fields).map((field) => field.dataClass))].toSorted(
    compareCodepoints,
  );
}

// Registration already rejects empty proofIds, so a missing executable proof surfaces as a
// typed-registry violation and through the failure-class contract comparison, never here.
function operationCoverageMissing(operation) {
  return operation.emitterSites.length === 0 ? ["failure-evidence"] : [];
}

function sortedUnique(values) {
  return [...new Set(values)].toSorted(compareCodepoints);
}

function sameStringSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isCanonicalStringArray(value, validValue, allowEmpty = true) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return false;
  if (!value.every((item) => typeof item === "string" && validValue(item))) return false;
  return sameStringSet(value, sortedUnique(value));
}

function lifecycleOperations(members) {
  return Object.fromEntries(
    ACTIVITY_LOG_LIFECYCLE_PHASES.map((phase) => [
      phase,
      members
        .filter((operation) => operation.lifecycle === phase)
        .map((operation) => operation.op)
        .toSorted(compareCodepoints),
    ]),
  );
}

function failureClassContractSite(failureClass, index) {
  return typeof failureClass === "string"
    ? `typedRegistry.failureClassContracts.${failureClass}`
    : `typedRegistry.failureClassContracts[${String(index)}]`;
}

function failureClassContractViolation(code, failureClass, index, detail, correctiveAction) {
  return {
    ...registryViolation(code, failureClassContractSite(failureClass, index), correctiveAction),
    detail,
  };
}

function invalidFailureClassLifecycle(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "record";
  if (
    !sameStringSet(
      Object.keys(value).toSorted(compareCodepoints),
      [...ACTIVITY_LOG_LIFECYCLE_PHASES].toSorted(compareCodepoints),
    )
  ) {
    return "keys";
  }
  return ACTIVITY_LOG_LIFECYCLE_PHASES.find(
    (phase) => !isCanonicalStringArray(value[phase], (op) => OP_NAME_PATTERN.test(op)),
  );
}

function failureClassContractIdentityChecks(contract, invalidLifecycle) {
  return [
    { field: "contractKind", valid: contract.contractKind === "activity-log-failure-class" },
    { field: "schemaVersion", valid: contract.schemaVersion === 1 },
    {
      field: "failureClass",
      valid:
        typeof contract.failureClass === "string" && REGISTRATION_TOKEN.test(contract.failureClass),
    },
    {
      field: "requiredProductSurfaces",
      valid: isCanonicalStringArray(
        contract.requiredProductSurfaces,
        (owner) => REGISTRATION_TOKEN.test(owner),
        false,
      ),
    },
    { field: "requiredLifecycleOperations", valid: invalidLifecycle === undefined },
  ];
}

function failureClassContractOperationChecks(contract) {
  const validOperation = (op) => OP_NAME_PATTERN.test(op);
  return [
    {
      field: "requiredCausalOperations",
      valid: isCanonicalStringArray(contract.requiredCausalOperations, validOperation),
    },
    {
      field: "requiredLossOperations",
      valid: isCanonicalStringArray(contract.requiredLossOperations, validOperation),
    },
    {
      field: "requiredProofOperations",
      valid: isCanonicalStringArray(contract.requiredProofOperations, validOperation),
    },
    {
      field: "requiredReplayProofIds",
      valid: isCanonicalStringArray(contract.requiredReplayProofIds, (proofId) =>
        REGISTRATION_TOKEN.test(proofId),
      ),
    },
    {
      field: "requiredResourceOperations",
      valid: isCanonicalStringArray(contract.requiredResourceOperations, validOperation),
    },
    {
      field: "requiredEvidenceClasses",
      valid: isCanonicalStringArray(
        contract.requiredEvidenceClasses,
        (dataClass) => REGISTRATION_DATA_CLASSES.has(dataClass),
        false,
      ),
    },
    {
      field: "requiredFrameOperations",
      valid: isCanonicalStringArray(contract.requiredFrameOperations, validOperation),
    },
    {
      field: "requiredCauseOperations",
      valid: isCanonicalStringArray(contract.requiredCauseOperations, validOperation),
    },
  ];
}

function invalidFailureClassContractField(contract) {
  if (typeof contract !== "object" || contract === null || Array.isArray(contract)) return "record";
  if (!Object.keys(contract).every((key) => FAILURE_CLASS_CONTRACT_KEYS.has(key))) {
    return "unknown-key";
  }
  const invalidLifecycle = invalidFailureClassLifecycle(contract.requiredLifecycleOperations);
  const checks = [
    ...failureClassContractIdentityChecks(contract, invalidLifecycle),
    ...failureClassContractOperationChecks(contract),
  ];
  return (
    checks.find(({ valid }) => !valid)?.field ??
    (invalidLifecycle === undefined ? undefined : `requiredLifecycleOperations.${invalidLifecycle}`)
  );
}

function requiredContractOperations(contract) {
  return sortedUnique(
    ACTIVITY_LOG_LIFECYCLE_PHASES.flatMap((phase) => contract.requiredLifecycleOperations[phase]),
  );
}

function contractInternalViolations(contract, index) {
  const failureClass = contract?.failureClass;
  const invalidField = invalidFailureClassContractField(contract);
  if (invalidField !== undefined) {
    return [
      failureClassContractViolation(
        "failure-class-contract-invalid",
        failureClass,
        index,
        invalidField,
        "Declare one closed, codepoint-sorted failure-class obligation record.",
      ),
    ];
  }
  const requiredOperations = requiredContractOperations(contract);
  const lifecycleLoss = contract.requiredLifecycleOperations.loss;
  const checks = [
    {
      valid: sameStringSet(contract.requiredLossOperations, lifecycleLoss),
      detail: "requiredLossOperations",
    },
    {
      valid: sameStringSet(contract.requiredProofOperations, requiredOperations),
      detail: "requiredProofOperations",
    },
    ...[
      ["requiredCausalOperations", contract.requiredCausalOperations],
      ["requiredFrameOperations", contract.requiredFrameOperations],
      ["requiredCauseOperations", contract.requiredCauseOperations],
      ["requiredResourceOperations", contract.requiredResourceOperations],
    ].map(([detail, operations]) => ({
      valid: operations.every((op) => requiredOperations.includes(op)),
      detail,
    })),
  ];
  const failed = checks.find(({ valid }) => !valid);
  return failed === undefined
    ? []
    : [
        failureClassContractViolation(
          "failure-class-contract-inconsistent",
          failureClass,
          index,
          failed.detail,
          "Keep loss, causal, frame, cause, and proof obligations inside the exact lifecycle membership.",
        ),
      ];
}

function actualFailureClassFacts(members) {
  return {
    operations: members.map((operation) => operation.op).toSorted(compareCodepoints),
    productSurfaces: sortedUnique(members.map((operation) => operation.owner)),
    lifecycleOperations: lifecycleOperations(members),
    causalOperations: members
      .filter((operation) => operation.causal !== "none")
      .map((operation) => operation.op)
      .toSorted(compareCodepoints),
    lossOperations: members
      .filter((operation) => operation.lifecycle === "loss")
      .map((operation) => operation.op)
      .toSorted(compareCodepoints),
    proofOperations: members
      .filter((operation) => operation.proofIds.length > 0)
      .map((operation) => operation.op)
      .toSorted(compareCodepoints),
    replayProofIds: sortedUnique(
      members.flatMap((operation) =>
        operation.proofIds.filter((proofId) => /replay|seed|fixture/u.test(proofId)),
      ),
    ),
    resourceOperations: members
      .filter((operation) => ["start", "state", "end"].includes(operation.lifecycle))
      .map((operation) => operation.op)
      .toSorted(compareCodepoints),
    evidenceClasses: sortedUnique(members.flatMap(operationEvidenceClasses)),
    frameOperations: members
      .filter((operation) => operation.fields.frames !== undefined)
      .map((operation) => operation.op)
      .toSorted(compareCodepoints),
    causeOperations: members
      .filter((operation) => operation.fields.causeChain !== undefined)
      .map((operation) => operation.op)
      .toSorted(compareCodepoints),
  };
}

function contractFactChecks(contract, facts) {
  return [
    ["product-surfaces", contract.requiredProductSurfaces, facts.productSurfaces],
    ...ACTIVITY_LOG_LIFECYCLE_PHASES.map((phase) => [
      `lifecycle-${phase}`,
      contract.requiredLifecycleOperations[phase],
      facts.lifecycleOperations[phase],
    ]),
    ["causal-edges", contract.requiredCausalOperations, facts.causalOperations],
    ["loss-signals", contract.requiredLossOperations, facts.lossOperations],
    ["executable-proof", contract.requiredProofOperations, facts.proofOperations],
    ["replay-references", contract.requiredReplayProofIds, facts.replayProofIds],
    ["resource-signals", contract.requiredResourceOperations, facts.resourceOperations],
    ["evidence-classes", contract.requiredEvidenceClasses, facts.evidenceClasses],
    ["frame-evidence", contract.requiredFrameOperations, facts.frameOperations],
    ["cause-evidence", contract.requiredCauseOperations, facts.causeOperations],
  ];
}

function contractFactViolations(contract, index, members) {
  const facts = actualFailureClassFacts(members);
  return contractFactChecks(contract, facts)
    .filter(([, required, actual]) => !sameStringSet(required, actual))
    .map(([detail]) =>
      failureClassContractViolation(
        "failure-class-contract-unsatisfied",
        contract.failureClass,
        index,
        detail,
        "Make the typed operation memberships satisfy the explicit canonical failure-class obligation.",
      ),
    );
}

function invalidFailureClassRegistryAnalysis() {
  return {
    contracts: [],
    violations: [
      failureClassContractViolation(
        "failure-class-contract-registry-invalid",
        undefined,
        0,
        "record",
        "Provide the bounded canonical failure-class obligation registry.",
      ),
    ],
  };
}

function collectUsableFailureClassContracts(contracts) {
  const violations = [];
  const usableContracts = [];
  const byFailureClass = new Map();
  contracts.forEach((contract, index) => {
    const internalViolations = contractInternalViolations(contract, index);
    violations.push(...internalViolations);
    if (internalViolations.length > 0) return;
    const existing = byFailureClass.get(contract.failureClass);
    if (existing !== undefined) {
      violations.push(
        failureClassContractViolation(
          "failure-class-contract-duplicate",
          contract.failureClass,
          index,
          contract.failureClass,
          "Keep exactly one canonical obligation declaration per failure class.",
        ),
      );
      return;
    }
    byFailureClass.set(contract.failureClass, contract);
    usableContracts.push(contract);
  });
  return { byFailureClass, usableContracts, violations };
}

function addMissingFailureClassContractViolations(analysis, operations) {
  const operationClasses = sortedUnique(
    operations.flatMap((operation) => operation.failureClasses),
  );
  for (const failureClass of operationClasses) {
    if (analysis.byFailureClass.has(failureClass)) continue;
    analysis.violations.push(
      failureClassContractViolation(
        "failure-class-contract-missing",
        failureClass,
        0,
        failureClass,
        "Declare the failure class and all of its obligations before using it in an operation.",
      ),
    );
  }
}

function addUnsatisfiedFailureClassContractViolations(analysis, operations) {
  analysis.usableContracts.forEach((contract, index) => {
    const members = operations.filter((operation) =>
      operation.failureClasses.includes(contract.failureClass),
    );
    analysis.violations.push(...contractFactViolations(contract, index, members));
  });
}

function analyzeFailureClassContracts(contracts, operations) {
  if (!Array.isArray(contracts)) return invalidFailureClassRegistryAnalysis();
  const analysis = collectUsableFailureClassContracts(contracts);
  addMissingFailureClassContractViolations(analysis, operations);
  addUnsatisfiedFailureClassContractViolations(analysis, operations);
  return { contracts: analysis.usableContracts, violations: analysis.violations };
}

export function validateActivityLogFailureClassContracts(contracts, operations) {
  return analyzeFailureClassContracts(contracts, operations).violations;
}

function failureClassOperation(operation) {
  return {
    op: operation.op,
    owner: operation.owner,
    category: operation.category,
    lifecycle: operation.lifecycle,
    causal: operation.causal,
    analyzerProjection: operation.analyzerProjection,
    safeContextFields: operationContextFields(operation),
    evidenceClasses: operationEvidenceClasses(operation),
    frameCauseEvidence: {
      frames: operation.fields.frames !== undefined,
      causeChain: operation.fields.causeChain !== undefined,
    },
    proofIds: operation.proofIds,
    replayReferences: operation.proofIds.filter((proofId) => /replay|seed|fixture/u.test(proofId)),
    missingObligations: operationCoverageMissing(operation),
  };
}

function failureClassEntry(failureClass, operations, contract, contractViolations) {
  const members = operations
    .filter((operation) => operation.failureClasses.includes(failureClass))
    .toSorted((left, right) => compareCodepoints(left.op, right.op));
  const coveredOperations = members.map(failureClassOperation);
  const missingObligations = [
    ...new Set(coveredOperations.flatMap((operation) => operation.missingObligations)),
    ...contractViolations.map(({ detail }) => detail),
  ].toSorted(compareCodepoints);
  const facts = actualFailureClassFacts(members);
  return {
    failureClass,
    requirementContract: contract?.failureClass,
    productSurfaces: [...new Set(members.map((operation) => operation.owner))].toSorted(
      compareCodepoints,
    ),
    lifecycleTransitions: [...new Set(members.map((operation) => operation.lifecycle))].toSorted(
      compareCodepoints,
    ),
    lifecycleOperations: facts.lifecycleOperations,
    causalEdges: members.map((operation) => ({ op: operation.op, mode: operation.causal })),
    lossSignals: facts.lossOperations,
    resourceSignals: facts.resourceOperations,
    replayReferences: facts.replayProofIds,
    operations: coveredOperations,
    missingObligations,
    completeness: missingObligations.length === 0 ? "complete" : "incomplete",
  };
}

function failureClassCoverage(operations, analysis) {
  const failureClasses = sortedUnique([
    ...operations.flatMap((operation) => operation.failureClasses),
    ...analysis.contracts.map((contract) => contract.failureClass),
  ]);
  const classes = failureClasses.map((failureClass) => {
    const contract = analysis.contracts.find(
      (candidate) => candidate.failureClass === failureClass,
    );
    const contractViolations = analysis.violations.filter((violation) =>
      violation.site.endsWith(`.${failureClass}`),
    );
    if (contract === undefined) {
      contractViolations.push({ detail: "failure-class-contract" });
    }
    return failureClassEntry(failureClass, operations, contract, contractViolations);
  });
  const completeClassCount = classes.filter((entry) => entry.completeness === "complete").length;
  return {
    schemaVersion: 1,
    releaseExpectation: "100%-complete",
    supportedClassCount: classes.length,
    completeClassCount,
    completeness: completeClassCount === classes.length ? "complete" : "incomplete",
    classes,
  };
}

function failureClassCoverageViolations(coverage) {
  return coverage.classes
    .filter((entry) => entry.completeness !== "complete")
    .map((entry) => ({
      ...registryViolation(
        "failure-class-incomplete",
        `typedRegistry.failureClassCoverage.${entry.failureClass}`,
        "Add the missing registered completeness, loss, and executable proof obligations.",
      ),
      detail: entry.missingObligations.join(","),
    }));
}

export function generateTypedActivityLogRegistry(
  repoRoot = REPO_ROOT,
  failureClassContracts = ACTIVITY_LOG_FAILURE_CLASS_CONTRACTS,
) {
  const program = typedRegistryProgram(repoRoot);
  const checker = program.getTypeChecker();
  const operations = [];
  const bySymbol = new Map();
  const violations = typedRegistryDiagnostics(program, repoRoot);
  const sourceFiles = program
    .getSourceFiles()
    .filter((sourceFile) => isTypedRegistrySourceFile(repoRoot, sourceFile));
  const context = { repoRoot, checker, operations, bySymbol, violations };
  collectTypedSites(context, sourceFiles, collectTypedRegistration);
  collectTypedSites(context, sourceFiles, collectTypedEmission);
  addDuplicateRegistrationViolations(context);
  addMissingEmitterViolations(context);
  addOwnerBypassViolations(context);

  const sortedOperations = operations.toSorted((left, right) =>
    compareCodepoints(left.op, right.op),
  );
  const exemptions = [...ACTIVITY_LOG_REGISTRY_EXEMPTIONS];
  const failureClassAnalysis = analyzeFailureClassContracts(
    failureClassContracts,
    sortedOperations,
  );
  const failureCoverage = failureClassCoverage(sortedOperations, failureClassAnalysis);
  violations.push(
    ...validateActivityLogRegistryExemptions(exemptions, sortedOperations),
    ...failureClassAnalysis.violations,
    ...failureClassCoverageViolations(failureCoverage),
  );
  return {
    schemaVersion: 1,
    schemaDigest: activityLogSchemaDigest(),
    catalogDigest: sha256(
      JSON.stringify({ operations: sortedOperations, exemptions, failureClassContracts }),
    ),
    obligationCategories: ACTIVITY_LOG_IMPLEMENTATION_OBLIGATIONS,
    operations: sortedOperations,
    exemptionSchema: ACTIVITY_LOG_EXEMPTION_SCHEMA,
    exemptions,
    failureClassContracts,
    failureClassCoverage: failureCoverage,
    violations: violations.toSorted((left, right) => compareCodepoints(left.site, right.site)),
  };
}

function runtimeOperationContract(operation) {
  return {
    contractKind: operation.contractKind,
    schemaVersion: operation.schemaVersion,
    op: operation.op,
    category: operation.category,
    owner: operation.owner,
    emitter: operation.emitter,
    fields: operation.fields,
    causal: operation.causal,
    lifecycle: operation.lifecycle,
    analyzerProjection: operation.analyzerProjection,
    failureClasses: operation.failureClasses,
    proofIds: operation.proofIds,
    releaseImpact: operation.releaseImpact,
  };
}

// The failure-surface inventory's op -> surface mapping, as product runtime needs it (support
// incidents fingerprint a defect by its owning surface). Derived from the same inventory the JSON
// view is written from, so the two can never disagree.
export function activityLogOperationSurfaces(inventory) {
  return Object.fromEntries(
    inventory.surfaces
      .flatMap((entry) => entry.operations.map((op) => [op, entry.surface]))
      .toSorted(([left], [right]) => compareCodepoints(left, right)),
  );
}

export function runtimeRegistryModule(typedRegistry, inventory) {
  const operationRegistry = typedRegistry.operations.map(runtimeOperationContract);
  return [
    "// Generated by scripts/generate-op-catalog.mjs. Do not edit by hand.",
    `export const ACTIVITY_LOG_REGISTRY_VERSION = ${String(typedRegistry.schemaVersion)} as const;`,
    `export const ACTIVITY_LOG_SCHEMA_DIGEST = "${typedRegistry.schemaDigest}" as const;`,
    `export const ACTIVITY_LOG_CATALOG_DIGEST = "${typedRegistry.catalogDigest}" as const;`,
    `export const ACTIVITY_LOG_OPERATION_REGISTRY = ${JSON.stringify(operationRegistry, null, 2)} as const;`,
    `export const ACTIVITY_LOG_FAILURE_CLASS_COVERAGE = ${JSON.stringify(typedRegistry.failureClassCoverage, null, 2)} as const;`,
    `export const ACTIVITY_LOG_FAILURE_SURFACES = ${JSON.stringify(ACTIVITY_LOG_FAILURE_SURFACES)} as const;`,
    "export type ActivityLogFailureSurface = (typeof ACTIVITY_LOG_FAILURE_SURFACES)[number];",
    `export const ACTIVITY_LOG_OPERATION_SURFACES: Readonly<Record<string, ActivityLogFailureSurface>> = ${JSON.stringify(activityLogOperationSurfaces(inventory), null, 2)};`,
    "",
  ].join("\n");
}

// Recursively lists `.ts` source files under `dir`, skipping tests (co-located `*.test.ts` and
// any `__tests__` directory) — this generator catalogs instrumentation sites, not the fixtures
// that exercise them.
function walkTsFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir).sort(compareCodepoints)) {
    if (name === "__tests__") continue;
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

// Simple `const UPPER_SNAKE_NAME = "literal";` declarations resolve a repeated literal. Ignore
// quoted prose and reject conflicting or non-literal declarations of the same name instead of
// choosing the last declaration. This remains a conservative source scan, not a binding resolver.
function collectConstStrings(source) {
  const constMap = new Map();
  const conflicting = new Set();
  const code = blankQuotedText(source);
  const pattern = /\b(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\b/g;
  for (const match of code.matchAll(pattern)) {
    const name = match[1];
    const { value, stopChar } = readValueSpan(source, match.index + match[0].length);
    const literal = /^\s*=\s*"([^"\\]*)"\s*$/u.exec(value)?.[1];
    if (!/^const\b/u.test(match[0]) || literal === undefined || stopChar !== ";")
      conflicting.add(name);
    else if (constMap.has(name) && constMap.get(name) !== literal) conflicting.add(name);
    else constMap.set(name, literal);
  }
  for (const name of conflicting) constMap.delete(name);
  return constMap;
}

const OPEN_BRACKETS = new Set(["(", "[", "{"]);
const CLOSE_BRACKETS = new Set([")", "]", "}"]);

function depthDelta(ch) {
  if (OPEN_BRACKETS.has(ch)) return 1;
  if (CLOSE_BRACKETS.has(ch)) return -1;
  return 0;
}

// Advances `depth` by one character, clamped at zero. A stray unmatched closing bracket (e.g. an
// apostrophe misread as a string boundary, or a bracket left over from a scan that started
// mid-expression) must never push depth negative: once negative, depth can drift back up past
// zero without ever landing ON zero again, and every top-level stop after it would be missed.
// Clamping recovers on the very next open bracket instead of staying corrupted for the rest of the
// scan. Split out of `scanBalanced` to keep that function's own branching under this repo's
// complexity ceiling.
function nextDepth(depth, ch) {
  const next = depth + depthDelta(ch);
  return Math.max(0, next);
}

// Scans `source` from `startIndex`, tracking bracket depth and string/template-literal spans (a
// backslash escape inside a string never ends it, and nothing inside a string ever changes
// depth), and returns the index of the first character for which `isStop(ch)` is true while at
// depth 0 outside any string. Shared by every extractor below, each of which only supplies a
// different `isStop` — the bracket/string bookkeeping (the part with real branching) is written
// exactly once, so no caller's own complexity carries it.
function scanBalanced(source, startIndex, isStop) {
  let depth = 0;
  let stringChar = null;
  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (stringChar !== null) {
      if (ch === "\\") i += 1;
      else if (ch === stringChar) stringChar = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      stringChar = ch;
      continue;
    }
    if (depth === 0 && isStop(ch)) return i;
    depth = nextDepth(depth, ch);
  }
  return source.length;
}

// Finalizes the argument list at a call's closing paren: a non-empty last segment is a real
// argument; an empty one is either a genuine zero-argument call (nothing to push) or Prettier's
// trailing comma after the last real argument (already pushed by the comma branch above).
function endArgs(args, source, argStart, closeParenIndex) {
  const last = source.slice(argStart, closeParenIndex);
  if (last.trim().length > 0) args.push(last);
  return { args, endIndex: closeParenIndex };
}

const ARG_STOP = (ch) => ch === "," || ch === ")";

// Splits the arguments of a call whose `(` is at `openParenIndex`, respecting nested
// brackets/parens/braces and string/template literals so a multi-line call (this codebase's
// Prettier formatting breaks almost every helper call across several lines) is not misread as
// more arguments than it has. Returns the raw (untrimmed) argument text for each position.
function splitTopLevelArgs(source, openParenIndex) {
  const args = [];
  const argsStart = openParenIndex + 1;
  let argStart = argsStart;
  let cursor = argsStart;
  while (cursor < source.length) {
    const stopAt = scanBalanced(source, cursor, ARG_STOP);
    if (stopAt >= source.length) return { args, endIndex: source.length };
    if (source[stopAt] === ")") return endArgs(args, source, argStart, stopAt);
    args.push(source.slice(argStart, stopAt));
    argStart = stopAt + 1;
    cursor = argStart;
  }
  return { args, endIndex: source.length };
}

const VALUE_STOP = (ch) => ch === "," || ch === ";" || CLOSE_BRACKETS.has(ch);

// Reads a property/argument value starting at `startIndex`, stopping at the first top-level
// (depth-0) comma, closing brace/paren/bracket, or semicolon — the same bracket-depth scan as
// `splitTopLevelArgs`, but for a value that is not itself inside a call's argument list (an
// object-literal property, or a function parameter's type annotation). Returns the stop character
// alongside the value: `opPropertyEntries` uses it to tell a declaration from a real property (see
// `closesOverDeclaration`).
function readValueSpan(source, startIndex) {
  const stopIndex = scanBalanced(source, startIndex, VALUE_STOP);
  return { value: source.slice(startIndex, stopIndex), stopChar: source[stopIndex] };
}

const SINGLE_LITERAL = /^"([^"\\]*)"$/;
const TERNARY_BRANCHES = /^\s*"([^"\\]*)"\s*:\s*"([^"\\]*)"\s*$/;
const CONST_IDENTIFIER = /^[A-Z][A-Z0-9_]*$/;

// Resolves `condition ? "a" : "b"` — but ONLY when the condition (everything before the FIRST `?`
// in the expression) contains no quoted literal. A quote there means either a nested ternary
// (`flag ? "x" : other ? "y" : "z"`, whose true, only-two-literal branches sit after the SECOND
// `?`) or a condition this generator cannot safely scan for its own top-level `?` (a quoted
// literal can itself contain a `?` character, which would misdirect a plain `indexOf`). Either
// way, guessing which `?` is the real ternary operator risks silently dropping a real literal —
// see the nested-ternary case above, where a naive scan drops `"x"` entirely — so this returns
// `null` (dynamic) instead.
function ternaryOfLiterals(expr) {
  const qIndex = expr.indexOf("?");
  if (qIndex === -1 || expr.slice(0, qIndex).includes('"')) return null;
  const branches = TERNARY_BRANCHES.exec(expr.slice(qIndex + 1));
  return branches ? [branches[1], branches[2]] : null;
}

// Resolves a raw `op` expression (already trimmed) to the literal string(s) it can only ever be:
// a plain string, a ternary between two strings, or a reference to a well-known UPPER_SNAKE_CASE
// constant this generator already collected. Anything else (a member expression, a bare lowercase
// identifier, a function call, a template literal) is honestly dynamic — returns `null`.
function resolveLiteralValues(expr, constMap) {
  const single = SINGLE_LITERAL.exec(expr);
  if (single) return [single[1]];
  const ternary = ternaryOfLiterals(expr);
  if (ternary) return ternary;
  if (CONST_IDENTIFIER.test(expr) && constMap.has(expr)) return [constMap.get(expr)];
  return null;
}

function lineOffsets(source) {
  const offsets = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

// Binary search for the 0-based line number containing `index`, given the offsets `lineOffsets`
// produced.
function lineNumberAt(offsets, index) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low;
}

function leadingWhitespace(line) {
  return /^\s*/.exec(line)[0];
}

// Tested against the TRIMMED line: a trailing `\s*` after `[)\s]*` would give the engine two
// overlapping ways to consume the same spaces, which is super-linear on a long whitespace run.
const CLOSING_BRACE_LINE = /^\}[)\s]*[,;]?$/;
const CATEGORY_LITERAL = /\bcategory\s*:\s*"([^"\\]*)"/;

// True when `line` is (only) a closing brace at shallower indentation than `indent` — the signal
// that the enclosing object literal has already ended, so anything further above it belongs to an
// unrelated statement and is not a candidate sibling.
function isShallowerClosingBrace(line, indent) {
  if (!CLOSING_BRACE_LINE.test(line.trim())) return false;
  return leadingWhitespace(line).length < indent.length;
}

function categoryLiteralIn(line) {
  return CATEGORY_LITERAL.exec(line)?.[1];
}

// Looks upward from `opLine` (inclusive) for a sibling `category: "literal"` — up to 6 lines,
// the object literal's other properties, since Prettier puts one property per line. Stops as
// soon as `isShallowerClosingBrace` says the enclosing object literal has already ended.
function categoryAbove(lines, opLine, opIndent) {
  for (let i = opLine; i >= Math.max(0, opLine - 6); i -= 1) {
    const line = lines[i] ?? "";
    if (i !== opLine && isShallowerClosingBrace(line, opIndent)) break;
    const found = categoryLiteralIn(line);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Rare shape: `category` declared after `op` in the same object literal. Two lines is enough for
// every real occurrence this generator has been checked against.
function categoryBelow(lines, opLine) {
  for (let i = opLine + 1; i <= Math.min(lines.length - 1, opLine + 2); i += 1) {
    const found = categoryLiteralIn(lines[i] ?? "");
    if (found !== undefined) return found;
  }
  return undefined;
}

// Looks for a sibling `category: "literal"` in the same object literal as the `op` on
// `lines[opLine]`, searching above first (the common shape) and then a short window below.
function findSiblingCategory(lines, opLine) {
  const opIndent = leadingWhitespace(lines[opLine] ?? "");
  return categoryAbove(lines, opLine, opIndent) ?? categoryBelow(lines, opLine);
}

// The identifier that ends `text` (ignoring trailing whitespace), found by a backward scan rather
// than an end-anchored regex — `([\w$]*)\s*$` backtracks super-linearly on long lines (Sonar S8786).
function trailingIdentifier(text) {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
  let start = end;
  while (start > 0 && /[\w$]/.test(text[start - 1])) start -= 1;
  if (start === end || /\d/.test(text[start])) return undefined;
  return text.slice(start, end);
}

// Walks backward from `fromIndex` (exclusive) tracking bracket depth, and returns the index of the
// nearest UNMATCHED opening bracket — the bracket that encloses `fromIndex` one level up. Every
// closing bracket seen first increments `depth` (one more matching opener is now owed before we are
// back to the enclosing level); every opening bracket either satisfies one of those or, at depth 0,
// IS the answer. Mirrors `scanBalanced`'s forward depth bookkeeping, run in reverse, so the object
// literal an `op:` property lives in — and, one level further out, the call it is an argument
// to — can be found without a full AST. Like every other extractor in this file, this does not
// track string/template spans on the way back; on this codebase's Prettier-formatted, one-property-
// per-line source that risk is the same one `findSiblingCategory`'s line scan already accepts.
function enclosingOpenBracketIndex(source, fromIndex) {
  let depth = 0;
  for (let i = fromIndex - 1; i >= 0; i -= 1) {
    const ch = source[i];
    if (CLOSE_BRACKETS.has(ch)) {
      depth += 1;
    } else if (OPEN_BRACKETS.has(ch)) {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

// Tier 2.5 (see OBJECT_ARG_CATEGORY_FUNCTIONS' header comment): resolves the category for an
// `op:` property whose enclosing object literal is itself an argument to one of those checked-in
// functions — a shape tiers 1 and 3 cannot see, since the category lives inside the callee's body,
// never near the call site. Finds the object literal's own opening `{` first (must be a `{`, not
// some other enclosing bracket — a `[`/`(` there means `op:` is not sitting in a plain object-
// literal argument), then the call's opening `(` one level further out, then reads the identifier
// immediately before it. Returns undefined — never a guess — the moment any of those structural
// expectations fails, exactly like `fileCategoryBinding`'s own "no single safe answer" contract.
function objectArgCategory(source, colonEnd, relPath) {
  const braceIndex = enclosingOpenBracketIndex(source, colonEnd);
  if (braceIndex === -1 || source[braceIndex] !== "{") return undefined;
  const parenIndex = enclosingOpenBracketIndex(source, braceIndex);
  if (parenIndex === -1 || source[parenIndex] !== "(") return undefined;
  const name = trailingIdentifier(source.slice(0, parenIndex));
  if (name === undefined) return undefined;
  const match = OBJECT_ARG_CATEGORY_FUNCTIONS.find(
    (entry) => entry.name === name && entry.file === relPath,
  );
  return match?.category;
}

// Blanks `//` line comments and `/* … */` block comments in `source` — replaces every comment
// character with a space, character for character, while every OTHER character (including every
// newline, whether inside a comment or not) passes through unchanged. Unlike removing comment
// text outright, blanking preserves `source`'s exact length and every newline's exact offset, so
// `entriesForFile` can compute `lines`/`offsets` once against the blanked text and every extractor
// below sees line numbers that agree with the real file — no separate "raw vs. stripped" offset
// bookkeeping, and no risk of a duplicated or dropped newline shifting later sites (the bug a
// remove-based version of this function had for a `//` comment). Respects string and
// template-literal spans exactly like `scanBalanced`: a comment marker inside a string is not a
// comment, and a commented-out `op: "…"` — a doc-comment example, or this very file's own header —
// can never surface as a catalog entry once every extractor scans the blanked text.
// One step of `blankComments`'s string/template-literal branch: an escape consumes and re-emits
// both characters unchanged (so an escaped quote never ends the string), the matching quote closes
// it, anything else is copied unchanged. String contents are never blanked. Returns the next index
// to resume scanning from.
function stepInsideString(source, index, stringChar, appendChar) {
  const ch = source[index];
  appendChar(ch);
  if (ch === "\\") {
    appendChar(source[index + 1] ?? "");
    return { index: index + 2, stringChar };
  }
  return { index: index + 1, stringChar: ch === stringChar ? null : stringChar };
}

// Appends the blanked form of one source character: itself if it is a newline (so line layout
// stays exact), a single space otherwise.
function appendBlanked(ch, appendChar) {
  appendChar(ch === "\n" ? "\n" : " ");
}

// Blanks a `//` line comment up to (not including) its terminating newline. The dispatch loop in
// `blankComments` copies that newline unchanged on its very next step, so it is emitted exactly
// once — the double-newline this function used to introduce (one appended here, one copied by the
// dispatch loop) is gone because this function no longer appends a newline of its own at all.
function blankLineComment(source, index, appendChar) {
  let i = index;
  while (i < source.length && source[i] !== "\n") {
    appendBlanked(source[i], appendChar);
    i += 1;
  }
  return i;
}

// Blanks a `/* … */` block comment, including its opening and closing markers, one character at a
// time, so the blanked output is exactly as long as the comment it replaces.
function blankBlockComment(source, index, appendChar) {
  appendBlanked(source[index], appendChar);
  appendBlanked(source[index + 1], appendChar);
  let i = index + 2;
  while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
    appendBlanked(source[i], appendChar);
    i += 1;
  }
  appendBlanked(source[i] ?? "", appendChar);
  appendBlanked(source[i + 1] ?? "", appendChar);
  return i + 2;
}

// Blanks every `//` line comment and `/* … */` block comment in `source` (see the header comment
// above for why blanking, not removing). Computed exactly once per file in `entriesForFile`, and
// fed to every extractor — object-literal `op:` properties, positional-helper calls, collected
// constants, and the file-level category binding — so a commented-out `op:` can never become a
// catalog entry anywhere, not only in the one tier that originally guarded against it. Each branch
// is its own function above; this loop only dispatches between them.
function blankComments(source) {
  let out = "";
  const appendChar = (text) => {
    out += text;
  };
  let stringChar = null;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (stringChar !== null) {
      ({ index: i, stringChar } = stepInsideString(source, i, stringChar, appendChar));
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      stringChar = ch;
      appendChar(ch);
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i = blankLineComment(source, i, appendChar);
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = blankBlockComment(source, i, appendChar);
      continue;
    }
    appendChar(ch);
    i += 1;
  }
  return out;
}

const FILE_CATEGORY_LITERAL_PATTERN = /\bcategory\s*:\s*"([^"\\]*)"/g;

// Tier 3 (see the header comment): the ONE category literal a file binds upstream of every `op:`
// call, when — and only when — the whole file (comments excluded) agrees on exactly one distinct
// value. Two or more distinct values, or none, return `undefined`, so the caller leaves those
// entries "unknown" rather than guessing which of several bindings applies to a given call site.
// `source` here is already the blanked text `entriesForFile` computed once for the whole file.
function fileCategoryBinding(source) {
  const distinct = new Set();
  for (const match of source.matchAll(FILE_CATEGORY_LITERAL_PATTERN)) {
    distinct.add(match[1]);
  }
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

// Applies tier 3 to every "unknown" entry `entriesForFile` produced for one file, leaving every
// already-resolved entry (tiers 1 and 2) untouched.
function applyFileCategoryBindingTier(entries, source) {
  const binding = fileCategoryBinding(source);
  if (binding === undefined) return entries;
  return entries.map((entry) =>
    entry.category === "unknown" ? { ...entry, category: binding } : entry,
  );
}

// One extracted site, before the `package` field is attached by the caller.
function siteEntry(op, category, relPath, lineNumber) {
  return { op, category, site: `${relPath}:${lineNumber + 1}` };
}

// True when `stopChar` — the character `readValueSpan` stopped at — structurally rules out an
// object-literal property: a semicolon closes an interface/type-literal member (`readonly op:
// string;`), and a bare `op: Type` sitting directly in a parameter list closes over the enclosing
// `)` with nothing of its own in between — including a nested function-type parameter, e.g. the
// `op` in `(op: () => void) => …`, whose OWN value span ends at the outer `)`, never at a `,` or
// `}` first. An object-literal property never does either: this codebase's "trailing commas
// everywhere" Prettier rule means a non-final property always stops at `,`, and a final one closes
// over `}` (an object literal is always parenthesized or braced before any enclosing `)`).
function closesOverDeclaration(stopChar) {
  return stopChar === ";" || stopChar === ")";
}

const TYPE_LIKE_IDENTIFIER = /^[A-Z]\w*$/;
// A union of two or more quoted string-literal types, e.g. `"pull" | "put"` — TypeScript syntax
// for a parameter's TYPE, never a runtime expression (`"a" | "b"` at runtime is bitwise-OR on two
// strings coerced to `NaN`, which nothing in this codebase writes or would want).
const STRING_LITERAL_UNION = /^"[^"\\]*"(\s*\|\s*"[^"\\]*")+$/;

// True when `value` can only be naming a TypeScript type, never a runtime `op` value: the plain
// annotation text this generator has always recognized, a union of quoted string-literal types, or
// a bare PascalCase identifier that is not one of this file's collected UPPER_SNAKE_CASE constants
// — a type reference such as `OpName` or `LogOp`. A genuine runtime forward always reads a dotted
// expression (`record.operation`, `event.op`) or one of those all-caps constants, never a bare
// PascalCase name, so this never mistakes a real dynamic site for a declaration.
//
// A parenthesized FUNCTION TYPE (`(x: string) => void`) is deliberately NOT classified here, even
// though it also starts with `(`. Its content alone cannot tell a function type apart from a
// runtime arrow-function VALUE — `op: (value: string) => void;` (a type) and `op: (value) =>
// value,` (a real runtime function assigned to an object-literal property) are structurally
// identical past the opening paren: both close their own parens and can be followed by `=>`. Only
// WHERE the value's span stops distinguishes them — `;` for an interface/type-literal member, or
// the enclosing `)` when `op` is a function parameter (including a nested function-type parameter,
// e.g. the `op` in `(op: () => void) => …`, whose OWN span ends at that outer `)`) — never `,` or
// `}`, which is exactly what an object-literal property closes over instead, per this codebase's
// "trailing commas everywhere" Prettier rule. `opPropertyEntries` already carries that exact
// structural signal as `stopChar` and checks it via `closesOverDeclaration` before ever calling
// this function, so gating on content here regardless of `stopChar` previously misclassified a
// real runtime arrow-function `op` value (`op: (value) => value,`) as a type and silently dropped
// the site instead of recording it `<dynamic>` (#2902 PR review, round 3).
function isTypeAnnotationValue(value, constMap) {
  if (value === "string" || value === "string | undefined") return true;
  if (STRING_LITERAL_UNION.test(value)) return true;
  return TYPE_LIKE_IDENTIFIER.test(value) && !constMap.has(value);
}

// Scans one `op:` object-literal property match: skips TypeScript type annotations (`op: string`
// or `op: SomeType` on a function parameter, function-type parameter, or interface/type field),
// otherwise resolves the value and emits one entry per resolved literal, or a single `<dynamic>`
// entry when the value cannot be enumerated.
function opPropertyEntries(source, lines, offsets, constMap, relPath, colonEnd) {
  const { value: rawValue, stopChar } = readValueSpan(source, colonEnd);
  const value = rawValue.trim();
  if (closesOverDeclaration(stopChar) || isTypeAnnotationValue(value, constMap)) return [];
  const opLine = lineNumberAt(offsets, colonEnd);
  const category =
    findSiblingCategory(lines, opLine) ?? objectArgCategory(source, colonEnd, relPath) ?? "unknown";
  const literals = resolveLiteralValues(value, constMap);
  if (literals === null) return [siteEntry("<dynamic>", category, relPath, opLine)];
  return literals.map((literal) => siteEntry(literal, category, relPath, opLine));
}

// Every `op:` object-literal property in `source`. The negative lookbehind — not merely `\b` —
// is required: a plain `\b` treats `-` as a non-word character, so `\bop\s*:` also matches the
// "op:" inside a prose comment's "no-op:" (a real false positive this generator hit against
// `nullKnowledgeLogSink`'s doc comment). Excluding a preceding word character OR hyphen rejects
// that compound word while still matching a standalone `op:` property. Separately, `op?:` (an
// optional interface field, none of which this codebase uses for a required `op`) never matches
// because `\s*` cannot consume the `?`, and the ES6-shorthand `op` (no colon at all) that every
// positional-helper's own `return { ..., op, ... }` uses is excluded because there is no colon —
// both are excluded for free by the pattern, not by an extra check.
function scanObjectLiteralOps(source, lines, offsets, constMap, relPath) {
  const entries = [];
  const pattern = /(?<![\w-])op\s*:\s*/g;
  for (const match of source.matchAll(pattern)) {
    const colonEnd = match.index + match[0].length;
    entries.push(...opPropertyEntries(source, lines, offsets, constMap, relPath, colonEnd));
  }
  return entries;
}

function isFunctionDeclarationSite(source, matchIndex) {
  const before = source.slice(Math.max(0, matchIndex - 12), matchIndex);
  return /function\s*$/.test(before);
}

// One helper call site's entries: reads the literal(s) out of the argument at `helper.argIndex`,
// or a single `<dynamic>` entry when that argument is not enumerable OR not readable at all — a
// missing `args[helper.argIndex]` means `splitTopLevelArgs` could not read this call (end of file,
// or a bracket scan confused by something upstream), not that the call carries no op. Recording it
// as dynamic keeps the site visible instead of silently vanishing from the catalog.
function helperCallEntries(source, offsets, constMap, relPath, helper, matchIndex) {
  const parenIndex = source.indexOf("(", matchIndex + helper.name.length - 1);
  const { args } = splitTopLevelArgs(source, parenIndex);
  const argText = args[helper.argIndex];
  const callLine = lineNumberAt(offsets, matchIndex);
  if (argText === undefined) {
    return [siteEntry("<dynamic>", helper.category, relPath, callLine)];
  }
  const literals = resolveLiteralValues(argText.trim(), constMap);
  if (literals === null) return [siteEntry("<dynamic>", helper.category, relPath, callLine)];
  return literals.map((literal) => siteEntry(literal, helper.category, relPath, callLine));
}

// Every call site of one positional-op helper in `source`: finds `helper.name(`, skips the
// helper's own `function name(` declaration line, and delegates the argument read to
// `helperCallEntries`.
function scanHelperCalls(source, offsets, constMap, relPath, helper) {
  const entries = [];
  const escaped = helper.name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const pattern = new RegExp(String.raw`\b${escaped}\s*\(`, "g");
  for (const match of source.matchAll(pattern)) {
    if (isFunctionDeclarationSite(source, match.index)) continue;
    entries.push(...helperCallEntries(source, offsets, constMap, relPath, helper, match.index));
  }
  return entries;
}

// Call discovery uses blanked quotes, while argument parsing keeps original literals and offsets.
function blankQuotedText(source) {
  let out = "";
  const appendChar = (text) => {
    out += text;
  };
  let stringChar = null;
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (stringChar !== null) {
      const next = stepInsideString(source, index, stringChar, (text) =>
        appendBlanked(text, appendChar),
      );
      index = next.index;
      stringChar = next.stringChar;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      stringChar = ch;
      appendBlanked(ch, appendChar);
      index += 1;
    } else {
      appendChar(ch);
      index += 1;
    }
  }
  return out;
}

function diagnosticArgument(source, parenIndex, argIndex) {
  const { args } = splitTopLevelArgs(source, parenIndex);
  const text = args[argIndex];
  if (text === undefined) return undefined;
  const offset =
    parenIndex + 1 + args.slice(0, argIndex).reduce((sum, value) => sum + value.length + 1, 0);
  const leading = text.length - text.trimStart().length;
  return { text: text.trim(), offset: offset + leading };
}

function objectProperties(source) {
  const properties = [];
  if (!source.startsWith("{") || scanBalanced(source, 1, (ch) => ch === "}") !== source.length - 1)
    return undefined;
  let cursor = 1;
  while (cursor < source.length - 1) {
    const stop = scanBalanced(source, cursor, (ch) => ch === "," || ch === "}");
    const text = source.slice(cursor, stop);
    if (text.trim() !== "") properties.push({ text, offset: cursor });
    cursor = stop + 1;
  }
  return properties;
}

function staticPropertyName(property) {
  const match = /^\s*(?:([A-Za-z_$][\w$]*)|"([^"\\]*)"|'([^'\\]*)')\s*(?::|\(|$)/u.exec(property);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function closedObjectPreservesOperation(expression) {
  const properties = objectProperties(expression.trim());
  return (
    properties?.every(({ text }) => {
      const name = staticPropertyName(text);
      return name !== undefined && name !== "operation";
    }) ?? false
  );
}

// Only inline objects with statically named keys, or a conditional between two such objects,
// prove a trailing spread cannot overwrite the operation. Identifiers and computed keys remain
// dynamic. This covers the existing diagnostic owner's `...(code ? { code } : {})` shape.
function spreadPreservesOperation(property) {
  let expression = property.trim().slice(3).trim();
  if (
    expression.startsWith("(") &&
    scanBalanced(expression, 1, (ch) => ch === ")") === expression.length - 1
  )
    expression = expression.slice(1, -1).trim();
  if (closedObjectPreservesOperation(expression)) return true;
  const question = scanBalanced(expression, 0, (ch) => ch === "?");
  const colon = scanBalanced(expression, question + 1, (ch) => ch === ":");
  return (
    colon < expression.length &&
    closedObjectPreservesOperation(expression.slice(question + 1, colon)) &&
    closedObjectPreservesOperation(expression.slice(colon + 1))
  );
}

function propertyPreservesOperation(property) {
  if (property.trimStart().startsWith("...")) return spreadPreservesOperation(property);
  const name = staticPropertyName(property);
  return name !== undefined && name !== "operation";
}

function diagnosticOperationProperty(argument) {
  const properties = objectProperties(argument.text);
  if (properties === undefined) return undefined;
  let selected;
  for (const property of properties) {
    const match = /^\s*(?:operation|"operation"|'operation')\s*:\s*/u.exec(property.text);
    if (match)
      selected = {
        value: property.text.slice(match[0].length).trim(),
        offset: argument.offset + property.offset + match[0].length,
      };
    else if (!propertyPreservesOperation(property.text)) selected = undefined;
  }
  return selected;
}

function diagnosticCallEntries(source, offsets, constMap, helper, matchIndex, relPath) {
  const parenIndex = source.indexOf("(", matchIndex + helper.name.length);
  const argument = diagnosticArgument(source, parenIndex, helper.argIndex);
  // The nested approved builder supplies the actual operation site; do not count its forwarding call twice.
  if (
    helper.name === "emitServerDiagnostic" &&
    argument?.text.startsWith("serverDiagnosticFromError(")
  )
    return [];
  const property = argument === undefined ? undefined : diagnosticOperationProperty(argument);
  const line = lineNumberAt(offsets, property?.offset ?? matchIndex);
  const literals = property === undefined ? null : resolveLiteralValues(property.value, constMap);
  return [...new Set(literals ?? ["<dynamic>"])].map((op) => ({
    ...siteEntry(op, "diagnostic", relPath, line),
    sourceKind: "diagnostic-operation",
  }));
}

function scanDiagnosticOperations(source, offsets, constMap, relPath) {
  const code = blankQuotedText(source);
  const entries = [];
  for (const helper of DIAGNOSTIC_OBJECT_APIS) {
    if (helper.file !== undefined && helper.file !== relPath) continue;
    const escaped = helper.name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const pattern = new RegExp(String.raw`(?<![\w$.])${escaped}\s*\(`, "g");
    for (const match of code.matchAll(pattern)) {
      if (!isFunctionDeclarationSite(code, match.index))
        entries.push(
          ...diagnosticCallEntries(source, offsets, constMap, helper, match.index, relPath),
        );
    }
  }
  return entries;
}

function validDiagnosticOperation(op) {
  // Reuse the diagnostic owner's exact label/route reduction. No record is emitted here.
  const record = serverDiagnosticFromError({
    correlationId: "op-catalog-fixture",
    operation: op,
    source: "op-catalog",
    error: undefined,
    redact: () => "server-operation-failed",
    now: () => 0,
  });
  return record.operation === op;
}

function applicableHelpers(relPath) {
  return POSITIONAL_OP_HELPERS.filter(
    (helper) => helper.file === undefined || helper.file === relPath,
  );
}

// Every catalog entry contributed by one file: object-literal `op:` properties plus every
// positional-helper call site that applies to this file. Comments are blanked exactly once, here,
// and every extractor below — including the file-level category-binding tier — scans that blanked
// text, so a commented-out `op:` can never become an entry and no extractor sees raw comment text.
// Blanking preserves length and every newline's offset (see `blankComments`), so `lines`/`offsets`
// computed against it are exactly the real file's line numbers.
function entriesForFile(absPath, relPath) {
  const source = blankComments(readFileSync(absPath, "utf8"));
  const lines = source.split("\n");
  const offsets = lineOffsets(source);
  const constMap = collectConstStrings(source);
  const entries = [
    ...scanObjectLiteralOps(source, lines, offsets, constMap, relPath),
    ...scanDiagnosticOperations(source, offsets, constMap, relPath),
    ...applicableHelpers(relPath).flatMap((helper) =>
      scanHelperCalls(source, offsets, constMap, relPath, helper),
    ),
  ];
  return applyFileCategoryBindingTier(entries, source);
}

function compareEntries(left, right) {
  return (
    compareCodepoints(left.package, right.package) ||
    compareCodepoints(left.op, right.op) ||
    compareCodepoints(left.site, right.site)
  );
}

function violationsIn(entries) {
  return entries
    .filter(
      (entry) =>
        entry.op !== "<dynamic>" &&
        !(entry.sourceKind === "diagnostic-operation"
          ? validDiagnosticOperation(entry.op)
          : OP_NAME_PATTERN.test(entry.op)),
    )
    .map((entry) => ({ op: entry.op, package: entry.package, site: entry.site }));
}

// Derives the full op catalog by walking every scanned package root under `repoRoot`. Exported so
// the drift test regenerates the same structure in memory and pins it against the checked-in
// file, and so the CLI entry point below only adds the write-to-disk step.
export function generateOpCatalog(repoRoot = REPO_ROOT) {
  const entries = [];
  for (const root of scannedPackageRoots(repoRoot)) {
    const pkg = packageNameFromRoot(root);
    const absRoot = join(repoRoot, ...root.split("/"));
    for (const absPath of walkTsFiles(absRoot)) {
      const relPath = relative(repoRoot, absPath).replaceAll("\\", "/");
      if (relPath === RUNTIME_REGISTRY_RELATIVE_PATH) continue;
      for (const entry of entriesForFile(absPath, relPath)) {
        entries.push({ ...entry, package: pkg });
      }
    }
  }
  const sorted = entries.toSorted(compareEntries);
  const typedRegistry = generateTypedActivityLogRegistry(repoRoot);
  const dynamicCount = sorted.filter((entry) => entry.op === "<dynamic>").length;
  const unknownCategoryCount = sorted.filter((entry) => entry.category === "unknown").length;
  return {
    $schema: "keiko-activity-log-registry/2",
    generatedBy: "scripts/generate-op-catalog.mjs",
    operationContracts: [TOOL_CATALOG_OPERATIONS_PATH],
    authority: {
      operationSource: "typedRegistry.operations",
      legacyDiscovery: "non-authoritative-migration-input",
    },
    typedRegistry,
    legacyDiscovery: {
      dynamicCount,
      unknownCategoryCount,
      authoritative: false,
    },
    entries: sorted,
    operations: [
      ...new Set(sorted.map((entry) => entry.op).filter((op) => op !== "<dynamic>")),
    ].toSorted(compareCodepoints),
    violations: violationsIn(sorted),
  };
}

// The failure-surface inventory (#3532) is a view over the typed registry this generator derives,
// so it is regenerated and drift-pinned together with the catalog, never maintained by hand.
export function generateActivityLogFailureSurfaceInventory(
  repoRoot = REPO_ROOT,
  typedRegistry = generateTypedActivityLogRegistry(repoRoot),
) {
  return generateFailureSurfaceInventory(repoRoot, typedRegistry);
}

export async function formatGeneratedJson(value) {
  return format(`${JSON.stringify(value, null, 2)}\n`, {
    parser: "json",
    printWidth: 100,
    tabWidth: 2,
  });
}

async function writeGeneratedFiles(catalog, inventory) {
  const operationsBytes = await toolCatalogOperationsBytes(REPO_ROOT);
  const catalogBytes = await formatGeneratedJson(catalog);
  const inventoryBytes = await formatGeneratedJson(inventory);
  const runtimeRegistryBytes = await format(
    runtimeRegistryModule(catalog.typedRegistry, inventory),
    {
      parser: "typescript",
      printWidth: 100,
      tabWidth: 2,
    },
  );
  const outPath = join(REPO_ROOT, ...OUTPUT_RELATIVE_PATH.split("/"));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, catalogBytes, "utf8");
  writeFileSync(
    join(REPO_ROOT, ...FAILURE_SURFACE_INVENTORY_RELATIVE_PATH.split("/")),
    inventoryBytes,
    "utf8",
  );
  writeFileSync(
    join(REPO_ROOT, ...RUNTIME_REGISTRY_RELATIVE_PATH.split("/")),
    runtimeRegistryBytes,
    "utf8",
  );
  writeFileSync(join(REPO_ROOT, TOOL_CATALOG_OPERATIONS_PATH), operationsBytes, "utf8");
}

function reportInventory(inventory) {
  const { summary } = inventory;
  console.log(
    `  failure-surface inventory: ${String(summary.resolvedProofCount)}/${String(summary.proofCount)} ` +
      `proofs and ${String(summary.resolvedScenarioCount)}/${String(summary.scenarioCount)} ` +
      `scenarios resolved, ${String(inventory.violations.length)} violation(s). ` +
      `Wrote ${FAILURE_SURFACE_INVENTORY_RELATIVE_PATH}.`,
  );
  if (inventory.violations.length > 0) {
    console.error(
      `  failure-surface inventory violations: ${JSON.stringify(inventory.violations)}`,
    );
    process.exitCode = 1;
  }
}

async function main() {
  const catalog = generateOpCatalog();
  const inventory = generateActivityLogFailureSurfaceInventory(REPO_ROOT, catalog.typedRegistry);
  await writeGeneratedFiles(catalog, inventory);
  reportInventory(inventory);
  const dynamicCount = catalog.legacyDiscovery.dynamicCount;
  console.log(
    `generate:op-catalog OK — ${catalog.entries.length} legacy entries ` +
      `(${dynamicCount} dynamic, non-authoritative), ` +
      `${catalog.violations.length} operation-name violation(s), ` +
      `${catalog.typedRegistry.violations.length} typed-registry violation(s). ` +
      `Wrote ${OUTPUT_RELATIVE_PATH}.`,
  );
  if (catalog.violations.length > 0) {
    console.log(`  violations: ${JSON.stringify(catalog.violations)}`);
  }
  if (catalog.typedRegistry.violations.length > 0) {
    console.error(
      `  typed registry violations: ${JSON.stringify(catalog.typedRegistry.violations)}`,
    );
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  await main();
}
