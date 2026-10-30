// The review profile's pieces inside the coding runtime (ADR-0182 D2/D4, Issue #4135): the
// `review-report` wire action, the launch environment's server-owned binding of the review agent,
// the generated report tool, the facade's acknowledgement projection and the catalog coverage.

import { describe, expect, it } from "vitest";
import { REVIEW_RUNTIME_AGENT_NAME } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";

import { createCanonicalOpenCodeHandlerCoverage } from "../tool-catalog/catalogToolFacadeBridge.js";
import { createCodingToolFacade } from "./codingToolFacade.js";
import {
  codingToolRequiredActionClasses,
  parseCodingToolRequest,
  REVIEW_REPORT_MAX_BYTES,
} from "./codingToolIpc.js";
import { buildOpenCodeLaunchProfile } from "./opencodeLaunchProfile.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";
import { REVIEW_SYSTEM_PROMPT } from "../review/runtime/reviewPrompt.js";
import { reviewRunRefusesAction } from "./reviewRuntimeGuard.js";

const GEOMETRY = { contextWindowTokens: 32_768, maxInputTokens: 28_672, maxOutputTokens: 4_096 };
const identity = { actionId: "action-1", idempotencyKey: "key-1" } as const;

describe("review-report wire action", () => {
  it("parses one report object under the exact keys and needs workspace-read only", () => {
    const body = JSON.stringify({ ...identity, action: "review-report", report: { title: "x" } });
    const parsed = parseCodingToolRequest(body, 64 * 1024);
    expect(parsed).toEqual({ ...identity, action: "review-report", report: { title: "x" } });
    if (parsed === undefined) throw new Error("expected a request");
    expect(codingToolRequiredActionClasses(parsed)).toEqual(["workspace-read"]);
  });

  it("refuses a report that is not an object or carries other keys", () => {
    for (const value of [
      { ...identity, action: "review-report", report: "text" },
      { ...identity, action: "review-report", report: [] },
      { ...identity, action: "review-report", report: {}, extra: 1 },
      { ...identity, action: "review-report" },
      {
        ...identity,
        action: "review-report",
        report: { title: "x".repeat(REVIEW_REPORT_MAX_BYTES) },
      },
      { ...identity, action: "review-report", report: { a: { b: { c: { d: { e: 1 } } } } } },
    ]) {
      expect(parseCodingToolRequest(JSON.stringify(value), 128 * 1024)).toBeUndefined();
    }
  });
});

describe("review launch environment", () => {
  it("pins the review agent, its prompt and the permission floor as server-owned configuration", () => {
    const profile = buildOpenCodeLaunchProfile({
      executable: "/opt/keiko/opencode",
      stateRoot: "/var/keiko/review-runtime/run-1",
      contextGeometry: GEOMETRY,
      toolProfile: "review",
    });
    if (!profile.ok) throw new Error("expected a launch profile");
    const binding = JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT ?? "{}") as Record<
      string,
      unknown
    >;
    expect(binding.default_agent).toBe(REVIEW_RUNTIME_AGENT_NAME);
    expect(JSON.stringify(binding.agents)).toContain(JSON.stringify(REVIEW_SYSTEM_PROMPT));
    expect(binding.permissions).toEqual(profile.configValue.permissions);
    expect(binding.instructions).toEqual([]);
    expect(profile.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
    expect(profile.env.npm_config_offline).toBe("true");
  });

  it("failure-first: the governed coding profile writes no server-owned agent binding", () => {
    const profile = buildOpenCodeLaunchProfile({
      executable: "/opt/keiko/opencode",
      stateRoot: "/var/keiko/coding/run-1",
      contextGeometry: GEOMETRY,
      toolProfile: "direct",
    });
    expect(profile.ok && profile.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });
});

describe("generated keiko_review_report tool", () => {
  it("sends the model's report as one report object to the review-report wire action", () => {
    const source = createGeneratedOpenCodeV2Plugins("review").keiko_governed_tools ?? "";
    const reportTool = source.slice(source.indexOf("function register_keiko_review_report"));
    expect(reportTool).toContain('const wireAction = "review-report";');
    expect(reportTool).toContain("request.report[name] = args[name]; delete request[name];");
  });
});

describe("review report acknowledgement projection", () => {
  function facade(outcome: unknown): ReturnType<typeof createCodingToolFacade> {
    return createCodingToolFacade({
      authority: { admit: () => ({ ok: true, mutationGuard: { check: () => true } }) },
      delegate: { execute: () => Promise.resolve(outcome) },
    });
  }
  const body = JSON.stringify({ ...identity, action: "review-report", report: {} });

  it("hands the model the closed acknowledgement", async () => {
    const result = await facade({
      outcome: "completed",
      reviewReport: { status: "rejected", reason: "range-invalid" },
    }).execute({ body, capability: "c" });
    expect(result).toMatchObject({
      status: "completed",
      reviewReport: { status: "rejected", reason: "range-invalid" },
    });
  });

  it("collapses anything else the port returned to a failure", async () => {
    for (const outcome of [
      { outcome: "completed" },
      { outcome: "completed", reviewReport: { status: "approved" } },
      { outcome: "completed", reviewReport: "accepted" },
    ]) {
      const result = await facade(outcome).execute({ body, capability: "c" });
      expect(result.status).toBe("failed");
    }
  });
});

describe("review catalog coverage and guard", () => {
  it("offers exactly the four review tools as ready in the review profile's coverage", () => {
    const coverage = createCanonicalOpenCodeHandlerCoverage(new Set(), "review");
    expect([...coverage.readinessByToolId.entries()].sort()).toEqual([
      ["keiko.repo.search", "ready"],
      ["keiko.review.report", "ready"],
      ["keiko.workspace.discover", "ready"],
      ["keiko.workspace.read", "ready"],
    ]);
  });

  it("refuses every non-read action for a review run and nothing for a coding run", () => {
    for (const action of ["edit", "command", "git", "delivery", "egress", "child-agent"] as const) {
      expect(reviewRunRefusesAction("review", { action })).toBe(true);
      expect(reviewRunRefusesAction(undefined, { action })).toBe(false);
      expect(reviewRunRefusesAction("coding", { action })).toBe(false);
    }
    for (const action of ["read", "discover", "search", "review-report"] as const) {
      expect(reviewRunRefusesAction("review", { action })).toBe(false);
    }
  });
});
