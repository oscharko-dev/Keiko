// Test harness of the review run service (Issue #4136): a real fixture repository, the real review
// services (target resolver, hardened worktree, diff package), the real run store over an in-memory
// SQLite database with the server's migrations, and scripted building blocks for the parts that
// would need a model: the Reviewer run (its candidates go through the real finding intake against
// the real review worktree) and, unless a test supplies the real one, the counter-check.

import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { ModelCapability } from "@oscharko-dev/keiko-contracts";
import type {
  CounterCheckVerdict,
  ReviewFindingReport,
  ReviewTarget,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { createGitReviewProcessRunner } from "@oscharko-dev/keiko-git";

import {
  captureActivityLog,
  type ActivityLogCapture,
} from "../../activityLogCapture.test-support.js";
import {
  buildRedactor,
  createInMemoryUiStore,
  createRunRegistry,
  type UiHandlerDeps,
} from "../../index.js";
import type { RouteContext } from "../../routes.js";
import { runMigrations } from "../../store/schema.js";
import type { UiStore } from "../../store/index.js";
import type { CounterCheckInput, CounterCheckOutcome } from "../counter-check/counterCheck.js";
import { createReviewFindingIntake } from "../runtime/findingIntake.js";
import type {
  ReviewRuntimeRunRequest,
  ReviewRuntimeRunResult,
  ReviewRuntimeService,
} from "../runtime/instance.js";
import { createReviewServices, type ReviewServices, type ReviewServicesDeps } from "../services.js";
import {
  commitFile,
  createFixtureRoot,
  git,
  initRepository,
  type ReviewFixtureRoot,
} from "../reviewFixtures.test-support.js";
import {
  createReviewEvaluationService,
  createReviewRunService,
  type ReviewEvaluationSwitches,
  type ReviewRunService,
  type ReviewRunServiceDeps,
} from "./service.js";
import { ReviewRunStore } from "./store.js";

const TOTAL_SOURCE = [
  "export function total(items: number[]): number {",
  "  let sum = 0;",
  "  for (let i = 0; i <= items.length; i++) sum += items[i];",
  "  return sum;",
  "}",
  "export function first(items: number[]): number {",
  "  return items[0];",
  "}",
  "export function last(items: number[]): number {",
  "  return items[items.length];",
  "}",
  "",
].join("\n");

/** A candidate report on `src/total.ts` at `line` with the given severity. */
export function reportAt(
  line: number,
  severity: ReviewFindingReport["severity"],
): ReviewFindingReport {
  return {
    file: "src/total.ts",
    startLine: line,
    endLine: line,
    title: `Finding at ${String(line)}`,
    condition: "condition",
    mechanism: `mechanism ${String(line)}`,
    consequence: "consequence",
    remedy: "remedy",
    category: "correctness",
    severity,
    evidence: [{ file: "src/total.ts", startLine: line, endLine: line, role: "defect" }],
  };
}

export function capability(id: string, overrides: Partial<ModelCapability> = {}): ModelCapability {
  return {
    id,
    kind: "chat",
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    toolCalling: true,
    toolCallingVerification: {
      status: "verified",
      checkedAt: new Date(Date.now() - 60_000).toISOString(),
      probe: "gateway-tool-calling-v1",
      configurationFingerprint: "fixture",
    },
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: false,
    workflowEligible: true,
    costClass: "low",
    latencyClass: "standard",
    throughputHint: "fixture",
    preferredUseCases: [],
    knownLimitations: [],
    ...overrides,
  };
}

export type RuntimeScript = (
  request: ReviewRuntimeRunRequest,
  harness: ReviewRunHarness,
) => Promise<ReviewRuntimeRunResult>;

/** A Reviewer that files `reports` through the real intake and ends with `outcome`. */
export function reviewerFiling(
  reports: readonly ReviewFindingReport[],
  outcome: "completed" | "failed" | "cancelled" | "refused" = "completed",
  failureCode?: string,
): RuntimeScript {
  return async (request, harness) => {
    const intake = createReviewFindingIntake({
      runId: request.reviewRunId,
      worktreeRoot: request.worktreeRoot,
      headSha: request.headSha,
      runner: createGitReviewProcessRunner(),
      activityLog: harness.log.sink,
    });
    for (const report of reports) await intake.submit(report);
    return {
      ok: true,
      outcome,
      ...(failureCode === undefined ? {} : { failureCode }),
      effort: { promptTokens: 4_321, modelTurns: 3 },
      rules: "absent",
      candidates: intake.candidates(),
      rejections: intake.rejections(),
    };
  };
}

/** A Reviewer that waits until the run is cancelled, then reports the cancellation. */
export const reviewerUntilCancelled: RuntimeScript = (request) =>
  new Promise((resolve) => {
    request.signal?.addEventListener("abort", () => {
      resolve({
        ok: true,
        outcome: "cancelled",
        rules: "absent",
        candidates: [],
        rejections: {
          "schema-invalid": 0,
          "path-outside-worktree": 0,
          "range-invalid": 0,
          "evidence-mismatch": 0,
          "limit-reached": 0,
        },
      });
    });
  });

/** A scripted counter-check: the verdict by the candidate's reported start line. */
export function counterCheckBy(
  verdicts: Readonly<Record<number, "confirmed" | "refuted" | "undecided">>,
  effect: CounterCheckOutcome["effect"] = "none",
): (input: CounterCheckInput) => Promise<CounterCheckOutcome> {
  return (input) => {
    const report = input.candidate.report;
    const value = verdicts[report.startLine] ?? "undecided";
    const verdict: CounterCheckVerdict =
      value === "confirmed"
        ? {
            findingFingerprint: input.candidate.fingerprint,
            verdict: "confirmed",
            reasonCode: "defect-reproduced-in-code",
            evidence: [
              {
                file: report.file,
                startLine: report.startLine,
                endLine: report.endLine,
                role: "defect",
              },
            ],
          }
        : {
            findingFingerprint: input.candidate.fingerprint,
            verdict: value,
            reasonCode: value === "refuted" ? "guarded-elsewhere" : "insufficient-context",
            evidence: [],
          };
    return Promise.resolve({
      verdict,
      evidenceInHead: value === "confirmed",
      effect,
      toolCallCount: 3,
      durationMs: 10,
      promptTokens: 500,
      completionTokens: 20,
    });
  };
}

export interface HarnessOptions {
  readonly runtime?: RuntimeScript | undefined;
  readonly counterCheck?: ((input: CounterCheckInput) => Promise<CounterCheckOutcome>) | undefined;
  readonly capabilities?: Readonly<Record<string, ModelCapability | undefined>> | undefined;
  readonly services?: Partial<ReviewServicesDeps> | undefined;
  readonly evaluation?: ReviewEvaluationSwitches | undefined;
  /** Overrides of the real review services (a pull request target, a hanging step). */
  readonly wrapServices?: ((services: ReviewServices) => ReviewServices) | undefined;
  readonly store?: ((db: DatabaseSync) => ReviewRunStore) | undefined;
  readonly db?: DatabaseSync | undefined;
  /** Issue #4137: the operator and user policy in front of eligibility (default: none). */
  readonly admit?: ReviewRunServiceDeps["models"]["admit"];
}

export interface ReviewRunHarness {
  readonly fixture: ReviewFixtureRoot;
  readonly repo: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly db: DatabaseSync;
  readonly store: ReviewRunStore;
  readonly uiStore: UiStore;
  readonly services: ReviewServices;
  readonly service: ReviewRunService;
  readonly log: ActivityLogCapture;
  readonly runtimeRequests: ReviewRuntimeRunRequest[];
  readonly counterInputs: CounterCheckInput[];
  deps(): UiHandlerDeps;
  ctx(
    path: string,
    options?: {
      readonly params?: Record<string, string>;
      readonly body?: unknown;
      readonly res?: ServerResponse;
    },
  ): RouteContext;
  cleanup(): Promise<void>;
}

/** Builds the fixture: `main` at the base commit, `topic` at the head commit that changes it. */
function createFixtureRepository(fixture: ReviewFixtureRoot): {
  readonly repo: string;
  readonly baseSha: string;
  readonly headSha: string;
} {
  const repo = join(fixture.root, "repo");
  initRepository(repo);
  const baseSha = commitFile(repo, "src/total.ts", "export const placeholder = 0;\n", "base");
  git(repo, "checkout", "-q", "-b", "topic");
  commitFile(repo, "src/util.ts", "export const ONE = 1;\n", "util");
  const headSha = commitFile(repo, "src/total.ts", TOTAL_SOURCE, "head");
  git(repo, "checkout", "-q", "main");
  return { repo, baseSha, headSha };
}

const NO_GITHUB: ReviewServicesDeps["github"] = {
  ownerAndRepo: () => Promise.resolve(undefined),
  readerFor: () => {
    throw new TypeError("no GitHub in this fixture");
  },
};

function serviceDeps(
  harness: Omit<ReviewRunHarness, "service" | "deps" | "ctx" | "cleanup">,
  options: HarnessOptions,
): ReviewRunServiceDeps {
  const runtime = options.runtime ?? reviewerFiling([]);
  const reviewRuntime: Pick<ReviewRuntimeService, "run"> = {
    run: (request) => {
      harness.runtimeRequests.push(request);
      return runtime(request, harness as ReviewRunHarness);
    },
  };
  const counterCheck = options.counterCheck ?? counterCheckBy({});
  return {
    store: harness.store,
    reviewServices: harness.services,
    reviewRuntime,
    counterCheck: (input): Promise<CounterCheckOutcome> => {
      harness.counterInputs.push(input);
      return counterCheck(input);
    },
    models: {
      capability: (modelId): ModelCapability | undefined => {
        const configured = options.capabilities;
        if (configured !== undefined && Object.hasOwn(configured, modelId)) {
          return configured[modelId];
        }
        return capability(modelId);
      },
      generation: () => 7,
      ...(options.admit === undefined ? {} : { admit: options.admit }),
    },
    activityLog: harness.log.sink,
  };
}

function handlerDeps(
  uiStore: UiStore,
  services: ReviewServices,
  service: ReviewRunService,
): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: () => "",
      list: () => [],
      get: () => undefined,
      delete: () => undefined,
    },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: () => undefined,
    store: uiStore,
    reviewServices: services,
    reviewRunService: service,
  };
}

type ContextOptions = Parameters<ReviewRunHarness["ctx"]>[1];

function routeContext(path: string, options: ContextOptions = {}): RouteContext {
  const req = Readable.from(
    options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))],
  ) as unknown as IncomingMessage;
  Object.assign(req, { headers: { "content-type": "application/json" } });
  return {
    correlationId: "corr-review-run",
    req,
    res: options.res ?? ({} as unknown as ServerResponse),
    params: options.params ?? {},
    url: new URL(`http://localhost${path}`),
  };
}

function harnessParts(
  options: HarnessOptions,
): Omit<ReviewRunHarness, "service" | "deps" | "ctx" | "cleanup"> {
  const fixture = createFixtureRoot("keiko-review-run-");
  const { repo, baseSha, headSha } = createFixtureRepository(fixture);
  const log = captureActivityLog();
  const db = options.db ?? new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  const store = options.store?.(db) ?? new ReviewRunStore(db);
  const real = createReviewServices({
    reviewRoot: join(fixture.root, "review-root"),
    activityLog: log.sink,
    github: NO_GITHUB,
    retainedRunRefs: (root) => store.retainedRefs(root),
    ...options.services,
  });
  const uiStore = createInMemoryUiStore();
  uiStore.createProject(repo, "fixture");
  return {
    fixture,
    repo,
    baseSha,
    headSha,
    db,
    store,
    uiStore,
    services: options.wrapServices?.(real) ?? real,
    log,
    runtimeRequests: [],
    counterInputs: [],
  };
}

export function createReviewRunHarness(options: HarnessOptions = {}): ReviewRunHarness {
  const parts = harnessParts(options);
  const deps = serviceDeps(parts, options);
  const service =
    options.evaluation === undefined
      ? createReviewRunService(deps)
      : createReviewEvaluationService(deps, options.evaluation);
  return {
    ...parts,
    service,
    deps: () => handlerDeps(parts.uiStore, parts.services, service),
    ctx: routeContext,
    cleanup: async (): Promise<void> => {
      await service.dispose();
      await parts.services.dispose();
      parts.uiStore.close();
      if (options.db === undefined) parts.db.close();
      parts.fixture.cleanup();
    },
  };
}

/** A local-range start body for the fixture's `main..topic`. */
export function startBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target: { kind: "local-range", baseRef: "main", headRef: "topic" },
    reviewerModelId: "reviewer-model",
    counterCheckerModelId: "checker-model",
    clientRequestId: "client-request-1",
    ...overrides,
  };
}

/** Turns a resolved local-range target into a pull request target with `number`. */
function asPullRequest(target: ReviewTarget, number: number): ReviewTarget {
  return {
    kind: "pull-request",
    provider: "github",
    repositoryId: target.repositoryId,
    number,
    baseSha: target.baseSha,
    headSha: target.headSha,
    baseRef: target.baseRef,
    headRef: target.headRef,
    isCrossRepository: false,
  };
}

/** The review services with some members replaced; every other member delegates to `services`. */
export function delegatingServices(
  services: ReviewServices,
  overrides: Partial<ReviewServices>,
): ReviewServices {
  return {
    reviewRoot: services.reviewRoot,
    namespace: services.namespace,
    pullRequests: services.pullRequests,
    worktrees: services.worktrees,
    resolveTarget: (input) => services.resolveTarget(input),
    buildDiffPackage: (input) => services.buildDiffPackage(input),
    sweepRefs: (trigger, correlationId) => services.sweepRefs(trigger, correlationId),
    reviewRunner: (correlationId) => services.reviewRunner(correlationId),
    startup: (correlationId) => services.startup(correlationId),
    dispose: (correlationId) => services.dispose(correlationId),
    ...overrides,
  };
}

/** A pull request target `number` reviewed as the fixture's `main..topic`, with a scripted head. */
export function pullRequestServices(
  services: ReviewServices,
  number: number,
  currentHead: () => Promise<string | undefined>,
): ReviewServices {
  return delegatingServices(services, {
    resolveTarget: async (input) => {
      const resolved = await services.resolveTarget({
        ...input,
        request: { kind: "local-range", baseRef: "main", headRef: "topic" },
      });
      return resolved.ok
        ? { ...resolved, target: asPullRequest(resolved.target, number) }
        : resolved;
    },
    pullRequests: {
      ...services.pullRequests,
      detail: async () => {
        const headSha = await currentHead();
        return {
          schemaVersion: 1,
          availability: "available",
          pullRequest:
            headSha === undefined
              ? null
              : ({ number, headSha, baseSha: "", additions: 3, deletions: 1 } as never),
        };
      },
    },
  });
}
