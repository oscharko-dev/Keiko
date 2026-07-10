import type { FeedbackReportV1 } from "@oscharko-dev/keiko-contracts/feedback-report";

export type FeedbackSecurityRoutingDecisionV1 =
  | { readonly route: "ordinary-feedback" }
  | {
      readonly route: "private-security-advisory";
      readonly reason: "high-confidence-vulnerability-report";
    };

const PRIVATE_DECISION = Object.freeze({
  route: "private-security-advisory",
  reason: "high-confidence-vulnerability-report",
} as const);
const ORDINARY_DECISION = Object.freeze({ route: "ordinary-feedback" } as const);

const SECURITY_TITLE_CLASSES = Object.freeze([
  "authentication bypass",
  "authorization bypass",
  "remote code execution",
  "arbitrary code execution",
  "privilege escalation",
  "sql injection",
  "command injection",
  "cross-site scripting",
  "server-side request forgery",
  "path traversal",
]);
const EXPLICIT_DISCLOSURE_PHRASES = Object.freeze([
  "i found a security vulnerability",
  "we found a security vulnerability",
  "i discovered a security vulnerability",
  "we discovered a security vulnerability",
  "this security vulnerability allows",
  "proof-of-concept exploit",
  "proof of concept exploit",
  "working exploit against keiko",
]);

function reportText(report: FeedbackReportV1): readonly string[] {
  return [
    report.productVersion,
    report.platform,
    ...(report.browserDescription === undefined ? [] : [report.browserDescription]),
    report.summary.title,
    report.summary.description,
    report.steps,
    report.expectedResult,
    report.actualResult,
    report.impact,
    ...(report.handwrittenEvidence === undefined ? [] : [report.handwrittenEvidence]),
    ...(report.attachments ?? []),
    report.diagnostics.category,
    report.diagnostics.featureArea,
  ];
}

function includesOne(value: string, signals: readonly string[]): boolean {
  return signals.some((signal) => value.includes(signal));
}

function isNamedSecurityFindingTitle(title: string): boolean {
  return SECURITY_TITLE_CLASSES.some((signal) => title.includes(`${signal} in keiko`));
}

function isDiscussionGrammar(value: string): boolean {
  return [
    "documentation link",
    "documentation example",
    "formatting example",
    "training example",
    "training copy",
    "article should open",
    "security discussion",
    "vulnerability discussion",
  ].some((marker) => value.includes(marker));
}

function hasContextualCve(value: string): boolean {
  const normalized = value.toLowerCase();
  const matches = normalized.matchAll(/\bcve-(?:19|20)\d{2}-\d{4,7}\b/gu);
  for (const match of matches) {
    const identifier = match[0];
    if (
      normalized.includes(`keiko is affected by ${identifier}`) ||
      normalized.includes(`${identifier} affects keiko`)
    ) {
      return true;
    }
    if (normalized.includes(`${identifier} in keiko`) && !isDiscussionGrammar(normalized)) {
      return true;
    }
  }
  return false;
}

function hasExplicitDisclosure(value: string): boolean {
  const normalized = value.toLowerCase();
  return includesOne(normalized, EXPLICIT_DISCLOSURE_PHRASES) || hasContextualCve(normalized);
}

export function feedbackSecurityRoutingDecisionV1(
  report: FeedbackReportV1,
): FeedbackSecurityRoutingDecisionV1 {
  const title = report.summary.title.trim().toLowerCase();
  const explicitPrefix =
    title.startsWith("security vulnerability in keiko:") ||
    title.startsWith("vulnerability in keiko:") ||
    title.startsWith("exploit against keiko:");
  const titleRoutes =
    explicitPrefix || (isNamedSecurityFindingTitle(title) && !isDiscussionGrammar(title));
  const proseRoutes = reportText(report).some(hasExplicitDisclosure);
  return titleRoutes || proseRoutes ? PRIVATE_DECISION : ORDINARY_DECISION;
}
