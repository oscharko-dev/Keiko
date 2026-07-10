import type { FeedbackReportV1 } from "@oscharko-dev/keiko-contracts/feedback-report";
import { describe, expect, it } from "vitest";

import { feedbackSecurityRoutingDecisionV1 } from "./feedback-security-routing.js";

function report(title: string, description: string): FeedbackReportV1 {
  return {
    schemaVersion: "1",
    privacyContractVersion: "1",
    redactionProvenance: { engineVersion: "1", rules: [] },
    productVersion: "0.2.14",
    platform: "Linux",
    summary: { title, description },
    steps: "Open Settings and preview the report.",
    expectedResult: "The ordinary feedback flow should continue.",
    actualResult: "The preview was generated.",
    impact: "Degrades core workflow",
    diagnostics: { category: "defect", featureArea: "model-configuration" },
  };
}

function reportWithSemanticField(
  field:
    | "title"
    | "productVersion"
    | "platform"
    | "browserDescription"
    | "description"
    | "steps"
    | "expectedResult"
    | "actualResult"
    | "impact"
    | "handwrittenEvidence"
    | "attachments",
  value: string,
): FeedbackReportV1 {
  const base = report("Ordinary finding", "The ordinary feedback flow stopped.");
  if (field === "title" || field === "description") {
    return { ...base, summary: { ...base.summary, [field]: value } };
  }
  if (field === "attachments") return { ...base, attachments: [value] };
  return { ...base, [field]: value };
}

describe("feedback security routing", () => {
  it.each([
    ["Security vulnerability in Keiko: authentication bypass", "A crafted session bypasses login."],
    ["Login finding", "I found a security vulnerability in Keiko's session validation."],
    ["Parser finding", "A proof-of-concept exploit reaches remote code execution."],
    ["CVE-2026-12345 in Keiko", "The affected version is 0.2.14."],
    [
      "Security vulnerability in Keiko: documentation endpoint leaks private data",
      "A private response is exposed.",
    ],
    ["Authentication bypass in Keiko documentation endpoint", "A crafted session is accepted."],
    ["Parser finding", "Keiko is affected by CVE-2026-12345 in the documentation parser."],
  ])("routes a supported high-confidence report privately", (title, description) => {
    expect(feedbackSecurityRoutingDecisionV1(report(title, description))).toEqual({
      route: "private-security-advisory",
      reason: "high-confidence-vulnerability-report",
    });
  });

  it.each([
    ["Password reset feedback", "The password policy text is difficult to understand."],
    ["Security documentation", "Explain vulnerability scanning and responsible disclosure."],
    ["Training copy", "Our guide discusses SQL injection and cross-site scripting examples."],
    ["CVE formatting", "Use CVE-2026-12345 as a documentation example."],
    ["Login copy", "The authentication bypass article should open in a new tab."],
    ["SQL injection documentation", "The training page needs a clearer example."],
    ["CVE-formatting bug", "The validation copy uses the wrong punctuation."],
    ["CVE-2026-12345 documentation link broken", "The documentation route returns 404."],
    ["Security vulnerability in Keiko documentation link broken", "The guide returns 404."],
    ["SQL injection in Keiko documentation link broken", "The training guide returns 404."],
    ["CVE-2026-12345 in Keiko documentation link broken", "The advisory link returns 404."],
  ])("keeps ordinary security discussion in feedback", (title, description) => {
    expect(feedbackSecurityRoutingDecisionV1(report(title, description))).toEqual({
      route: "ordinary-feedback",
    });
  });

  it.each([
    "title",
    "productVersion",
    "platform",
    "browserDescription",
    "description",
    "steps",
    "expectedResult",
    "actualResult",
    "impact",
    "handwrittenEvidence",
    "attachments",
  ] as const)("scans explicit disclosure grammar in semantic field %s", (field) => {
    const decision = feedbackSecurityRoutingDecisionV1(
      reportWithSemanticField(field, "I found a security vulnerability in Keiko."),
    );

    expect(decision).toEqual({
      route: "private-security-advisory",
      reason: "high-confidence-vulnerability-report",
    });
  });

  it("requires a syntactically valid CVE with explicit Keiko context", () => {
    expect(
      feedbackSecurityRoutingDecisionV1(
        report("Release regression", "Keiko is affected by CVE-2026-12345."),
      ),
    ).toEqual({
      route: "private-security-advisory",
      reason: "high-confidence-vulnerability-report",
    });
    expect(
      feedbackSecurityRoutingDecisionV1(report("CVE-", "The CVE- label is truncated.")),
    ).toEqual({ route: "ordinary-feedback" });
    expect(
      feedbackSecurityRoutingDecisionV1(
        report("Release regression", "Keiko is affected by CVE-2026-123."),
      ),
    ).toEqual({ route: "ordinary-feedback" });
  });

  it("returns only a closed content-free decision", () => {
    const sentinel = "private-exploit-payload-must-not-be-reflected";
    const decision = feedbackSecurityRoutingDecisionV1(
      report("Exploit: session validation", `A proof-of-concept exploit contains ${sentinel}.`),
    );

    expect(JSON.stringify(decision)).not.toContain(sentinel);
    expect(Object.keys(decision).sort()).toEqual(["reason", "route"]);
  });
});
