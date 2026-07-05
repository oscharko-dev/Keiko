// Deterministic enterprise retrieval-quality gate. This evaluates repository retrieval in
// isolation from model answers: top file, top-k recall, MRR, nDCG@k, line-level evidence, and
// generated/prose decoy leakage over fixed synthetic repositories.

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextEncoder } from "node:util";

import {
  ALL_FIXTURES,
  PASS_THRESHOLDS,
  renderRetrievalEvalQualityGateReport,
  runRetrievalEval,
} from "@oscharko-dev/keiko-local-knowledge";
import { DEFAULT_SEARCH_LIMITS, readExcerpt, searchText } from "@oscharko-dev/keiko-workspace";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUDGET_PATH = resolve(HERE, "check-retrieval-quality.budget.json");
const MEM_ROOT = "/quality";
const FIXED_NOW = () => 1_700_000_000_000;
const EVAL_K = 5;
const LOCAL_KNOWLEDGE_DIMENSIONS = [
  "recall",
  "precision",
  "meanReciprocalRank",
  "ndcg",
  "sourceIsolation",
  "citationQuality",
  "noEvidenceAccuracy",
  "contextBudgetFit",
];

const CASES = [
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

function dcg(binaryRelevance) {
  let score = 0;
  for (let i = 0; i < binaryRelevance.length; i += 1) {
    if (binaryRelevance[i] !== 1) {
      continue;
    }
    score += 1 / Math.log2(i + 2);
  }
  return score;
}

export function ndcgAtK(paths, relevantPaths, k) {
  const relevant = new Set(relevantPaths);
  const actual = paths.slice(0, k).map((path) => (relevant.has(path) ? 1 : 0));
  const ideal = Array.from({ length: Math.min(k, relevantPaths.length) }, () => 1);
  const idealDcg = dcg(ideal);
  return idealDcg === 0 ? 1 : dcg(actual) / idealDcg;
}

export function evaluateQualityBudget(summary, budget) {
  const failures = [];
  if (summary.top1Rate < budget.minTop1Rate) failures.push("top1Rate");
  if (summary.recallAtK < budget.minRecallAtK) failures.push("recallAtK");
  if (summary.mrr < budget.minMrr) failures.push("mrr");
  if (summary.ndcgAtK < budget.minNdcgAtK) failures.push("ndcgAtK");
  if (summary.lineHitRate < budget.minLineHitRate) failures.push("lineHitRate");
  if (summary.generatedLeakCount > budget.maxGeneratedLeakCount)
    failures.push("generatedLeakCount");
  if (summary.failedCases.length > 0) failures.push("caseFailures");
  return { ok: failures.length === 0, failures };
}

// ─── In-memory workspace fixture ─────────────────────────────────────────────

function toAbs(rel) {
  return rel === MEM_ROOT ? MEM_ROOT : `${MEM_ROOT}/${rel}`.replace(/\/+/g, "/");
}

function dirEntry(name, isDirectory) {
  return { name, isDirectory, isFile: !isDirectory, isSymbolicLink: false };
}

function childrenOf(keys, dirAbs) {
  const prefix = dirAbs === MEM_ROOT ? `${MEM_ROOT}/` : `${dirAbs}/`;
  const fileNames = new Set();
  const dirNames = new Set();
  for (const key of keys) {
    const full = toAbs(key);
    if (!full.startsWith(prefix)) {
      continue;
    }
    const rest = full.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      fileNames.add(rest);
    } else {
      dirNames.add(rest.slice(0, slash));
    }
  }
  return [
    ...[...dirNames].map((name) => dirEntry(name, true)),
    ...[...fileNames].map((name) => dirEntry(name, false)),
  ];
}

function buildFixtureFs(files) {
  const keys = Object.keys(files);
  const encoder = new TextEncoder();
  const findKey = (abs) => keys.find((key) => toAbs(key) === abs);
  return {
    readFileUtf8: (abs) => {
      const key = findKey(abs);
      if (key === undefined) throw new Error(`ENOENT: ${abs}`);
      return files[key];
    },
    stat: (abs) => {
      const key = findKey(abs);
      if (key === undefined) {
        return { size: 0, isFile: false, isDirectory: true, isSymbolicLink: false };
      }
      return {
        size: Buffer.byteLength(files[key], "utf8"),
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      };
    },
    readDir: (abs) => childrenOf(keys, abs),
    realPath: (abs) => abs,
    exists: (abs) => findKey(abs) !== undefined || abs === MEM_ROOT,
    readFileBytes: (abs, maxBytes) => {
      const key = findKey(abs);
      if (key === undefined) return Promise.reject(new Error(`ENOENT: ${abs}`));
      const encoded = encoder.encode(files[key]);
      return Promise.resolve(encoded.subarray(0, Math.min(encoded.length, Math.max(0, maxBytes))));
    },
    readFileRange: (abs, startByte, length) => {
      const key = findKey(abs);
      if (key === undefined) return Promise.reject(new Error(`ENOENT: ${abs}`));
      const encoded = encoder.encode(files[key]);
      const start = Math.max(0, startByte);
      return Promise.resolve(encoded.subarray(start, Math.min(encoded.length, start + length)));
    },
  };
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

async function evaluateCase(testCase) {
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
    ndcgAtK: ndcgAtK(paths, testCase.relevantPaths, EVAL_K),
    observedTop: paths[0] ?? "",
    expectedTop: testCase.expectedTop,
    leaked,
  };
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(results) {
  const failedCases = results
    .filter((result) => !result.topHit || !result.lineHit || result.generatedLeakCount > 0)
    .map((result) => result.id);
  return {
    cases: results.length,
    top1Rate: average(results.map((result) => (result.topHit ? 1 : 0))),
    recallAtK: average(results.map((result) => result.recallAtK)),
    mrr: average(results.map((result) => result.mrr)),
    ndcgAtK: average(results.map((result) => result.ndcgAtK)),
    lineHitRate: average(results.map((result) => (result.lineHit ? 1 : 0))),
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

function localKnowledgeFailuresFor(scorecard) {
  const failures = [];
  for (const dimension of LOCAL_KNOWLEDGE_DIMENSIONS) {
    if (scorecard.dimensions[dimension] < PASS_THRESHOLDS[dimension]) failures.push(dimension);
  }
  if (!scorecard.passed && failures.length === 0) failures.push("passed");
  return failures;
}

function summarizeLocalKnowledgeScorecards(scorecards) {
  const failed = scorecards.filter((scorecard) => localKnowledgeFailuresFor(scorecard).length > 0);
  return {
    fixtures: scorecards.length,
    passed: scorecards.length - failed.length,
    failedFixtureIds: failed.map((scorecard) => scorecard.fixtureId),
    recall: average(scorecards.map((scorecard) => scorecard.dimensions.recall)),
    precision: average(scorecards.map((scorecard) => scorecard.dimensions.precision)),
    meanReciprocalRank: average(
      scorecards.map((scorecard) => scorecard.dimensions.meanReciprocalRank),
    ),
    ndcg: average(scorecards.map((scorecard) => scorecard.dimensions.ndcg)),
    sourceIsolation: average(scorecards.map((scorecard) => scorecard.dimensions.sourceIsolation)),
    noEvidenceAccuracy: average(
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

async function runLocalKnowledgeQualityCheck(log) {
  const scorecards = [];
  for (const fixture of ALL_FIXTURES) {
    scorecards.push(await runRetrievalEval(fixture));
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
  const failed = scorecards.filter((scorecard) => localKnowledgeFailuresFor(scorecard).length > 0);
  for (const scorecard of failed) {
    log(`local-knowledge-retrieval-quality failure: ${formatLocalKnowledgeFailure(scorecard)}`);
  }
  return { summary, scorecards, ok: failed.length === 0 };
}

export async function runRetrievalQualityCheck({
  budgetPath = DEFAULT_BUDGET_PATH,
  log,
  fail,
} = {}) {
  const onLog = log ?? ((message) => console.log(message));
  const onFail =
    fail ??
    ((message) => {
      console.error(`retrieval-quality check failed: ${message}`);
      process.exit(1);
    });
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  const results = [];
  for (const testCase of CASES) {
    results.push(await evaluateCase(testCase));
  }
  const summary = summarize(results);
  const budgetResult = evaluateQualityBudget(summary, budget);
  onLog(
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
    onLog(`retrieval-quality failure: ${formatCaseFailure(result)}`);
  }
  const localKnowledge = await runLocalKnowledgeQualityCheck(onLog);
  const failureMessages = [];
  if (!localKnowledge.ok) {
    failureMessages.push(
      `local knowledge quality failed: ${localKnowledge.summary.failedFixtureIds.join(", ")}`,
    );
  }
  if (!budgetResult.ok) {
    failureMessages.push(`quality budget failed: ${budgetResult.failures.join(", ")}`);
  }
  if (failureMessages.length > 0) {
    onFail(failureMessages.join("; "));
  }
  return { summary, results, budgetResult, localKnowledge };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runRetrievalQualityCheck();
}
