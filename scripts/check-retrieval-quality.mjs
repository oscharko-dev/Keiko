// Deterministic enterprise retrieval-quality gate. This evaluates repository retrieval in
// isolation from model answers: top file, top-k recall, MRR, nDCG@k, line-level evidence, and
// generated/prose decoy leakage over fixed synthetic repositories.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LocalKnowledgeEval,
  binaryNdcgAtK,
  evaluateFloors,
  mean,
  runRegressionProbes,
} from "@oscharko-dev/keiko-evaluations";
import { DEFAULT_SEARCH_LIMITS, readExcerpt, searchText } from "@oscharko-dev/keiko-workspace";
import { runConnectedRetrievalEval } from "../packages/keiko-server/dist/grounded-eval-support.js";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";

const {
  ALL_FIXTURES,
  PASS_THRESHOLDS,
  RETRIEVAL_REGRESSION_PROBE_FIXTURE_IDS,
  computeRetrievalModeComparison,
  hasRetrievalGroundTruth,
  renderRetrievalModeComparisonReport,
  renderRetrievalEvalQualityGateReport,
  runBadOutputRetrievalProbe,
  runRetrievalEval,
} = LocalKnowledgeEval;

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUDGET_PATH = resolve(HERE, "check-retrieval-quality.budget.json");
const MEM_ROOT = "/quality";
const FIXED_NOW = () => 1_700_000_000_000;
const EVAL_K = 5;
export const INCIDENT_FEATURE_PATH = "src/form/busObj/feature/feature-conditions/validation.ts";
export const INCIDENT_TEST_PATH = "src/form/busObj/feature/feature-conditions/validation.test.ts";
const INCIDENT_ASSERTION_LINE = "    expect(validateFeature({ approved: false })).toBe(true);";
const INCIDENT_TEST_CONTENT = [
  'import { describe, expect, it } from "vitest";',
  'import { validateFeature } from "./validation.js";',
  "",
  'describe("feature conditions", () => {',
  '  it("accepts the required feature conditions", () => {',
  ...Array.from({ length: 20 }, (_, index) => `    // Synthetic setup line ${String(index + 1)}.`),
  INCIDENT_ASSERTION_LINE,
  "  });",
  "});",
].join("\n");

export const INCIDENT_RETRIEVAL_FILES = {
  ".git/HEAD": "ref: refs/heads/fixture\n",
  "README.md": "This repository contains form schema validation and required feature conditions.\n",
  "package.json":
    '{"name":"nested-feature-validation","scripts":{"test":"vitest"},"devDependencies":{"vitest":"1.0.0"}}\n',
  "src/form/factories/field-date/validation.ts":
    'export const dateSchema = { required: true, type: "date" };\n',
  "src/form/factories/field-numeric/validation.ts":
    'export const numericSchema = { required: true, type: "number" };\n',
  "src/form/factories/field-binary-choice/validation.ts":
    'export const binarySchema = { required: true, type: "boolean" };\n',
  "src/form/busObj/feature/feature-conditions/schema.ts":
    "export const schema = { featureCode: { required: true } };\n",
  "src/form/busObj/feature/feature-conditions/config.ts":
    'export const config = { feature: "conditions" };\n',
  [INCIDENT_FEATURE_PATH]: [
    'import { schema } from "./schema.js";',
    'import { config } from "./config.js";',
    'import { dateSchema } from "../../../factories/field-date/validation.js";',
    'import { numericSchema } from "../../../factories/field-numeric/validation.js";',
    'import { binarySchema } from "../../../factories/field-binary-choice/validation.js";',
    "export function featureConditionsSchema() {",
    "  return { ...schema, featureCode: { required: true }, approved: { required: true, ...binarySchema }, dateSchema, numericSchema, config };",
    "}",
    "export function validateFeature(value) { return value.approved === true; }",
  ].join("\n"),
  [INCIDENT_TEST_PATH]: INCIDENT_TEST_CONTENT,
  "src/form/busObj/other/other-conditions/validation.ts":
    'export function otherConditionsSchema() { return { required: true, schema: "other", validation: "other" }; }\n',
  "docs/validation-guide.md":
    "Validation requires required fields and schema checks. Feature conditions validation guide.\n" +
    "Synthetic unrelated background material.\n".repeat(4000),
  "node_modules/@vitest/runner/dist/chunk-hooks.js": "function runValidation() { return false; }\n",
  "dist/validation.js": "function featureConditionsSchema() { return { required: true }; }\n",
};

const INCIDENT_HISTORY = [
  {
    role: "assistant",
    content: `I need the content of ${INCIDENT_FEATURE_PATH} to check the required feature conditions.`,
  },
];

function incidentCase(id, query, options = {}) {
  return {
    id,
    category: "incident-retrieval-miss",
    query,
    files: INCIDENT_RETRIEVAL_FILES,
    expectedTop: INCIDENT_FEATURE_PATH,
    relevantPaths: [INCIDENT_FEATURE_PATH],
    expectedLinePattern: /required:/u,
    forbiddenPaths: ["node_modules/@vitest/runner/dist/chunk-hooks.js", "dist/validation.js"],
    ...options,
  };
}

function incidentTrace(prefix) {
  return `${prefix}\nAssertionError: expected false to be true // Object.is equality\nExpected: true\nActual: false\n    at <anonymous> (${INCIDENT_TEST_PATH}:26:5)\n    at runTest (node_modules/@vitest/runner/dist/chunk-hooks.js:1729:8)\n    at runSuite (node_modules/@vitest/runner/dist/chunk-hooks.js:1800:5)`;
}

export const INCIDENT_RETRIEVAL_CASES = [
  incidentCase(
    "explicit-relative-path-en",
    `Which fields are required in ${INCIDENT_FEATURE_PATH}?`,
  ),
  incidentCase(
    "explicit-relative-path-de",
    `Welche Felder sind in ${INCIDENT_FEATURE_PATH} erforderlich?`,
  ),
  incidentCase(
    "bare-basename-collision-en",
    "In validation.ts of the feature conditions, which fields are required?",
  ),
  incidentCase(
    "bare-basename-collision-de",
    "Welche Felder sind in validation.ts der feature conditions erforderlich?",
  ),
  incidentCase(
    "vitest-stack-trace-node-modules-en",
    incidentTrace("Why does this assertion fail?"),
    {
      expectedTop: INCIDENT_TEST_PATH,
      relevantPaths: [INCIDENT_TEST_PATH, INCIDENT_FEATURE_PATH],
      expectedLinePattern: /expect\(validateFeature.*toBe\(true\)/u,
    },
  ),
  incidentCase(
    "vitest-stack-trace-node-modules-de",
    incidentTrace("Warum schlägt diese Assertion fehl?"),
    {
      expectedTop: INCIDENT_TEST_PATH,
      relevantPaths: [INCIDENT_TEST_PATH, INCIDENT_FEATURE_PATH],
      expectedLinePattern: /expect\(validateFeature.*toBe\(true\)/u,
    },
  ),
  incidentCase("path-only-in-previous-assistant-answer-en", "can you see the file now?", {
    history: INCIDENT_HISTORY,
  }),
  incidentCase("path-only-in-previous-assistant-answer-de", "siehst du die Datei jetzt?", {
    history: INCIDENT_HISTORY,
  }),
  incidentCase(
    "conversational-orientation-follow-up-en",
    "What do you see as a knowledge source? You should see all the code and find the file yourself.",
    { history: INCIDENT_HISTORY },
  ),
  incidentCase(
    "conversational-orientation-follow-up-de",
    "Was siehst du als Wissensquelle? Du solltest den gesamten Code sehen und dir die Datei selbst suchen können.",
    { history: INCIDENT_HISTORY },
  ),
  incidentCase(
    "floor-outlier-explicit-file-en",
    `Where is required ValidationPolicy in ${INCIDENT_FEATURE_PATH}?`,
    {
      files: {
        ...INCIDENT_RETRIEVAL_FILES,
        "src/aaa/policy.ts": "export function ValidationPolicy() { return { required: true }; }\n",
      },
    },
  ),
  incidentCase(
    "floor-outlier-explicit-file-de",
    `Wo ist required ValidationPolicy in ${INCIDENT_FEATURE_PATH}?`,
    {
      files: {
        ...INCIDENT_RETRIEVAL_FILES,
        "src/aaa/policy.ts": "export function ValidationPolicy() { return { required: true }; }\n",
      },
    },
  ),
  incidentCase(
    "generated-and-node-modules-ignored",
    `Which required fields does ${INCIDENT_FEATURE_PATH} define?`,
  ),
];

export const WORKSPACE_QUALITY_CASES = [
  {
    id: "java-maven-version-declaration",
    category: "project-metadata",
    intent: "project-metadata",
    query: "Which Java version does the payments service use?",
    files: {
      "README.md": "Historically this service used Java 8.\n",
      "services/payments/pom.xml":
        "<project>\n  <properties>\n    <maven.compiler.release>21</maven.compiler.release>\n  </properties>\n</project>\n",
      "services/gateway/go.mod": "module acme/gateway\n\ngo 1.22\n",
    },
    expectedTop: "services/payments/pom.xml",
    relevantPaths: ["services/payments/pom.xml"],
    expectedLinePattern: /maven\.compiler\.release.*21/iu,
  },
  {
    id: "go-toolchain-declaration",
    category: "project-metadata",
    intent: "project-metadata",
    query: "Which Go version and toolchain does the gateway module require?",
    files: {
      "README.md": "The gateway was originally built with Go 1.18.\n",
      "services/gateway/go.mod": "module acme/gateway\n\ngo 1.23.0\n\ntoolchain go1.23.2\n",
      "services/payments/pom.xml": "<project />\n",
    },
    expectedTop: "services/gateway/go.mod",
    relevantPaths: ["services/gateway/go.mod"],
    expectedLinePattern: /^(go|toolchain)\s/imu,
  },
  {
    id: "node-engines-over-docs",
    category: "project-metadata",
    intent: "project-metadata",
    query: "Which Node version and package manager does the frontend use?",
    files: {
      "apps/web/README.md": "Developers used Node 18 in the old setup.\n",
      "apps/web/package.json":
        '{\n  "engines": { "node": ">=22" },\n  "packageManager": "pnpm@10.9.8"\n}\n',
      "apps/admin/package.json": '{ "engines": { "node": ">=20" } }\n',
    },
    expectedTop: "apps/web/package.json",
    relevantPaths: ["apps/web/package.json"],
    expectedLinePattern: /engines|packageManager/u,
  },
  {
    id: "api-route-express",
    category: "api-route",
    intent: "targeted-code-search",
    query: "Which file implements the POST /api/payments/:id/refund route?",
    files: {
      "README.md": "The POST /api/payments/:id/refund route refunds a payment.\n",
      "src/http/routes.ts":
        'router.post("/api/payments/:id/refund", async (req, res) => refundPayment(req, res));\n',
      "tests/http/routes.test.ts": "it('POST refund route returns 200', () => {});\n",
    },
    expectedTop: "src/http/routes.ts",
    relevantPaths: ["src/http/routes.ts"],
    expectedLinePattern: /router\.post.*\/api\/payments\/:id\/refund/iu,
  },
  {
    id: "api-route-spring",
    category: "api-route",
    intent: "targeted-code-search",
    query: "Which Java controller handles POST /api/cards/{id}/freeze?",
    files: {
      "docs/cards.md": "POST /api/cards/{id}/freeze freezes a card.\n",
      "src/main/java/com/acme/CardController.java":
        '@PostMapping("/api/cards/{id}/freeze")\npublic FreezeResponse freezeCard() { return service.freeze(); }\n',
      "src/test/java/com/acme/CardControllerTest.java": "class CardControllerTest {}\n",
    },
    expectedTop: "src/main/java/com/acme/CardController.java",
    relevantPaths: ["src/main/java/com/acme/CardController.java"],
    expectedLinePattern: /PostMapping.*\/api\/cards\/\{id\}\/freeze/u,
  },
  {
    id: "test-name-to-source",
    category: "test-to-source",
    intent: "targeted-code-search",
    query: "Where is the source implementation for PaymentServiceTest?",
    files: {
      "src/payments/PaymentService.ts":
        "export class PaymentService {\n  authorize(): boolean { return true; }\n}\n",
      "tests/payments/PaymentService.test.ts":
        'describe("PaymentServiceTest", () => it("covers authorize", () => {}));\n',
      "docs/payment-service.md": "PaymentServiceTest verifies the old payment flow.\n",
    },
    expectedTop: "src/payments/PaymentService.ts",
    relevantPaths: ["src/payments/PaymentService.ts"],
    expectedLinePattern: /class\s+PaymentService/iu,
  },
  {
    id: "same-candidates-api-client",
    category: "query-aware-ranking",
    intent: "targeted-code-search",
    query: "Where is ApiClient timeout handling implemented?",
    files: {
      "docs/auth-debugging.md": "ApiClient and TokenValidator are both part of auth debugging.\n",
      "src/auth/ApiClient.ts":
        "export class ApiClient {\n  timeoutMs = 5000;\n  handleTimeout(): void {}\n}\n",
      "src/auth/TokenValidator.ts":
        "export class TokenValidator {\n  rejectExpiredJwt(): boolean { return true; }\n}\n",
    },
    expectedTop: "src/auth/ApiClient.ts",
    relevantPaths: ["src/auth/ApiClient.ts"],
    expectedLinePattern: /ApiClient|timeout/iu,
  },
  {
    id: "same-candidates-token-validator",
    category: "query-aware-ranking",
    intent: "targeted-code-search",
    query: "Where does TokenValidator reject expired JWTs?",
    files: {
      "docs/auth-debugging.md": "ApiClient and TokenValidator are both part of auth debugging.\n",
      "src/auth/ApiClient.ts":
        "export class ApiClient {\n  timeoutMs = 5000;\n  handleTimeout(): void {}\n}\n",
      "src/auth/TokenValidator.ts":
        "export class TokenValidator {\n  rejectExpiredJwt(): boolean { return true; }\n}\n",
    },
    expectedTop: "src/auth/TokenValidator.ts",
    relevantPaths: ["src/auth/TokenValidator.ts"],
    expectedLinePattern: /TokenValidator|rejectExpiredJwt/iu,
  },
  {
    id: "short-identifier-api-id-url",
    category: "query-aware-ranking",
    intent: "targeted-code-search",
    query: "Which API id url constant is defined in source?",
    files: {
      "docs/api.md": "The API id url constant is discussed in this document.\n",
      "src/http/ApiIdUrlMapper.ts":
        'export const API_ID_URL = "/api/id";\nexport function mapApiIdUrl(): string { return API_ID_URL; }\n',
    },
    expectedTop: "src/http/ApiIdUrlMapper.ts",
    relevantPaths: ["src/http/ApiIdUrlMapper.ts"],
    expectedLinePattern: /API_ID_URL|mapApiIdUrl/u,
  },
  {
    id: "stacktrace-source-location",
    category: "diagnostic-search",
    intent: "diagnostic-search",
    query: "TypeError: boom at src/payments/AuthService.ts:42:13 in validateToken",
    files: {
      "src/payments/AuthService.ts":
        "export class AuthService {\n  validateToken(): void { throw new Error('boom'); }\n}\n",
      "docs/errors.md": "Auth failures can mention validateToken in prose.\n",
    },
    expectedTop: "src/payments/AuthService.ts",
    relevantPaths: ["src/payments/AuthService.ts"],
    expectedLinePattern: /AuthService|validateToken/u,
  },
  {
    id: "config-key-owner",
    category: "config-search",
    intent: "targeted-code-search",
    query: "Where is FEATURE_PAYMENTS_V2 configured?",
    files: {
      "README.md": "FEATURE_PAYMENTS_V2 is enabled in staging.\n",
      "config/features.yaml": "FEATURE_PAYMENTS_V2: true\nFEATURE_LEGACY_CHECKOUT: false\n",
      "src/config.ts": "export const featureConfigPath = 'config/features.yaml';\n",
    },
    expectedTop: "config/features.yaml",
    relevantPaths: ["config/features.yaml"],
    expectedLinePattern: /FEATURE_PAYMENTS_V2/u,
  },
  {
    id: "generated-artifact-avoidance",
    category: "generated-avoidance",
    intent: "targeted-code-search",
    query: "Where is the Service version field defined?",
    files: {
      ".git": "gitdir: fixture-metadata\n",
      "src/main/java/com/acme/Service.java":
        "package com.acme;\nclass Service { String version; }\n",
      "target/classes/com/acme/Service.class": "version version version\n",
      "build/generated/Stub.java": "version version\n",
      "api/user.pb.go": "// generated\npackage api\nvar version = 1\n",
    },
    expectedTop: "src/main/java/com/acme/Service.java",
    relevantPaths: ["src/main/java/com/acme/Service.java"],
    forbiddenPaths: [
      "target/classes/com/acme/Service.class",
      "build/generated/Stub.java",
      "api/user.pb.go",
    ],
  },
  {
    id: "ordinary-generated-directory-text",
    category: "ordinary-folder",
    intent: "targeted-code-search",
    query: "Which manual documents OrdinaryManualProbe?",
    files: {
      "build/manual.html": "<p>OrdinaryManualProbe: maintenance every 750 hours.</p>\n",
      "dist/manual.html": "<p>OrdinaryManualProbe: service pressure 12 bar.</p>\n",
    },
    expectedTop: "build/manual.html",
    relevantPaths: ["build/manual.html", "dist/manual.html"],
    expectedLinePattern: /OrdinaryManualProbe/u,
  },
  {
    id: "terraform-version-declaration",
    category: "project-metadata",
    intent: "project-metadata",
    query: "Which Terraform version does this infrastructure require?",
    files: {
      "README.md": "Terraform 0.12 appears in old bootstrap docs.\n",
      "infra/versions.tf":
        'terraform {\n  required_version = ">= 1.9.0"\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 5.0" }\n  }\n}\n',
    },
    expectedTop: "infra/versions.tf",
    relevantPaths: ["infra/versions.tf"],
    expectedLinePattern: /required_version/iu,
  },
  {
    id: "openapi-version-declaration",
    category: "project-metadata",
    intent: "project-metadata",
    query: "Which OpenAPI version does the customer API spec use?",
    files: {
      "docs/api.md": "The old API was Swagger 2.0.\n",
      "api/openapi.yaml": "openapi: 3.1.0\ninfo:\n  title: Customer API\n  version: 1.0.0\n",
    },
    expectedTop: "api/openapi.yaml",
    relevantPaths: ["api/openapi.yaml"],
    expectedLinePattern: /^openapi\s*:/imu,
  },
  {
    id: "graphql-codegen-schema",
    category: "project-metadata",
    intent: "project-metadata",
    query: "Where is the GraphQL codegen schema configured?",
    files: {
      "README.md": "GraphQL schema files live in docs.\n",
      "codegen.yml":
        "schema: ./schema.graphql\ngenerates:\n  src/generated.ts:\n    plugins:\n      - typescript\n",
      "src/generated.ts": "// generated output\n",
    },
    expectedTop: "codegen.yml",
    relevantPaths: ["codegen.yml"],
    expectedLinePattern: /^schema\s*:/imu,
  },
  ...INCIDENT_RETRIEVAL_CASES,
];

// ─── Pure metrics ─────────────────────────────────────────────────────────────

export function uniquePathsInOrder(paths) {
  const seen = new Set();
  const out = [];
  for (const path of paths) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    out.push(path);
  }
  return out;
}

export function reciprocalRank(paths, relevantPaths) {
  const relevant = new Set(relevantPaths);
  const index = paths.findIndex((path) => relevant.has(path));
  return index < 0 ? 0 : 1 / (index + 1);
}

export function recallAtK(paths, relevantPaths, k) {
  if (relevantPaths.length === 0) {
    return 1;
  }
  const top = new Set(paths.slice(0, k));
  const hits = relevantPaths.filter((path) => top.has(path)).length;
  return hits / relevantPaths.length;
}

export function evaluateQualityBudget(summary, budget) {
  const minimumResult = evaluateFloors(summary, {
    top1Rate: budget.minTop1Rate,
    recallAtK: budget.minRecallAtK,
    mrr: budget.minMrr,
    ndcgAtK: budget.minNdcgAtK,
    lineHitRate: budget.minLineHitRate,
  });
  const failures = [...minimumResult.failures];
  if (
    !Number.isFinite(summary.generatedLeakCount) ||
    !Number.isFinite(budget.maxGeneratedLeakCount) ||
    summary.generatedLeakCount > budget.maxGeneratedLeakCount
  )
    failures.push("generatedLeakCount");
  if (summary.failedCases.length > 0) failures.push("caseFailures");
  return { ok: failures.length === 0, failures };
}

// ─── In-memory workspace fixture ─────────────────────────────────────────────
// Delegates to the package's own sanctioned in-memory `WorkspaceFs` double. It is the ONE
// implementation of the port's bounded-read semantics (`readFileUtf8SameDescriptor`, the stat
// snapshot fields it reconfirms against, the hard-link policy and the "too-large"/"changed"
// `WorkspaceDescriptorReadError` reasons) that tracks `fs.ts` whenever the port moves, so this
// gate exercises the real contract instead of a local restatement that can silently drift from it.

function buildFixtureFs(files) {
  return memFs(MEM_ROOT, files);
}

function buildScope() {
  return {
    workspace: {
      root: MEM_ROOT,
      name: "enterprise-retrieval-quality",
      version: "0.0.0",
      testFramework: "unknown",
      sourceDirs: ["src", "services"],
      testDirs: ["tests"],
      languages: ["typescript", "javascript", "java", "go"],
      ignoreLines: [],
    },
    scopeId: "quality",
    relativePaths: [],
  };
}

async function lineHitForCase(testCase, scope, fs, atoms) {
  if (testCase.expectedLinePattern === undefined) {
    return true;
  }
  const matchingAtoms = atoms.filter((atom) => atom.scopePath === testCase.expectedTop);
  if (matchingAtoms.length === 0) {
    return false;
  }
  const best = matchingAtoms.reduce((winner, atom) => (atom.score > winner.score ? atom : winner));
  if (best.lineRange === undefined) {
    return false;
  }
  const excerpt = await readExcerpt(
    scope,
    {
      scopePath: testCase.expectedTop,
      startLine: best.lineRange.startLine,
      endLine: best.lineRange.endLine,
      maxBytes: 2048,
    },
    { fs, nowMs: FIXED_NOW },
  );
  return testCase.expectedLinePattern.test(excerpt.content);
}

export async function evaluateCase(testCase) {
  if (testCase.category === "incident-retrieval-miss") return evaluateIncidentCase(testCase);
  const fs = buildFixtureFs(testCase.files);
  const scope = buildScope();
  const query = {
    kind: "natural-language",
    text: testCase.query,
    caseSensitive: false,
    maxResults: 100,
    emittedAtMs: 0,
  };
  const result = await searchText(scope, query, DEFAULT_SEARCH_LIMITS, {
    fs,
    nowMs: FIXED_NOW,
    searchHints: { retrievalIntent: testCase.intent },
  });
  const paths = uniquePathsInOrder(result.atoms.map((atom) => atom.scopePath));
  const forbidden = testCase.forbiddenPaths ?? [];
  const leaked = forbidden.filter((path) => paths.includes(path));
  const lineHit = await lineHitForCase(testCase, scope, fs, result.atoms);
  const topHit = paths[0] === testCase.expectedTop;
  return {
    id: testCase.id,
    category: testCase.category,
    topHit,
    lineHit,
    generatedLeakCount: leaked.length,
    recallAtK: recallAtK(paths, testCase.relevantPaths, EVAL_K),
    mrr: reciprocalRank(paths, testCase.relevantPaths),
    ndcgAtK: binaryNdcgAtK(paths, testCase.relevantPaths, EVAL_K),
    observedTop: paths[0] ?? "",
    expectedTop: testCase.expectedTop,
    leaked,
  };
}

async function evaluateIncidentCase(testCase) {
  let pack;
  try {
    ({ pack } = await runConnectedRetrievalEval(testCase));
  } catch (error) {
    if (error.name !== "ClarificationNeededError") throw error;
    return incidentResult(testCase, [], false);
  }
  const paths = pack.files.map((file) => file.scopePath);
  const lineHit =
    pack.files
      .find((file) => file.scopePath === testCase.expectedTop)
      ?.excerpts.some((excerpt) => testCase.expectedLinePattern?.test(excerpt.content) ?? true) ??
    false;
  return incidentResult(testCase, paths, lineHit);
}

function incidentResult(testCase, paths, lineHit) {
  const leaked = (testCase.forbiddenPaths ?? []).filter((path) => paths.includes(path));
  return {
    id: testCase.id,
    category: testCase.category,
    topHit: paths[0] === testCase.expectedTop,
    lineHit,
    generatedLeakCount: leaked.length,
    recallAtK: recallAtK(paths, testCase.relevantPaths, EVAL_K),
    mrr: reciprocalRank(paths, testCase.relevantPaths),
    ndcgAtK: binaryNdcgAtK(paths, testCase.relevantPaths, EVAL_K),
    observedTop: paths[0] ?? "",
    expectedTop: testCase.expectedTop,
    leaked,
  };
}

function summarize(results) {
  const failedCases = results
    .filter((result) => !result.topHit || !result.lineHit || result.generatedLeakCount > 0)
    .map((result) => result.id);
  return {
    cases: results.length,
    top1Rate: mean(results.map((result) => (result.topHit ? 1 : 0))),
    recallAtK: mean(results.map((result) => result.recallAtK)),
    mrr: mean(results.map((result) => result.mrr)),
    ndcgAtK: mean(results.map((result) => result.ndcgAtK)),
    lineHitRate: mean(results.map((result) => (result.lineHit ? 1 : 0))),
    generatedLeakCount: results.reduce((sum, result) => sum + result.generatedLeakCount, 0),
    failedCases,
  };
}

function formatPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatCaseFailure(result) {
  const parts = [];
  if (!result.topHit)
    parts.push(`top=${result.observedTop || "<none>"} expected=${result.expectedTop}`);
  if (!result.lineHit) parts.push("line-hit=false");
  if (result.generatedLeakCount > 0) parts.push(`leaked=${result.leaked.join(",")}`);
  return `${result.id}: ${parts.join("; ")}`;
}

async function runWorkspaceQualityCheck(workspaceCases, budgetPath, log) {
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  const results = [];
  for (const testCase of workspaceCases) {
    results.push(await evaluateCase(testCase));
  }
  const summary = summarize(results);
  const budgetResult = evaluateQualityBudget(summary, budget);
  log(
    `retrieval-quality: cases=${String(summary.cases)} top1=${formatPct(
      summary.top1Rate,
    )} recall@${String(EVAL_K)}=${formatPct(summary.recallAtK)} mrr=${summary.mrr.toFixed(
      3,
    )} ndcg@${String(EVAL_K)}=${summary.ndcgAtK.toFixed(3)} line-hit=${formatPct(
      summary.lineHitRate,
    )} generated-leaks=${String(summary.generatedLeakCount)}.`,
  );
  const failed = results.filter(
    (result) => !result.topHit || !result.lineHit || result.generatedLeakCount > 0,
  );
  for (const result of failed) {
    log(`retrieval-quality failure: ${formatCaseFailure(result)}`);
  }
  return { summary, results, budgetResult };
}

function localKnowledgeFailuresFor(scorecard) {
  const failures = [...evaluateFloors(scorecard.dimensions, PASS_THRESHOLDS).failures];
  if (!scorecard.passed && failures.length === 0) failures.push("passed");
  return failures;
}

function summarizeLocalKnowledgeScorecards(scorecards) {
  const failed = scorecards.filter((scorecard) => localKnowledgeFailuresFor(scorecard).length > 0);
  return {
    fixtures: scorecards.length,
    passed: scorecards.length - failed.length,
    failedFixtureIds: failed.map((scorecard) => scorecard.fixtureId),
    recall: mean(scorecards.map((scorecard) => scorecard.dimensions.recall)),
    precision: mean(scorecards.map((scorecard) => scorecard.dimensions.precision)),
    meanReciprocalRank: mean(
      scorecards.map((scorecard) => scorecard.dimensions.meanReciprocalRank),
    ),
    ndcg: mean(scorecards.map((scorecard) => scorecard.dimensions.ndcg)),
    sourceIsolation: mean(scorecards.map((scorecard) => scorecard.dimensions.sourceIsolation)),
    noEvidenceAccuracy: mean(
      scorecards.map((scorecard) => scorecard.dimensions.noEvidenceAccuracy),
    ),
  };
}

function formatLocalKnowledgeFailure(scorecard) {
  const failures = localKnowledgeFailuresFor(scorecard);
  return `${scorecard.fixtureId}: failed=${failures.join(",")} recall=${scorecard.dimensions.recall.toFixed(
    3,
  )} precision=${scorecard.dimensions.precision.toFixed(
    3,
  )} mrr=${scorecard.dimensions.meanReciprocalRank.toFixed(
    3,
  )} ndcg=${scorecard.dimensions.ndcg.toFixed(3)}`;
}

function comparisonFailuresFor(comparison) {
  return comparison.rows.filter((row) => !row.passed || row.floorHeadroom < 0);
}

function formatComparisonFailure(row) {
  return `${row.mode}: fixtures=${row.fixtureIds.join(",")} floor-headroom=${row.floorHeadroom.toFixed(
    3,
  )} hybrid-queries=${String(row.hybridQueryCount)}`;
}

export async function runLocalKnowledgeQualityCheck(
  log,
  fixtures = ALL_FIXTURES,
  runner = runRetrievalEval,
) {
  const scorecards = [];
  for (const fixture of fixtures) {
    scorecards.push(await runner(fixture));
  }
  const summary = summarizeLocalKnowledgeScorecards(scorecards);
  log(
    `local-knowledge-retrieval-quality: fixtures=${String(summary.fixtures)} passed=${String(
      summary.passed,
    )} recall=${summary.recall.toFixed(3)} precision=${summary.precision.toFixed(
      3,
    )} mrr=${summary.meanReciprocalRank.toFixed(3)} ndcg=${summary.ndcg.toFixed(
      3,
    )} isolation=${summary.sourceIsolation.toFixed(
      3,
    )} no-evidence=${summary.noEvidenceAccuracy.toFixed(3)}.`,
  );
  for (const line of renderRetrievalEvalQualityGateReport(scorecards).split("\n")) {
    log(`local-knowledge-retrieval-quality report: ${line}`);
  }
  const comparison = computeRetrievalModeComparison(scorecards);
  for (const line of renderRetrievalModeComparisonReport(comparison).split("\n")) {
    log(`local-knowledge-retrieval-comparison report: ${line}`);
  }
  const failed = scorecards.filter((scorecard) => localKnowledgeFailuresFor(scorecard).length > 0);
  for (const scorecard of failed) {
    log(`local-knowledge-retrieval-quality failure: ${formatLocalKnowledgeFailure(scorecard)}`);
  }
  const failedComparisonRows = comparisonFailuresFor(comparison);
  for (const row of failedComparisonRows) {
    log(`local-knowledge-retrieval-comparison failure: ${formatComparisonFailure(row)}`);
  }
  return {
    summary,
    scorecards,
    comparison,
    ok: failed.length === 0 && failedComparisonRows.length === 0,
  };
}

// ─── Non-tautology regression probes ─────────────────────────────────────────
// A scorecard gate that only ever runs passing fixtures cannot prove it would catch a real
// regression. Mirroring the injected-regression proof in `check-grounded-retrieval-quality.mjs`,
// we preserve each probe's gold expectations and replace the real retriever's references with a
// genuinely bad empty output immediately before scoring. If that output still clears the floors,
// the Local Knowledge quality gate is tautological and fails closed.

export const REGRESSION_PROBE_FIXTURE_IDS = RETRIEVAL_REGRESSION_PROBE_FIXTURE_IDS;

export async function runLocalKnowledgeRegressionProbes(
  log,
  fixtures = ALL_FIXTURES,
  runner = runBadOutputRetrievalProbe,
  probeFixtureIds = REGRESSION_PROBE_FIXTURE_IDS,
) {
  const result = await runRegressionProbes({
    fixtures,
    probeFixtureIds,
    fixtureId: (fixture) => fixture.id,
    regressFixture: (fixture) => (hasRetrievalGroundTruth(fixture) ? fixture : undefined),
    runFixture: runner,
    droppedBelowFloors: (card) => localKnowledgeFailuresFor(card).length > 0,
    observe: ({ fixtureId, droppedBelowFloors }) =>
      log(
        `local-knowledge-retrieval-regression: probe=${fixtureId} expected=below-floors observed=${
          droppedBelowFloors ? "below-floors" : "PASSED"
        }`,
      ),
  });
  if (result.probed === 0) {
    log(
      `local-knowledge-retrieval-regression: no probe fixtures matched ${probeFixtureIds.join(", ")}`,
    );
  }
  if (result.unresolved.length > 0) {
    log(
      `local-knowledge-retrieval-regression: unresolved probe fixture ids: ${result.unresolved.join(", ")}`,
    );
  }
  return result;
}

function regressionFailureMessage(regression) {
  if (regression.ok) return undefined;
  const unresolved = regression.unresolved ?? [];
  if (unresolved.length > 0) {
    return `local knowledge regression probe ids did not resolve to a fixture: ${unresolved.join(", ")}`;
  }
  return regression.probed === 0
    ? "local knowledge regression probes did not run (no probe fixtures matched)"
    : `local knowledge regression probes were tautological: ${regression.tautological.join(", ")}`;
}

function collectQualityFailures(localKnowledge, regression, budgetResult) {
  const messages = [];
  if (!localKnowledge.ok) {
    messages.push(
      `local knowledge quality failed: ${localKnowledge.summary.failedFixtureIds.join(", ")}`,
    );
  }
  const regressionFailure = regressionFailureMessage(regression);
  if (regressionFailure !== undefined) messages.push(regressionFailure);
  if (!budgetResult.ok) {
    messages.push(`quality budget failed: ${budgetResult.failures.join(", ")}`);
  }
  return messages;
}

export async function runRetrievalQualityCheck({
  budgetPath = DEFAULT_BUDGET_PATH,
  log,
  fail,
  localKnowledgeQualityCheck = runLocalKnowledgeQualityCheck,
  regressionProbes = runLocalKnowledgeRegressionProbes,
  workspaceCases = WORKSPACE_QUALITY_CASES,
} = {}) {
  const onLog = log ?? ((message) => console.log(message));
  const onFail =
    fail ??
    ((message) => {
      console.error(`retrieval-quality check failed: ${message}`);
      process.exit(1);
    });
  const { summary, results, budgetResult } = await runWorkspaceQualityCheck(
    workspaceCases,
    budgetPath,
    onLog,
  );
  const localKnowledge = await localKnowledgeQualityCheck(onLog);
  const regression = await regressionProbes(onLog);
  const failureMessages = collectQualityFailures(localKnowledge, regression, budgetResult);
  if (failureMessages.length > 0) {
    onFail(failureMessages.join("; "));
  }
  return { summary, results, budgetResult, localKnowledge, regression };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runRetrievalQualityCheck();
}
