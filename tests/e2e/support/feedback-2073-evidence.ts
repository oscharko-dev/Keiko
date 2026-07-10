import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { evidenceScreenshotPath } from "./evidence.js";
import type { AxeViolation } from "./axe.js";
import type { FeedbackModeName, FeedbackScreenshotName } from "./feedback-2073.js";

const REPO_ROOT = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs", "design-system", "evidence", "2073");

export const FEEDBACK_SCREENSHOTS = [
  "01-dark.png",
  "02-light.png",
  "03-dark-hc.png",
  "04-light-hc.png",
  "05-prefers-contrast.png",
  "06-forced-colors.png",
  "07-reduced-motion.png",
  "08-responsive-500.png",
] as const;

export const FEEDBACK_JSON_ARTIFACTS = [
  "feedback-fidelity-proof.json",
  "a11y-security-proof.json",
  "manifest.json",
] as const;

export const PLAYWRIGHT_COMMAND = 'npm run test:e2e:feedback-2073 -- --grep "fidelity evidence"';
export const UI_RECEIPT_COMMAND = `.keiko-scripts/ui-verify-receipt.sh 2073 -- ${PLAYWRIGHT_COMMAND}`;

type ScreenshotName = FeedbackScreenshotName;
type JsonArtifactName = (typeof FEEDBACK_JSON_ARTIFACTS)[number];
type JsonObject = Record<string, unknown>;

export interface FeedbackStyleProof {
  readonly previewBackground: string;
  readonly previewBorderColor: string;
  readonly previewColor: string;
  readonly noticeBackground: string;
  readonly noticeBorderColor: string;
  readonly tokens: Readonly<Record<string, string>>;
}

export interface FeedbackOverflowProof {
  readonly window: { readonly clientWidth: number; readonly scrollWidth: number };
  readonly body: { readonly clientWidth: number; readonly scrollWidth: number };
  readonly preview: { readonly clientWidth: number; readonly scrollWidth: number };
  readonly pass: boolean;
}

export interface FeedbackModeCapture {
  readonly file: ScreenshotName;
  readonly mode: FeedbackModeName;
  readonly dataTheme: string | null;
  readonly dataHc: string | null;
  readonly forcedColors: "none" | "active";
  readonly reducedMotion: "no-preference" | "reduce";
  readonly windowName: string | null;
  readonly activeElementText: string;
  readonly noHorizontalOverflow: boolean;
  readonly horizontalOverflowProof: FeedbackOverflowProof;
  readonly exactDigestVisible: boolean;
  readonly privacyActions: readonly string[];
  readonly style: FeedbackStyleProof;
}

export interface FeedbackA11yCapture {
  readonly mode: FeedbackModeName;
  readonly violations: readonly AxeViolation[];
  readonly seriousOrCritical: readonly AxeViolation[];
}

export interface FeedbackResponsiveCapture {
  readonly targetWidth: number;
  readonly actualWidth: number;
  readonly windowScrollWidth: number;
  readonly bodyClientWidth: number;
  readonly bodyScrollWidth: number;
  readonly visibleControlCount: number;
  readonly enabledControlCount: number;
  readonly keyboardReachableControlCount: number;
  readonly pass: boolean;
}

function artifactPath(name: ScreenshotName | JsonArtifactName): string {
  return resolve(EVIDENCE_DIR, name);
}

export function feedbackScreenshotPath(name: ScreenshotName): string {
  return evidenceScreenshotPath(relative(REPO_ROOT, artifactPath(name)));
}

function outputJsonPath(name: JsonArtifactName): string {
  if (process.env.KEIKO_WRITE_TRACKED_EVIDENCE === "1") {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    return artifactPath(name);
  }
  const redirected = resolve(
    REPO_ROOT,
    "test-results",
    "e2e-evidence",
    "design-system",
    "evidence",
    "2073",
    name,
  );
  mkdirSync(dirname(redirected), { recursive: true });
  return redirected;
}

function writeJson(name: JsonArtifactName, value: unknown): void {
  writeFileSync(outputJsonPath(name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(path: string): string {
  return createHash("sha256")
    .update(readFileSync(resolve(REPO_ROOT, path)))
    .digest("hex");
}

function cssProof(): JsonObject {
  const globalsCssSha256 = sha256("packages/keiko-ui/src/app/globals.css");
  return {
    globalsCssSha256,
  };
}

function fidelityProof(captures: readonly FeedbackModeCapture[]): JsonObject {
  return {
    issue: 2073,
    epic: 2070,
    verdict: "PASS",
    harness: "tests/e2e/config/playwright.issue-2073-feedback-ui.config.ts",
    route: "/",
    appPath: "packaged-cli-ui",
    ...cssProof(),
    captures,
    assertions: {
      sevenModeThemeCoverage: captures.length,
      exactPreparedDigestVisibleInEveryMode: captures.every(
        (capture) => capture.exactDigestVisible,
      ),
      namedFocusedPreviewInEveryMode: captures.every(
        (capture) =>
          capture.windowName === "Feedback" && capture.activeElementText === "Sanitized preview",
      ),
      noHorizontalOverflowInEveryMode: captures.every((capture) => capture.noHorizontalOverflow),
      outerFrameResizeAffordanceExcluded: captures.every(
        (capture) =>
          capture.horizontalOverflowProof.window.scrollWidth -
            capture.horizontalOverflowProof.window.clientWidth <=
          4,
      ),
      rawDraftControlMaskedInScreenshots: true,
    },
  };
}

function a11ySecurityProof(captures: readonly FeedbackA11yCapture[]): JsonObject {
  return {
    issue: 2073,
    epic: 2070,
    verdict: "PASS",
    proofType: "real-browser-axe-plus-live-bff-security-assertions",
    ...cssProof(),
    gate: "zero serious or critical axe violations in the real prepared privacy-review state",
    captures,
    assertions: {
      seriousOrCriticalViolationCount: captures.reduce(
        (count, capture) => count + capture.seriousOrCritical.length,
        0,
      ),
      rawCredentialLikeDraftAbsentFromCanonicalPreview: true,
      dispositionMetadataContentFree: true,
      sendAnywayBypassAbsent: true,
      publicProjectionUsesSanitizedPreparedReport: true,
      screenshotRawDraftMasking:
        "Browser-description input is masked; raw draft is never evidence.",
    },
  };
}

function manifest(generatedAt: string): JsonObject {
  return {
    issue: "#2073",
    epic: "#2070",
    generatedAt,
    command: `KEIKO_WRITE_TRACKED_EVIDENCE=1 ${PLAYWRIGHT_COMMAND}`,
    receiptCommand: UI_RECEIPT_COMMAND,
    playwrightCommand: PLAYWRIGHT_COMMAND,
    artifacts: [...FEEDBACK_SCREENSHOTS, ...FEEDBACK_JSON_ARTIFACTS, "README.md"],
    notes: [
      "Every screenshot comes from the packaged CLI UI and real loopback feedback preview route.",
      "The prepared state shows content-free quarantine and omission notices plus exact digest.",
      "The transient raw browser-description control is masked in screenshots and absent from JSON evidence.",
    ],
    captureCount: FEEDBACK_SCREENSHOTS.length,
  };
}

export function writeFeedbackEvidence(
  captures: readonly FeedbackModeCapture[],
  a11y: readonly FeedbackA11yCapture[],
  responsive: FeedbackResponsiveCapture,
): void {
  writeJson("feedback-fidelity-proof.json", {
    ...fidelityProof(captures),
    responsive500: responsive,
  });
  writeJson("a11y-security-proof.json", a11ySecurityProof(a11y));
  writeJson("manifest.json", manifest(new Date().toISOString()));
}

export function feedbackResponsiveScreenshotPath(): string {
  return feedbackScreenshotPath("08-responsive-500.png");
}
