#!/usr/bin/env node
// RB-6 release gate (GEN-OBS-DIAGNOSTICS-901, CORRELATION-103/402/601) — Server error observability.
//
// Drives the REAL built artifacts (packages/*/dist) across a STRATIFIED SAMPLE of >=10 distinct
// emitServerDiagnostic / structural-log-port call sites, one per package/lane this epic touched:
//
//   1. server.top-level-catch          — keiko-server, the request-entry catch (unchanged, full HTTP
//                                         round trip: opaque 500, header echo, no-leak, UI-id honoured)
//   2. sink.terminal-event-tee         — keiko-server, the harness/workflow terminal-event tee (sink.ts)
//   3. memory-handlers.handleGetMemory — keiko-server, a memory-handlers route catch
//   4. memory-handlers.handleMemoryReviewQueue — keiko-server, a second, differently-shaped memory-handlers catch
//   5. memory-handlers.handlePinMemory — keiko-server, a third memory-handlers catch
//   6. voice-realtime.negotiation-failure — keiko-server, the voice control-plane negotiation failure
//   7. memory-maintenance-handlers.resolveMemoryRetentionPolicy — keiko-server, an env-driven catch
//   8. memory-maintenance-handlers.resolveMaintenanceAutonomyMode — keiko-server, a store-driven catch
//   9. memory-consolidation.log-port.sink-failed — keiko-memory-consolidation's own structural log port
//  10. memory-consolidation.summary-fallback — keiko-memory-consolidation's runConsolidation fallback path
//  11. security.macos-keychain.fallback — keiko-security's own structural log port
//  12. quality-intelligence.capsule-store-open — keiko-server, the QI capsule resolver's store-open
//                                         catch, which swallowed the failure before #3532
//
// Before this widening the gate forced exactly ONE synchronous throw through the top-level server.ts
// catch and asserted against exactly one produced record — real coverage of the other ~100
// emitServerDiagnostic/structural-log-port call sites across the repo was zero. Each site below is
// exercised by calling the REAL production function (imported from its built dist, or its public
// package export) with a fault injected at the narrowest possible seam, then asserting the SHAPE of
// the diagnostic/log record it produces (operation/op, category/source, errorClass, and any
// site-specific fields) — not merely that "some emit call happened".
//
// It goes RED against the pre-RB-6 defect (site 1: a bare `.catch(() => { ... })` that discards the
// error and emits an id-less 500) and against a bare `catch {}`/dropped-diagnostic regression at any
// of sites 2-11 (each fails closed with `records.length !== 1` or a shape mismatch, never a silent
// pass). This is the standalone, workflow-wired counterpart to the in-suite regression tests
// (server.test.ts / chat-stream-handlers.test.ts / memory-handlers.test.ts / voice-realtime.test.ts /
// sink.test.ts / consolidate.test.ts / log-port.test.ts, one per site above).

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { resolveHostExecutable } from "./lib/host-executable.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const serverEntry = resolve(here, "../packages/keiko-server/dist/index.js");

const SECRET_MARKER = "gate-secret-DO-NOT-LEAK";
const ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const HOST = "127.0.0.1";
const REPO_ROOT = resolve(here, "..");
const GIT_EXECUTABLE = resolveHostExecutable("git", { workspaceRoot: REPO_ROOT });

export const SERVER_TOP_LEVEL_SITE_ID = "server.top-level-catch";
export const MIN_STRATIFIED_SITES = 10;

function fail(message) {
  console.error(`check:error-observability FAIL — ${message}`);
  process.exit(1);
}

// Throws (never exits the process) so both `main()`'s CLI failure path and a vitest assertion can
// use the same shape checks — `fail()` is reserved for `main()`'s own top-level orchestration.
function check(condition, message) {
  if (!condition) throw new Error(message);
}

function propertyNameText(name) {
  return ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
    ? name.text
    : name.getText();
}

function isClassMember(node) {
  return (
    (ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isPropertyDeclaration(node)) &&
    ts.isClassLike(node.parent)
  );
}

// Class members get their own owner, `Class.member`, so two catches in different methods of one
// class never share a key: the base-versus-head diff counts findings per owner, and a shared key
// would let a new silent catch in one method hide behind a fixed one in another.
function classMemberName(member) {
  const className = member.parent.name?.text ?? "<class>";
  if (ts.isConstructorDeclaration(member)) return `${className}.constructor`;
  const memberName = propertyNameText(member.name);
  if (ts.isGetAccessorDeclaration(member)) return `${className}.get ${memberName}`;
  if (ts.isSetAccessorDeclaration(member)) return `${className}.set ${memberName}`;
  return `${className}.${memberName}`;
}

function functionOwnerName(node) {
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) return node.name.text;
  if (isClassMember(node) && !ts.isPropertyDeclaration(node)) return classMemberName(node);
  if (!ts.isFunctionExpression(node) && !ts.isArrowFunction(node)) return undefined;
  const holder = node.parent;
  if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return holder.name.text;
  return isClassMember(holder) ? classMemberName(holder) : undefined;
}

function catchFunctionName(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    const owner = functionOwnerName(current);
    if (owner !== undefined) return owner;
  }
  return "<anonymous>";
}

// Exact, reviewed clean-up boundaries only. A naming convention is not authority to discard a
// failure: every exception must identify one source file and one function, with its reason kept
// beside the gate. Additions are review-visible and cannot accidentally exempt a same-named catch
// elsewhere.
const REVIEWED_FAILURE_PATH_EXEMPTIONS = new Map([
  [
    "packages/keiko-cli/src/support-analyze.ts:registeredRecordClassification",
    "The catch deterministically classifies hostile persisted evidence as incomplete or corrupt.",
  ],
  [
    "packages/keiko-cli/src/support.ts:supportPublicationErrorKind",
    "The catch bounds a hostile error-property read to the closed unknown failure kind.",
  ],
  [
    "packages/keiko-cli/src/support.ts:supportPublicationFailure",
    "The catch returns a closed publication failure consumed by the registered publication event.",
  ],
  [
    "packages/keiko-cli/src/support.ts:publishSupportBundle",
    "The catch returns a typed failed outcome consumed by the registered publication event.",
  ],
  [
    "packages/keiko-cli/src/support.ts:recoverSupportBundle",
    "The catch returns a typed recovery failure consumed by the registered publication event.",
  ],
  [
    "packages/keiko-cli/src/support.ts:acknowledgeSupportPublication",
    "The catch returns a closed acknowledgement failure consumed by the registered publication event.",
  ],
  [
    "packages/keiko-cli/src/support.ts:collectFreshSupportData",
    "Activity Log construction itself failed; the CLI reports the unavailable capability and stops.",
  ],
  [
    "packages/keiko-cli/src/support.ts:persistSupportAnalysisEvidence",
    "Activity Log construction itself failed; the CLI reports the unavailable capability and stops.",
  ],
  [
    "packages/keiko-cli/src/support-export.ts:logSkipKind",
    "A no-follow lstat probe classifies a skipped log file; the manifest attests its name and kind.",
  ],
  [
    "packages/keiko-cli/src/ui.ts:safeCliErrorKind",
    "The catch bounds a hostile error classifier to the closed unknown kind before durable logging.",
  ],
  [
    "packages/keiko-cli/src/ui.ts:runShutdownHook",
    "The caught hook failure returns as its closed kind, which the process.exiting line records.",
  ],
  [
    "packages/keiko-server/src/observability/activity-log-readiness.ts:activityLogCatalogCoherent",
    "A formatter rejection becomes the closed catalog-mismatch reason the readiness line persists.",
  ],
  [
    "packages/keiko-server/src/observability/server-logger.ts:isMandatoryActivityLogEvent",
    "A hostile registration accessor makes the event ordinary instead of failing the emitting call.",
  ],
  [
    "packages/keiko-contracts/src/observability.ts:registrationMatchesCanonical",
    "The contract boundary converts hostile proxy access into a registration mismatch rejection.",
  ],
  [
    "packages/keiko-contracts/src/observability.ts:activityLogEvent",
    "A validation failure becomes the rejection sentinel the sink drops with one bounded notice.",
  ],
  [
    "packages/keiko-model-gateway/src/http.ts:logEndpointClass",
    "The logging reducer drops an invalid endpoint instead of retaining raw URL content.",
  ],
  [
    "packages/keiko-security/src/fs-hardening.ts:closeDescriptorIgnoringErrors",
    "Best-effort close after the primary filesystem result is already fixed.",
  ],
  [
    "packages/keiko-security/src/fs-hardening.ts:directoryGuardStillMatches",
    "A failed identity read is the fail-closed false result of this trust-boundary predicate.",
  ],
  [
    "packages/keiko-security/src/fs-hardening.ts:closeDirectoryGuards",
    "Individual close failures are aggregated and propagated as one closed safe-file error.",
  ],
  [
    "packages/keiko-security/src/fs-hardening.ts:samePathNode",
    "A failed identity read is the fail-closed false result of this trust-boundary predicate.",
  ],
  [
    "packages/keiko-security/src/fs-hardening.ts:linkedArchiveMatches",
    "A failed identity read is the fail-closed false result of this trust-boundary predicate.",
  ],
  [
    "packages/keiko-security/src/fs-hardening.ts:movedArchiveMatches",
    "A failed identity read is the fail-closed false result of this trust-boundary predicate.",
  ],
  [
    "packages/keiko-security/src/fs-hardening.ts:pathHasIdentity",
    "A failed identity read is the fail-closed false result of this trust-boundary predicate.",
  ],
  [
    "packages/keiko-security/src/fs-hardening.ts:directoryGuardStillOwnerOnly",
    "A failed identity read is the fail-closed false result of this trust-boundary predicate.",
  ],
  [
    "packages/keiko-security/src/fs-hardening.ts:processIsAlive",
    "The catch maps the closed ESRCH result while conservatively treating unknown failures as alive.",
  ],
  [
    "packages/keiko-security/src/fs-hardening.ts:releasePublicationOwnerAfterFailure",
    "Best-effort rollback after the owning publication failure is already emitted and propagated.",
  ],
  [
    "packages/keiko-security/src/safe-artifact-directory-mutation-runtime.ts:parseExpectedIdentity",
    "Invalid untrusted integer input is rejected by the helper protocol before mutation.",
  ],
  [
    "packages/keiko-security/src/safe-artifact-directory-mutation-runtime.ts:runSafeArtifactDirectoryMutation",
    "The isolated helper maps mutation failure to a closed process exit code returned to its owner.",
  ],
  [
    "packages/keiko-security/src/safe-artifact-directory-mutation.ts:directoryMatches",
    "A failed identity read is the fail-closed false result of this isolated helper predicate.",
  ],
  [
    "packages/keiko-security/src/safe-artifact-directory-mutation.ts:entryMatches",
    "A failed identity read refuses the unlink as an entry mismatch in this isolated helper.",
  ],
  [
    "packages/keiko-security/src/safe-artifact-directory-mutation.ts:readRequest",
    "Malformed helper-protocol input is rejected before any filesystem mutation.",
  ],
  [
    "packages/keiko-security/src/secret-vault.ts:safeErrorProperty",
    "A hostile error accessor is reduced to absent data before the registered failure event.",
  ],
  [
    "packages/keiko-server/src/grounded-orchestrator.ts:connectedContextFailureKind",
    "A hostile error classifier is reduced to the closed unknown kind before the failure event.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:safeArtifactErrorKind",
    "A hostile prototype trap is reduced to absent data inside the last-resort log sink.",
  ],
  // #3530 segmented Activity Log store: fail-closed probes, and failure outcomes that a registered
  // storage event persists.
  [
    "packages/keiko-server/src/observability/activity-log-store.ts:regularFileStat",
    "A vanished or unreadable entry is classified as absent from the Activity Log listing.",
  ],
  [
    "packages/keiko-server/src/observability/activity-log-store.ts:readPinRecord",
    "An unreadable pin record protects nothing; the caller removes it and persists pin.expired invalid-record.",
  ],
  [
    "packages/keiko-server/src/observability/activity-log-store.ts:processIsAlive",
    "The catch maps the closed ESRCH result while conservatively treating unknown failures as alive.",
  ],
  [
    "packages/keiko-server/src/observability/activity-log-store.ts:lastCompleteLineOp",
    "An unparsable tail line is classified as carrying no seal line.",
  ],
  [
    "packages/keiko-server/src/observability/activity-log-store.ts:lineSeq",
    "An unparsable line is classified as carrying no sequence number.",
  ],
  [
    "packages/keiko-server/src/observability/activity-log-store.ts:activityLogSegmentSeqSpan",
    "An unreadable span is reported as unknown in the registered quota-exhaustion marker.",
  ],
  [
    "packages/keiko-server/src/observability/activity-log-store.ts:activityLogFreeBytes",
    "Free space that cannot be measured is reported as absent, never as plenty.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:activeLogKey",
    "A directory that cannot be resolved is keyed by its lexical path; opening it still fails closed.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:closeQuietly",
    "Best-effort close of a descriptor the writer has already stopped using.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:currentSegmentSize",
    "A failed identity read makes the caller treat the segment as mutated and fail closed.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:sharesInode",
    "A failed identity read is the fail-closed false result of this trust-boundary predicate.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:pathMissing",
    "The catch classifies the closed ENOENT result of an existence probe.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:readSealedTail",
    "An unreadable tail is persisted as tailState unknown in the registered recovery event.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:finishInterruptedSeal",
    "The catch returns a failed recovery outcome the registered segment.recovered event persists.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:settleOrphanDescriptor",
    "Best-effort fsync and read-only mode on a recovered segment; the sealing rename still decides.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:recoverOrphanedSegment",
    "The catch returns a failed recovery outcome the registered segment.recovered event persists.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:removePinRecordQuietly",
    "A failed removal is persisted by the registered pin.expired event and retried after a backoff.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:listingOrUndefined",
    "An unlistable directory becomes a storage-unavailable outcome the registered pin events persist.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:tightenLegacyFile",
    "A legacy file that cannot be narrowed stays in place; the retention event persists the failure.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:removeRetentionTarget",
    "A failed deletion is persisted by the registered retention event and retried after a backoff.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:withdrawSegment",
    "A segment left in place is this process's abandoned segment; maintenance seals it with evidence.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:restrictSealedMode",
    "Best-effort read-only mode after a successful seal; the segment stays owner-private.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:descriptorAtPath",
    "A failed identity read is the fail-closed false result of this trust-boundary predicate.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:persistPostWriteMutation",
    "The mutation evidence stays queued; the caller reports the event whose location is unknown.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:createPin",
    "The catch returns the closed storage-unavailable rejection the registered pin.created event persists.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:ownedDirectory",
    "A failed ownership read is the fail-closed false result of this trust-boundary predicate.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:batchIsWritable",
    "An unformattable batch is deferred to its caller before any line is written.",
  ],
  [
    "packages/keiko-server/src/observability/server-log.ts:syncActiveSegment",
    "A failed fsync is returned as the closed durability-uncertain deferral of the batch.",
  ],
]);

function isReviewedFailurePath(path, owner) {
  return REVIEWED_FAILURE_PATH_EXEMPTIONS.has(`${path}:${owner}`);
}

function hasRawConsoleCall(node) {
  let found = false;
  const visit = (child) => {
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      ts.isIdentifier(child.expression.expression) &&
      child.expression.expression.text === "console"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node.block);
  return found;
}

const EVIDENCE_METHOD_NAMES = new Set(["emit", "error", "info", "record", "warn", "write"]);

function evidenceReceiverName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function isEvidenceCall(node) {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) {
    const name = node.expression.text;
    return (
      name === "activityLogEvent" ||
      name === "writeStderrNotice" ||
      /^(?:emit|log|record|report)[A-Z_]/u.test(name)
    );
  }
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const method = node.expression.name.text;
  const receiver = evidenceReceiverName(node.expression.expression);
  return (
    receiver !== undefined &&
    EVIDENCE_METHOD_NAMES.has(method) &&
    /(?:^(?:log|logger|sink|diagnostic|diagnostics)$|(?:Log|Logger|Sink|Diagnostic|Diagnostics)$)/u.test(
      receiver,
    )
  );
}

function hasEvidenceOrPropagation(node) {
  let found = false;
  const visit = (child) => {
    if (ts.isThrowStatement(child) || isEvidenceCall(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node.block);
  return found;
}

function failurePathFinding(sourceFile, node, path) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const owner = catchFunctionName(node);
  if (hasRawConsoleCall(node)) return { path, line, owner, kind: "raw-console-catch" };
  if (!hasEvidenceOrPropagation(node) && !isReviewedFailurePath(path, owner)) {
    return { path, line, owner, kind: "unregistered-catch" };
  }
  return undefined;
}

export function unregisteredFailurePathViolations(source, path = "fixture.ts") {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const findings = [];
  const visit = (node) => {
    if (ts.isCatchClause(node)) {
      const finding = failurePathFinding(sourceFile, node, path);
      if (finding !== undefined) findings.push(finding);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function findingSignature(finding) {
  return `${finding.kind}:${finding.owner}`;
}

// Findings in the head revision of one file that its base revision did not already have.
export function newFailurePathFindings(baseSource, headSource, path) {
  const baseCounts = Map.groupBy(
    unregisteredFailurePathViolations(baseSource, path),
    findingSignature,
  );
  return unregisteredFailurePathViolations(headSource, path).filter((finding) => {
    const signature = findingSignature(finding);
    const matches = baseCounts.get(signature);
    if (matches === undefined || matches.length === 0) return true;
    matches.pop();
    return false;
  });
}

function gitText(args, cwd = REPO_ROOT) {
  return execFileSync(GIT_EXECUTABLE, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function resolveGateBaseCommit(repoRoot) {
  const configured = process.env.GITHUB_BASE_REF;
  const candidates = [
    ...(configured === undefined ? [] : [`origin/${configured}`, configured]),
    "origin/dev",
    "dev",
  ];
  for (const candidate of candidates) {
    try {
      return gitText(["rev-parse", "--verify", `${candidate}^{commit}`], repoRoot).trim();
    } catch {
      // Try the next deterministic local spelling of the PR base.
    }
  }
  throw new Error("error-observability-base-ref-unavailable");
}

function changedProductionTypeScriptFiles(repoRoot, baseCommit) {
  return gitText(
    ["diff", "--name-only", "--diff-filter=ACMR", baseCommit, "--", "packages"],
    repoRoot,
  )
    .split("\n")
    .filter(
      (path) =>
        path.endsWith(".ts") &&
        !path.endsWith(".d.ts") &&
        !path.endsWith(".test.ts") &&
        !path.includes("/__tests__/"),
    );
}

function baseFileSource(repoRoot, baseCommit, path) {
  try {
    return gitText(["show", `${baseCommit}:${path}`], repoRoot);
  } catch {
    return "";
  }
}

export function unregisteredFailurePathDiffViolations(repoRoot = REPO_ROOT) {
  const baseCommit = resolveGateBaseCommit(repoRoot);
  return changedProductionTypeScriptFiles(repoRoot, baseCommit).flatMap((path) => {
    const headSource = readFileSync(resolve(repoRoot, path), "utf8");
    return newFailurePathFindings(baseFileSource(repoRoot, baseCommit, path), headSource, path);
  });
}

function distPath(pkg, file) {
  return resolve(here, "..", "packages", pkg, "dist", file);
}

function rawGet(port, path, headers = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      { host: HOST, port, path, method: "GET", headers: { host: `${HOST}:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function loadServerModule() {
  let mod;
  try {
    mod = await import(serverEntry);
  } catch (error) {
    fail(
      `could not import built server at ${serverEntry} — run \`npm run build\` first (${String(error)})`,
    );
  }
  const required = [
    "createUiServer",
    "buildRedactor",
    "createInMemoryUiStore",
    "createRunRegistry",
    "buildCspHeader",
  ];
  for (const name of required) {
    if (typeof mod[name] !== "function") fail(`built server does not export ${name}`);
  }
  return mod;
}

function throwingDeps(mod, records) {
  const store = mod.createInMemoryUiStore();
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: mod.buildRedactor({}),
    diagnostics: { record: (r) => records.push(r) },
    registry: mod.createRunRegistry(),
    modelPortFactory: () => undefined,
    store: {
      ...store,
      listProjects: () => {
        throw Object.assign(new Error(SECRET_MARKER), {
          code: "OBSERVABILITY_GATE_FAILURE",
          requestId: "observability-gateway-request-7",
          partialUsage: { promptTokens: 13, completionTokens: 5 },
        });
      },
    },
  };
}

// Two-phase bind so the Host/Origin allow-check validates against the real listening port.
async function startServer(mod, records) {
  const probe = mod.createUiServer({ staticRoot: here, csp: mod.buildCspHeader([]), port: 0 });
  const port = await new Promise((res) => {
    probe.listen(0, HOST, () => res(probe.address().port));
  });
  await new Promise((res) => probe.close(res));
  const server = mod.createUiServer({
    staticRoot: here,
    csp: mod.buildCspHeader([]),
    port,
    handlerDeps: throwingDeps(mod, records),
  });
  await new Promise((res) => server.listen(port, HOST, res));
  return { server, port };
}

function parse500Body(res) {
  if (res.status !== 500) fail(`expected 500 on handler throw, got ${res.status}`);
  try {
    return JSON.parse(res.body);
  } catch {
    return fail(`500 body is not JSON: ${res.body.slice(0, 200)}`);
  }
}

function assertNoLeak(res) {
  const headerBlob = Object.entries(res.headers)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(",") : v}`)
    .join("\n");
  if (res.body.includes(SECRET_MARKER) || headerBlob.includes(SECRET_MARKER)) {
    fail("raw cause leaked into the client-visible response");
  }
}

function assertOpaque500WithId(res) {
  const parsed = parse500Body(res);
  const cid = parsed?.error?.correlationId;
  if (typeof cid !== "string" || !ID_PATTERN.test(cid)) {
    fail(`500 body carries no well-formed error.correlationId (got ${JSON.stringify(cid)})`);
  }
  if (parsed.error.code !== "INTERNAL")
    fail(`expected error.code INTERNAL, got ${parsed.error.code}`);
  if (res.headers["x-keiko-correlation-id"] !== cid) {
    fail(`X-Keiko-Correlation-Id (${res.headers["x-keiko-correlation-id"]}) != body id (${cid})`);
  }
  assertNoLeak(res);
  return cid;
}

function assertDiagnosticIdentity(record, cid) {
  if (record.correlationId !== cid)
    fail("diagnostic record correlationId does not match the 500 id");
  if (record.source !== "server.top-level-catch")
    fail(`unexpected diagnostic source ${record.source}`);
  if (record.operation !== "server.request") fail(`unexpected operation ${record.operation}`);
  if (record.errorClass !== "Error") fail(`unexpected errorClass ${record.errorClass}`);
}

function assertDiagnosticMachineMetadata(record) {
  if (record.message !== "server-operation-failed")
    fail(`unexpected body-free summary ${record.message}`);
  if (record.code !== "OBSERVABILITY_GATE_FAILURE")
    fail(`machine error code was not retained (${record.code})`);
  if (record.gatewayRequestId !== "observability-gateway-request-7")
    fail(`gateway request id was not retained (${record.gatewayRequestId})`);
  if (record.partialUsage?.promptTokens !== 13 || record.partialUsage?.completionTokens !== 5)
    fail("partial usage counts were not retained");
}

function assertDiagnosticCaptured(records, cid) {
  if (records.length !== 1) fail(`expected exactly 1 diagnostic record, got ${records.length}`);
  const [record] = records;
  assertDiagnosticIdentity(record, cid);
  assertDiagnosticMachineMetadata(record);
  if (JSON.stringify(record).includes(SECRET_MARKER))
    fail("raw cause leaked into the operator diagnostic record");
}

async function assertClientIdHonoured(port) {
  const clientId = "gate-ui-req-0123456789";
  const echoed = await rawGet(port, "/api/projects", { "x-keiko-correlation-id": clientId });
  const parsed = JSON.parse(echoed.body);
  if (
    echoed.headers["x-keiko-correlation-id"] !== clientId ||
    parsed.error.correlationId !== clientId
  ) {
    fail("a well-formed UI-supplied correlation id was not honoured end to end");
  }
}

// ─── Site probes 2-11: narrow, direct fault-injection against the real built dist ────────────────
//
// Each probe imports the REAL production module (never a fixture that restates its logic), injects
// a fault at the narrowest seam that reaches the site's own `emitServerDiagnostic`/log-port call,
// and returns the record(s) it produced. `assertShape` then checks the site-specific fields a
// regression at that exact call site would break. A bare `catch {}` regression at any site makes
// `run()` return zero records, which `runProbe` below turns into a hard gate failure.

function makeSinkTerminalTeeProbe() {
  const runId = `gate-sink-run-${randomUUID()}`;
  return {
    id: "sink.terminal-event-tee",
    async run() {
      const mod = await import(distPath("keiko-server", "sink.js"));
      const records = [];
      const sink = new mod.QueueEventSink({ diagnostics: { record: (r) => records.push(r) } });
      sink.emit({
        schemaVersion: "1",
        runId,
        fingerprint: "gate-fingerprint",
        seq: 1,
        ts: Date.now(),
        type: "run:failed",
      });
      return records;
    },
    assertShape(record) {
      check(
        record.correlationId === runId,
        `sink tee correlationId mismatch: ${record.correlationId}`,
      );
      check(record.operation === "harness.run.failed", `sink tee operation: ${record.operation}`);
      check(record.source === "sink.terminal-event", `sink tee source: ${record.source}`);
      check(record.errorClass === "HarnessRunFailed", `sink tee errorClass: ${record.errorClass}`);
      check(
        typeof record.message === "string" && record.message.length > 0,
        "sink tee message missing",
      );
    },
  };
}

async function loadVaultModule() {
  return import("@oscharko-dev/keiko-memory-vault");
}

function makeMemoryHandlerVaultProbe(id, operation, source, throwingVault) {
  return {
    id,
    async run() {
      const mod = await import(distPath("keiko-server", "memory-handlers.js"));
      const vaultMod = await loadVaultModule();
      const records = [];
      const vault = throwingVault(vaultMod);
      const deps = {
        memoryVault: vault,
        diagnostics: { record: (r) => records.push(r) },
        redactor: (value) => value,
      };
      const ctx = { params: { id: "gate-memory-id" } };
      const result = mod[operation.handlerName](ctx, deps);
      check(result.status === 500, `${id} expected 500, got ${result.status}`);
      return records;
    },
    assertShape(record) {
      check(record.operation === operation.label, `${id} operation: ${record.operation}`);
      check(record.source === source, `${id} source: ${record.source}`);
      check(record.errorClass === "MemoryStorageError", `${id} errorClass: ${record.errorClass}`);
      check(
        typeof record.correlationId === "string" && record.correlationId.length > 0,
        `${id} correlationId missing`,
      );
    },
  };
}

function makeMemoryGetProbe() {
  return makeMemoryHandlerVaultProbe(
    "memory-handlers.handleGetMemory",
    { handlerName: "handleGetMemory", label: "memory.get" },
    "memory-handlers.handleGetMemory",
    (vaultMod) => ({
      getMemory() {
        throw new vaultMod.MemoryStorageError("internal", "gate-vault-get-failure");
      },
    }),
  );
}

function makeMemoryReviewQueueProbe() {
  return makeMemoryHandlerVaultProbe(
    "memory-handlers.handleMemoryReviewQueue",
    { handlerName: "handleMemoryReviewQueue", label: "memory.review-queue" },
    "memory-handlers.handleMemoryReviewQueue",
    (vaultMod) => ({
      listMemoryScopes() {
        throw new vaultMod.MemoryStorageError("internal", "gate-vault-scopes-failure");
      },
    }),
  );
}

function makeMemoryPinProbe() {
  return makeMemoryHandlerVaultProbe(
    "memory-handlers.handlePinMemory",
    { handlerName: "handlePinMemory", label: "memory.pin" },
    "memory-handlers.handlePinMemory",
    (vaultMod) => ({
      getMemory() {
        throw new vaultMod.MemoryStorageError("internal", "gate-vault-pin-failure");
      },
    }),
  );
}

const VOICE_OFFER_SDP =
  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendonly\r\n";

function voiceGateSession() {
  return {
    sessionId: "gate-sess-1",
    idempotencyKey: "gate-idem-1",
    profile: "full-realtime",
    capabilities: { speechToText: true, speechOutput: false, realtimeVoice: true },
    providerLocality: undefined,
    chatContext: undefined,
    hostSeq: 0,
    lastClientSeq: 0,
    replay: [],
    replayStart: 0,
    detachedAt: undefined,
    terminal: false,
  };
}

function makeVoiceRealtimeNegotiationProbe() {
  const correlationId = `gate-voice-${randomUUID()}`;
  return {
    id: "voice-realtime.negotiation-failure",
    async run() {
      const mod = await import(distPath("keiko-server", "voice-realtime.js"));
      const records = [];
      const conn = new mod.VoiceControlConnection({
        socket: {
          send() {
            // No-op fake socket: this probe only drives the negotiation-failure diagnostic, never
            // asserts on outbound frames.
          },
          close() {
            // No-op: see above.
          },
        },
        session: voiceGateSession(),
        negotiate: () => Promise.resolve({ ok: false, kind: "transport" }),
        redact: (value) => value,
        correlationId,
        diagnostics: { record: (r) => records.push(r) },
      });
      conn.start(false);
      await conn.receive(
        JSON.stringify({
          protocolVersion: "1",
          sessionId: "gate-sess-1",
          seq: 1,
          direction: "client-to-host",
          kind: "signal.sdp.offer",
          sdp: VOICE_OFFER_SDP,
        }),
      );
      return records;
    },
    assertShape(record) {
      check(
        record.correlationId === correlationId,
        `voice negotiate correlationId: ${record.correlationId}`,
      );
      check(
        record.operation === "voice.realtime.negotiate",
        `voice negotiate operation: ${record.operation}`,
      );
      check(record.source === "voice.realtime", `voice negotiate source: ${record.source}`);
      check(record.code === "transport", `voice negotiate code: ${record.code}`);
    },
  };
}

function makeRetentionPolicyProbe() {
  return {
    id: "memory-maintenance-handlers.resolveMemoryRetentionPolicy",
    async run() {
      const mod = await import(distPath("keiko-server", "memory-maintenance-handlers.js"));
      const records = [];
      const deps = {
        env: { KEIKO_MEMORY_RETENTION_MAX_AGE_DAYS: "not-a-number" },
        diagnostics: { record: (r) => records.push(r) },
        redactor: (value) => value,
      };
      const resolution = mod.resolveMemoryRetentionPolicy(deps);
      check(resolution.ok === false, "resolveMemoryRetentionPolicy did not fail closed");
      return records;
    },
    assertShape(record) {
      check(
        record.operation === "memory.maintenance.retention-policy",
        `retention-policy operation: ${record.operation}`,
      );
      check(
        record.source === "memory-maintenance-handlers.resolveMemoryRetentionPolicy",
        `retention-policy source: ${record.source}`,
      );
      check(record.errorClass === "TypeError", `retention-policy errorClass: ${record.errorClass}`);
    },
  };
}

function makeAutonomyModeProbe() {
  return {
    id: "memory-maintenance-handlers.resolveMaintenanceAutonomyMode",
    async run() {
      const mod = await import(distPath("keiko-server", "memory-maintenance-handlers.js"));
      const records = [];
      const deps = {
        store: {
          readMemoryAutonomyPolicy() {
            throw new Error("gate-store-unreadable");
          },
        },
        diagnostics: { record: (r) => records.push(r) },
        redactor: (value) => value,
      };
      mod.resolveMaintenanceAutonomyMode(deps);
      return records;
    },
    assertShape(record) {
      check(
        record.operation === "memory.maintenance.autonomy-mode",
        `autonomy-mode operation: ${record.operation}`,
      );
      check(
        record.source === "memory-maintenance-handlers.resolveMaintenanceAutonomyMode",
        `autonomy-mode source: ${record.source}`,
      );
      check(record.errorClass === "Error", `autonomy-mode errorClass: ${record.errorClass}`);
    },
  };
}

function makeConsolidationLogPortProbe() {
  return {
    id: "memory-consolidation.log-port.sink-failed",
    async run() {
      const mod = await import(distPath("keiko-memory-consolidation", "log-port.js"));
      const records = [];
      let calls = 0;
      const sink = {
        write(event) {
          calls += 1;
          if (calls === 1) throw new Error("gate-consolidation-sink-write-failure");
          records.push(event);
        },
      };
      mod.emitConsolidationLogEvent(sink, { category: "consolidation", op: "gate.probe.op" });
      return records;
    },
    assertShape(record) {
      check(
        record.category === "diagnostic",
        `consolidation log-port category: ${record.category}`,
      );
      check(
        record.op === "consolidation.log.sink-failed",
        `consolidation log-port op: ${record.op}`,
      );
      check(record.level === "error", `consolidation log-port level: ${record.level}`);
      check(
        record.extra?.droppedOpDigest === "2b1c9df7297b97cf",
        "consolidation log-port droppedOpDigest not retained",
      );
      check(record.extra?.droppedOp === undefined, "consolidation log-port leaked droppedOp");
      check(
        typeof record.errorKind === "string" && record.errorKind.length > 0,
        "consolidation log-port errorKind missing",
      );
    },
  };
}

const CONSOLIDATION_CLUSTER_BODIES = ["use tabs", "prefer compact diffs", "keep PR titles short"];

async function buildConsolidationClusterRecords() {
  const fixtures = await import("@oscharko-dev/keiko-contracts/memory-fixtures");
  return CONSOLIDATION_CLUSTER_BODIES.map((body, index) =>
    fixtures.makeMemoryRecord({
      id: `gate-consolidation-m-${String(index)}`,
      body,
      createdAt: 100 * (index + 1),
      updatedAt: 100 * (index + 1),
    }),
  );
}

function consolidationOptions(_records, sink) {
  let edgeCounter = 0;
  let reviewCounter = 0;
  const nextEdgeId = () => {
    edgeCounter += 1;
    return `gate-edge-${String(edgeCounter)}`;
  };
  const nextReviewItemId = () => {
    reviewCounter += 1;
    return `gate-review-${String(reviewCounter)}`;
  };
  return {
    nowMs: 1_700_000_000_000,
    newEdgeId: nextEdgeId,
    newReviewItemId: nextReviewItemId,
    jaccardThreshold: 0,
    staleConfidenceThreshold: 0.3,
    maxAgeMs: 90 * 24 * 60 * 60 * 1000,
    maxClustersPerRun: 100,
    maxRecordsPerRun: 1000,
    summaryGenerator: () => {
      throw new Error("gate-summary-generator-failure");
    },
    logSink: sink,
  };
}

function makeConsolidationSummaryFallbackProbe() {
  return {
    id: "memory-consolidation.summary-fallback",
    async run() {
      const mod = await import(distPath("keiko-memory-consolidation", "consolidate.js"));
      const records = [];
      const sink = { write: (event) => records.push(event) };
      const clusterRecords = await buildConsolidationClusterRecords();
      mod.runConsolidation(clusterRecords, consolidationOptions(clusterRecords, sink));
      return records;
    },
    assertShape(record) {
      check(record.category === "consolidation", `summary-fallback category: ${record.category}`);
      check(record.op === "consolidation.summary.fallback", `summary-fallback op: ${record.op}`);
      check(
        record.extra?.reason === "generator-threw",
        `summary-fallback reason: ${record.extra?.reason}`,
      );
    },
  };
}

function makeKeychainFallbackProbe() {
  return {
    id: "security.macos-keychain.fallback",
    async run() {
      const mod = await import(distPath("keiko-security", "macos-keychain.js"));
      const records = [];
      const sink = { write: (event) => records.push(event) };
      const error = Object.assign(new Error("gate-keychain-failure"), { code: "ENOENT" });
      mod.emitKeychainFallback(sink, error, () => 42);
      return records;
    },
    assertShape(record) {
      check(record.category === "security", `keychain fallback category: ${record.category}`);
      check(record.op === "security.keychain.fallback", `keychain fallback op: ${record.op}`);
      check(record.level === "warn", `keychain fallback level: ${record.level}`);
      check(record.durationMs === 42, `keychain fallback durationMs: ${record.durationMs}`);
      check(typeof record.extra?.reasonKind === "string", "keychain fallback reasonKind missing");
      check(
        typeof record.extra?.boundedExitKind === "string",
        "keychain fallback boundedExitKind missing",
      );
    },
  };
}

// #3532: the Quality Intelligence capsule resolver used to swallow a knowledge-store open failure
// and degrade silently to QI_CAPSULE_UNAVAILABLE. The failure is now reported once, on the operator
// diagnostic path, before the resolver degrades to its empty result.
function makeQualityIntelligenceCapsuleStoreProbe() {
  const correlationId = `gate-qi-capsule-${randomUUID()}`;
  return {
    id: "quality-intelligence.capsule-store-open",
    async run() {
      const mod = await import(distPath("keiko-server", "qualityIntelligence/capsuleAdapter.js"));
      const root = mkdtempSync(join(tmpdir(), "keiko-gate-qi-capsule-"));
      try {
        // A regular file where the knowledge-store directory belongs makes every open fail.
        writeFileSync(join(root, "local-knowledge"), "occupied");
        const records = [];
        const resolver = mod.makeCapsuleResolver(
          { uiDbPath: join(root, "ui.db"), diagnostics: { record: (r) => records.push(r) } },
          correlationId,
        );
        const documents = resolver?.capsule("gate-capsule");
        check(
          Array.isArray(documents) && documents.length === 0,
          "qi capsule resolver did not degrade to an empty result",
        );
        resolver?.close();
        return records;
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    assertShape(record) {
      check(
        record.correlationId === correlationId,
        `qi capsule correlationId: ${record.correlationId}`,
      );
      check(
        record.operation === "quality-intelligence.capsule-source",
        `qi capsule operation: ${record.operation}`,
      );
      check(record.source === "qi.capsule-adapter", `qi capsule source: ${record.source}`);
      check(
        record.message ===
          "Quality Intelligence could not open the knowledge store for a capsule source.",
        `qi capsule message: ${record.message}`,
      );
      check(
        typeof record.errorClass === "string" && record.errorClass.length > 0,
        "qi capsule errorClass missing",
      );
    },
  };
}

export const SITE_PROBES = [
  makeSinkTerminalTeeProbe(),
  makeMemoryGetProbe(),
  makeMemoryReviewQueueProbe(),
  makeMemoryPinProbe(),
  makeVoiceRealtimeNegotiationProbe(),
  makeRetentionPolicyProbe(),
  makeAutonomyModeProbe(),
  makeConsolidationLogPortProbe(),
  makeConsolidationSummaryFallbackProbe(),
  makeKeychainFallbackProbe(),
  makeQualityIntelligenceCapsuleStoreProbe(),
];

async function runProbe(probe, exercised) {
  let records;
  try {
    records = await probe.run();
  } catch (error) {
    fail(`site '${probe.id}' threw while exercising: ${String(error?.stack ?? error)}`);
    return;
  }
  if (records.length !== 1) {
    fail(`site '${probe.id}' expected exactly 1 record, got ${records.length}`);
    return;
  }
  try {
    probe.assertShape(records[0]);
  } catch (error) {
    fail(`site '${probe.id}' shape assertion failed: ${String(error?.stack ?? error)}`);
    return;
  }
  exercised.push(probe.id);
}

async function runServerTopLevelSite(exercised) {
  const mod = await loadServerModule();
  const records = [];
  const { server, port } = await startServer(mod, records);
  try {
    const cid = assertOpaque500WithId(await rawGet(port, "/api/projects"));
    assertDiagnosticCaptured(records, cid);
    await assertClientIdHonoured(port);
    exercised.push(SERVER_TOP_LEVEL_SITE_ID);
  } finally {
    await new Promise((res) => server.close(res));
  }
}

// The static check diffs against the PR base commit. Tests of the probe wiring pass their own
// findings, so they do not depend on how much Git history the checkout carries.
export async function main(findStaticViolations = unregisteredFailurePathDiffViolations) {
  const staticViolations = findStaticViolations();
  if (staticViolations.length > 0) {
    const sites = staticViolations
      .map((finding) => `${finding.path}:${String(finding.line)} (${finding.kind})`)
      .join(", ");
    fail(`new unregistered failure path(s): ${sites}`);
  }
  const exercised = [];
  await runServerTopLevelSite(exercised);
  for (const probe of SITE_PROBES) {
    await runProbe(probe, exercised);
  }
  if (exercised.length < MIN_STRATIFIED_SITES) {
    fail(`only ${exercised.length} distinct sites were exercised, need >= ${MIN_STRATIFIED_SITES}`);
  }
  console.log(
    `check:error-observability PASS — ${String(exercised.length)} distinct call sites verified ` +
      `(${exercised.join(", ")}).`,
  );
}

if (process.argv[1] === scriptPath) {
  try {
    await main();
  } catch (error) {
    fail(`unexpected gate error: ${String(error?.stack ?? error)}`);
  }
}
