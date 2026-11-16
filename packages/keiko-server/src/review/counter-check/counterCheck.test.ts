// One counter-check per candidate (ADR-0184 D5, Issue #4136, AC3): a fresh session whose recorded
// model input holds only the candidate task (no Reviewer reasoning, transcript, title, remedy or
// other candidate), bound to the reviewed head commit, offered exactly its three read tools and its
// verdict tool, and settled honestly when a bound ends it.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundGatewayToolCatalog } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import {
  REVIEW_COUNTER_CHECK_DEFAULT_MAX_OUTPUT_TOKENS,
  REVIEW_COUNTER_CHECK_DEFAULT_MAX_READ_CALLS,
  type ReviewFindingReport,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { createGitReviewProcessRunner } from "@oscharko-dev/keiko-git";
import type { GatewayCallRequest, NormalizedResponse } from "@oscharko-dev/keiko-model-gateway";
import {
  createToolInvocationNormalizer,
  REVIEW_COUNTER_CHECK_TOOL_ALIASES,
} from "@oscharko-dev/keiko-tool-catalog";

import {
  captureActivityLog,
  type ActivityLogCapture,
} from "../../activityLogCapture.test-support.js";
import {
  createReviewFindingIntake,
  ReviewHeadFileReader,
  type ReviewCandidateFinding,
} from "../runtime/findingIntake.js";
import {
  commitFile,
  createFixtureRoot,
  initRepository,
  type ReviewFixtureRoot,
} from "../reviewFixtures.test-support.js";
import {
  counterCheckCandidate,
  type CounterCheckDeps,
  type CounterCheckOutcome,
} from "./counterCheck.js";
import { COUNTER_CHECK_READ_ALLOWANCE_GUIDANCE } from "./tools.js";

const TOOLS = REVIEW_COUNTER_CHECK_TOOL_ALIASES;
const SENTINELS = {
  title: "TITLE-SENTINEL-not-for-checker",
  remedy: "REMEDY-SENTINEL-not-for-checker",
  trigger: "TRIGGER-SENTINEL-not-for-checker",
};

let fixture: ReviewFixtureRoot;
let repo: string;
let headSha: string;
let log: ActivityLogCapture;

const HEAD_SOURCE = [
  "export function total(items: number[]): number {",
  "  let sum = 0;",
  "  for (let i = 0; i <= items.length; i++) sum += items[i];",
  "  return sum;",
  "}",
  "export const GUARD_MARKER = 1;",
  "",
].join("\n");

function report(overrides: Partial<ReviewFindingReport> = {}): ReviewFindingReport {
  return {
    file: "src/total.ts",
    startLine: 3,
    endLine: 3,
    title: SENTINELS.title,
    condition: "The loop runs one index past the end",
    mechanism: "The bound uses <= instead of <",
    consequence: "The sum becomes NaN",
    remedy: SENTINELS.remedy,
    category: "correctness",
    severity: "high",
    evidence: [{ file: "src/total.ts", startLine: 3, endLine: 3, role: "defect" }],
    failureMode: { trigger: SENTINELS.trigger, detection: "nothing", coveredByChange: false },
    ...overrides,
  };
}

async function candidateOf(value: ReviewFindingReport): Promise<ReviewCandidateFinding> {
  const intake = createReviewFindingIntake({
    runId: "review-run-fixture",
    worktreeRoot: repo,
    headSha,
    runner: createGitReviewProcessRunner(),
    activityLog: log.sink,
  });
  const acknowledgement = await intake.submit(value);
  expect(acknowledgement.status).toBe("accepted");
  const [candidate] = intake.candidates();
  if (candidate === undefined) throw new TypeError("no candidate");
  return candidate;
}

function response(overrides: Partial<NormalizedResponse> = {}): NormalizedResponse {
  return {
    modelId: "checker",
    content: "done",
    finishReason: "stop",
    toolCalls: [],
    structuredOutput: null,
    usage: {
      requestId: "r",
      promptTokens: 100,
      completionTokens: 10,
      latencyMs: 1,
      costClass: "low",
    },
    ...overrides,
  };
}

type Step =
  { readonly tool: string; readonly args: Record<string, unknown> } | { readonly text: string };

interface ScriptedModel {
  readonly requests: GatewayCallRequest[];
  readonly toolOutputs: string[];
  readonly call: (request: GatewayCallRequest, signal: AbortSignal) => Promise<NormalizedResponse>;
}

/** A scripted Counter-checker: each turn answers the next step, binding tool calls to the catalog. */
function scripted(steps: readonly Step[]): ScriptedModel {
  const requests: GatewayCallRequest[] = [];
  const toolOutputs: string[] = [];
  let turn = 0;
  return {
    requests,
    toolOutputs,
    call: (request): Promise<NormalizedResponse> => {
      requests.push(request);
      for (const message of request.messages) {
        if (message.role === "tool" && typeof message.content === "string") {
          if (!toolOutputs.includes(message.content)) toolOutputs.push(message.content);
        }
      }
      const step = steps[turn] ?? { text: "finished" };
      turn += 1;
      if ("text" in step) return Promise.resolve(response({ content: step.text }));
      const bound = boundGatewayToolCatalog(request.toolCatalog);
      const invocation =
        bound === undefined
          ? undefined
          : createToolInvocationNormalizer({
              catalog: bound.catalog,
              projection: bound.projection,
              offered: bound.offered,
            }).bindAlias(step.tool, step.args, 0);
      return Promise.resolve(
        response({
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: `call-${String(turn)}`,
              name: step.tool,
              arguments: step.args,
              ...(invocation === undefined ? {} : { invocation }),
            },
          ],
        }),
      );
    },
  };
}

function deps(
  model: ScriptedModel | undefined,
  limits: CounterCheckDeps["limits"] = {},
): CounterCheckDeps {
  return {
    modelPortFactory: () => (model === undefined ? undefined : { call: model.call }),
    runner: () => createGitReviewProcessRunner(),
    activityLog: log.sink,
    limits,
  };
}

function check(
  model: ScriptedModel | undefined,
  candidate: ReviewCandidateFinding,
  options: {
    readonly limits?: CounterCheckDeps["limits"];
    readonly signal?: AbortSignal;
    readonly declaredMaxOutputTokens?: CounterCheckDeps["declaredMaxOutputTokens"];
    readonly attempt?: number;
  } = {},
): Promise<CounterCheckOutcome> {
  const checkDeps = {
    ...deps(model, options.limits),
    declaredMaxOutputTokens: options.declaredMaxOutputTokens,
  };
  return counterCheckCandidate(checkDeps, {
    candidate,
    modelId: "checker",
    worktreeRoot: repo,
    headSha,
    reader: new ReviewHeadFileReader({
      worktreeRoot: repo,
      headSha,
      runner: createGitReviewProcessRunner(),
    }),
    signal: options.signal ?? new AbortController().signal,
    runCorrelationId: "review-run-correlation",
    ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
  });
}

const CONFIRM = {
  tool: TOOLS.verdict,
  args: {
    verdict: "confirmed",
    reasonCode: "defect-reproduced-in-code",
    evidence: [{ file: "src/total.ts", startLine: 3, endLine: 3, role: "defect" }],
  },
} as const;

function completedLine(): unknown {
  return log.events.find((event) => event.op === "review.counter-check.completed");
}

function allText(model: ScriptedModel): string {
  return JSON.stringify(model.requests.map((request) => request.messages));
}

beforeEach(() => {
  fixture = createFixtureRoot("keiko-counter-check-");
  repo = join(fixture.root, "repo");
  initRepository(repo);
  commitFile(repo, "src/total.ts", "export const placeholder = 0;\n", "base");
  headSha = commitFile(repo, "src/total.ts", HEAD_SOURCE, "head");
  log = captureActivityLog();
});

afterEach(() => {
  fixture.cleanup();
});

describe("counterCheckCandidate", () => {
  it("confirms with head evidence and gives the session only the candidate task (AC3)", async () => {
    const candidate = await candidateOf(report());
    const model = scripted([{ tool: TOOLS.read, args: { relativePath: "src/total.ts" } }, CONFIRM]);
    const outcome = await check(model, candidate);
    expect(outcome).toMatchObject({
      verdict: { verdict: "confirmed", findingFingerprint: candidate.fingerprint },
      evidenceInHead: true,
      effect: "none",
      toolCallCount: 2,
    });
    const text = allText(model);
    expect(text).toContain("The bound uses <= instead of <");
    expect(text).toContain("src/total.ts lines 3-3");
    for (const sentinel of Object.values(SENTINELS)) expect(text).not.toContain(sentinel);
    const [first] = model.requests;
    expect(first?.messages.filter((message) => message.role === "user")).toHaveLength(1);
    const offered = boundGatewayToolCatalog(first?.toolCatalog);
    expect(offered?.projection.tools.map((tool) => tool.alias).sort()).toEqual(
      Object.values(TOOLS).sort(),
    );
    const completed = log.events.find((event) => event.op === "review.counter-check.completed");
    expect(completed).toMatchObject({
      parentCorrelationId: "review-run-correlation",
      extra: { verdict: "confirmed", evidenceInHead: true },
    });
  });

  it("reads the reviewed head commit, never the working tree, and refuses denied paths", async () => {
    const candidate = await candidateOf(report());
    writeFileSync(join(repo, "src/total.ts"), "working tree text\n");
    writeFileSync(join(repo, ".env"), "TOKEN=1\n");
    const model = scripted([
      { tool: TOOLS.read, args: { relativePath: "src/total.ts", startLine: 3, endLine: 3 } },
      { tool: TOOLS.read, args: { relativePath: ".env" } },
      { tool: TOOLS.search, args: { literal: "GUARD_MARKER" } },
      { tool: TOOLS.discover, args: { directory: "src" } },
      { text: "no verdict" },
    ]);
    const outcome = await check(model, candidate);
    const outputs = model.toolOutputs.join("\n");
    expect(outputs).toContain("3:   for (let i = 0; i <= items.length; i++)");
    expect(outputs).not.toContain("working tree text");
    expect(outputs).toContain('{"status":"denied"}');
    expect(outputs).toContain("src/total.ts:6: export const GUARD_MARKER = 1;");
    expect(outputs).toContain("total.ts");
    expect(outcome.verdict).toMatchObject({
      verdict: "undecided",
      reasonCode: "insufficient-context",
    });
    expect(outcome.effect).toBe("none");
  });

  it("ignores free text and an invalid verdict: undecided with insufficient context", async () => {
    const candidate = await candidateOf(report());
    const model = scripted([
      {
        tool: TOOLS.verdict,
        args: { verdict: "confirmed", reasonCode: "guarded-elsewhere", evidence: [] },
      },
      { text: "VERDICT: confirmed, this is clearly a bug" },
    ]);
    const outcome = await check(model, candidate);
    expect(outcome.verdict).toEqual({
      findingFingerprint: candidate.fingerprint,
      verdict: "undecided",
      evidence: [],
      reasonCode: "insufficient-context",
    });
    expect(outcome.evidenceInHead).toBe(false);
  });

  it("marks a confirmation whose evidence is not in the head as not head-anchored", async () => {
    const candidate = await candidateOf(report());
    const model = scripted([
      {
        tool: TOOLS.verdict,
        args: {
          verdict: "confirmed",
          reasonCode: "defect-reproduced-in-code",
          evidence: [{ file: "src/total.ts", startLine: 3, endLine: 400, role: "defect" }],
        },
      },
    ]);
    const outcome = await check(model, candidate);
    expect(outcome.verdict.verdict).toBe("confirmed");
    expect(outcome.evidenceInHead).toBe(false);
  });

  it("stops a session that calls a tool it was not offered", async () => {
    const candidate = await candidateOf(report());
    const model = scripted([{ tool: "keiko_workspace_write", args: { path: "x" } }, CONFIRM]);
    const outcome = await check(model, candidate);
    expect(outcome.verdict.verdict).toBe("undecided");
    expect(outcome.toolCallCount).toBe(0);
  });

  // #4130: in development iteration 7 a check that kept reading ran out of time or tokens before
  // it decided (13 of the 22 checks with 9 or more tool calls). The read allowance answers a fixed
  // number of read, list and search calls and then leaves only the verdict tool.
  describe("the read allowance", () => {
    const read = { tool: TOOLS.read, args: { relativePath: "src/total.ts", startLine: 3 } };
    const search = { tool: TOOLS.search, args: { literal: "GUARD_MARKER" } };
    const discover = { tool: TOOLS.discover, args: { directory: "src" } };

    it("answers the allowed calls, refuses the rest with the guidance, and still records the verdict", async () => {
      const candidate = await candidateOf(report());
      const model = scripted([read, search, discover, read, CONFIRM]);
      const outcome = await check(model, candidate, { limits: { maxReadCalls: 2 } });

      expect(outcome.readCalls).toEqual({ admitted: 2, refused: 2 });
      expect(outcome).toMatchObject({ verdict: { verdict: "confirmed" }, effect: "none" });
      const refusals = model.toolOutputs.filter((output) =>
        output.includes('"status":"read-allowance-used"'),
      );
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain(COUNTER_CHECK_READ_ALLOWANCE_GUIDANCE);
      // The refused list call answered nothing of the tree.
      expect(model.toolOutputs.join("\n")).not.toContain("total.ts\n");
      expect(completedLine()).toMatchObject({
        extra: { admittedReadCallCount: 2, refusedReadCallCount: 2, toolCallCount: 5 },
      });
    });

    it("does not count the verdict tool, so a session at the allowance can still decide", async () => {
      const candidate = await candidateOf(report());
      const model = scripted([read, CONFIRM]);
      const outcome = await check(model, candidate, { limits: { maxReadCalls: 1 } });
      expect(outcome.readCalls).toEqual({ admitted: 1, refused: 0 });
      expect(outcome.verdict.verdict).toBe("confirmed");
    });

    it("answers no read call at an allowance of zero", async () => {
      const candidate = await candidateOf(report());
      const model = scripted([read, CONFIRM]);
      const outcome = await check(model, candidate, { limits: { maxReadCalls: 0 } });
      expect(outcome.readCalls).toEqual({ admitted: 0, refused: 1 });
      expect(model.toolOutputs.join("\n")).not.toContain("3:   for (let i = 0;");
      expect(outcome.verdict.verdict).toBe("confirmed");
    });

    it("leaves a session that ignores the guidance to the tool-call ceiling", async () => {
      const candidate = await candidateOf(report());
      const model = scripted([read, read, read, read, read, CONFIRM]);
      const outcome = await check(model, candidate, {
        limits: { maxReadCalls: 1, maxToolCalls: 3 },
      });
      expect(outcome).toMatchObject({
        verdict: { verdict: "undecided", reasonCode: "out-of-budget" },
        effect: "budget-exhausted",
        readCalls: { admitted: 1, refused: 2 },
      });
    });

    it("tells the model its allowance in the task, with the default of the contract", async () => {
      const candidate = await candidateOf(report());
      const model = scripted([CONFIRM]);
      await check(model, candidate, { limits: { maxReadCalls: 5 } });
      expect(allText(model)).toContain("You have 5 read, list and search calls in all.");
      const byDefault = scripted([CONFIRM]);
      await check(byDefault, candidate);
      expect(allText(byDefault)).toContain(
        `You have ${String(REVIEW_COUNTER_CHECK_DEFAULT_MAX_READ_CALLS)} read, list and search calls in all.`,
      );
    });
  });

  // #4130: a turn that spends the model's whole output budget on reasoning ends without a tool
  // call, and the check failed `model-failed` after 645 seconds in that one turn. Each turn now has a
  // smaller budget and asks for the gateway's one steered repair.
  describe("the output budget of a turn", () => {
    it("gives every turn the budget and asks for the gateway's steered repair", async () => {
      const candidate = await candidateOf(report());
      const read = { tool: TOOLS.read, args: { relativePath: "src/total.ts", startLine: 3 } };
      const model = scripted([read, CONFIRM]);
      await check(model, candidate);
      expect(model.requests).toHaveLength(2);
      for (const request of model.requests) {
        expect(request.maxOutputTokens).toBe(REVIEW_COUNTER_CHECK_DEFAULT_MAX_OUTPUT_TOKENS);
        expect(request.answerRepair).toBe("steered");
      }

      const configured = scripted([CONFIRM]);
      await check(configured, candidate, { limits: { maxOutputTokens: 1_000 } });
      expect(configured.requests[0]?.maxOutputTokens).toBe(1_000);
    });

    /** The scripted model with one discarded attempt reported on its first answer. */
    function repairedOnce(steps: readonly Step[]): ScriptedModel {
      const model = scripted(steps);
      const answer = model.call;
      let first = true;
      return {
        ...model,
        call: async (request, signal): Promise<NormalizedResponse> => {
          const response = await answer(request, signal);
          if (!first) return response;
          first = false;
          return {
            ...response,
            discardedAttemptUsage: { attemptCount: 1, promptTokens: 700, completionTokens: 4_096 },
          };
        },
      };
    }

    it("counts what the gateway discarded inside a turn in the session's totals", async () => {
      const candidate = await candidateOf(report());
      const plain = await check(scripted([CONFIRM]), candidate);
      const outcome = await check(repairedOnce([CONFIRM]), candidate);

      // A verdict that came with the answer whose attempt was discarded is still recorded.
      expect(outcome.verdict.verdict).toBe("confirmed");
      expect(outcome.effect).toBe("none");
      expect(outcome.discardedAttemptCount).toBe(1);
      // The same turn's own tokens, and the discarded attempt's 700 prompt and 4,096 completion.
      expect(outcome.promptTokens).toBe(plain.promptTokens + 700);
      expect(outcome.completionTokens).toBe(plain.completionTokens + 4_096);
      const completed = log.events.filter((event) => event.op === "review.counter-check.completed");
      expect(completed.map((event) => event.extra?.discardedAttemptCount)).toEqual([0, 1]);
    });

    // R4130-067: the gateway refuses a request that asks for more output than the model declares.
    it.each([
      [2_048, 2_048],
      [8_192, REVIEW_COUNTER_CHECK_DEFAULT_MAX_OUTPUT_TOKENS],
      [0, REVIEW_COUNTER_CHECK_DEFAULT_MAX_OUTPUT_TOKENS],
      [undefined, REVIEW_COUNTER_CHECK_DEFAULT_MAX_OUTPUT_TOKENS],
    ])("asks for no more output than the model declares (%s)", async (declared, expected) => {
      const candidate = await candidateOf(report());
      const model = scripted([CONFIRM]);
      const asked: string[] = [];
      await check(model, candidate, {
        declaredMaxOutputTokens: (modelId) => {
          asked.push(modelId);
          return declared;
        },
      });
      expect(asked).toEqual(["checker"]);
      expect(model.requests[0]?.maxOutputTokens).toBe(expected);
    });

    it("reports no discarded attempt for a session without one", async () => {
      const candidate = await candidateOf(report());
      const outcome = await check(scripted([CONFIRM]), candidate);
      expect(outcome.discardedAttemptCount).toBe(0);
      expect(completedLine()).toMatchObject({ extra: { discardedAttemptCount: 0 } });
    });
  });

  // #4130: a candidate's second session, after the first ended on a model failure, says so.
  it("records the attempt of a second session on its lines, and none on a first session", async () => {
    const candidate = await candidateOf(report());
    await check(scripted([CONFIRM]), candidate);
    expect(completedLine()).not.toMatchObject({ extra: { attempt: expect.anything() as number } });

    log = captureActivityLog();
    await check(scripted([CONFIRM]), candidate, { attempt: 2 });
    expect(completedLine()).toMatchObject({ extra: { attempt: 2, verdict: "confirmed" } });

    log = captureActivityLog();
    await check(undefined, candidate, { attempt: 2 });
    expect(log.events.find((event) => event.op === "review.counter-check.failed")).toMatchObject({
      extra: { attempt: 2, failureClass: "model-unavailable" },
    });
  });

  it("ends at the tool-call ceiling as out-of-budget (budget-exhausted)", async () => {
    const candidate = await candidateOf(report());
    const read = { tool: TOOLS.read, args: { relativePath: "src/total.ts" } };
    const model = scripted([read, read, read, CONFIRM]);
    const outcome = await check(model, candidate, { limits: { maxToolCalls: 2 } });
    expect(outcome).toMatchObject({
      verdict: { verdict: "undecided", reasonCode: "out-of-budget" },
      effect: "budget-exhausted",
    });
    expect(log.events.find((event) => event.op === "review.counter-check.failed")).toMatchObject({
      extra: { failureClass: "budget-exhausted" },
    });
  });

  it("settles an unavailable or failing model as model-failed", async () => {
    const candidate = await candidateOf(report());
    // #4130: a model that does not exist is not worth a second session; a failing one is.
    expect(await check(undefined, candidate)).toMatchObject({
      effect: "model-failed",
      retryable: false,
    });
    const failing: ScriptedModel = {
      requests: [],
      toolOutputs: [],
      call: () => Promise.reject(new Error("provider failed mid-stream")),
    };
    const outcome = await check(failing, candidate);
    expect(outcome).toMatchObject({
      effect: "model-failed",
      retryable: true,
      verdict: { verdict: "undecided" },
    });
    const failures = log.events.filter((event) => event.op === "review.counter-check.failed");
    expect(failures.map((event) => event.extra?.failureClass)).toEqual([
      "model-unavailable",
      "model-failed",
    ]);
  });

  it("settles a cancelled session as cancelled and a slow one as deadline-exceeded", async () => {
    const candidate = await candidateOf(report());
    const aborted = new AbortController();
    aborted.abort();
    expect(await check(scripted([CONFIRM]), candidate, { signal: aborted.signal })).toMatchObject({
      effect: "cancelled",
      retryable: false,
    });
    const slow: ScriptedModel = {
      requests: [],
      toolOutputs: [],
      call: (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    };
    const outcome = await check(slow, candidate, { limits: { wallTimeMs: 50 } });
    expect(outcome).toMatchObject({
      effect: "deadline-exceeded",
      retryable: true,
      verdict: { reasonCode: "out-of-budget" },
    });
  });

  // #4130: a session with a verdict, and one out of prompt tokens, would end the same way again.
  it("marks neither a decided check nor one out of budget as worth a second session", async () => {
    const candidate = await candidateOf(report());
    expect(await check(scripted([CONFIRM]), candidate)).toMatchObject({
      effect: "none",
      retryable: false,
    });
    const read = { tool: TOOLS.read, args: { relativePath: "src/total.ts" } };
    const outcome = await check(scripted([read, read, read, CONFIRM]), candidate, {
      limits: { maxToolCalls: 2 },
    });
    expect(outcome).toMatchObject({ effect: "budget-exhausted", retryable: false });
  });
});
