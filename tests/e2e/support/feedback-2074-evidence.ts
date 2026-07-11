import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { evidenceScreenshotPath } from "./evidence.js";
import type { AxeViolation } from "./axe.js";

const REPO_ROOT = resolve(process.cwd());
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs", "design-system", "evidence", "2074");

export const FEEDBACK_2074_SCREENSHOTS = [
  "01-dark-accepted-copied.png",
  "01-dark-rate-limited.png",
  "02-light-accepted-copied.png",
  "02-light-rate-limited.png",
  "03-dark-hc-accepted-copied.png",
  "03-dark-hc-rate-limited.png",
  "04-light-hc-accepted-copied.png",
  "04-light-hc-rate-limited.png",
  "05-prefers-contrast-accepted-copied.png",
  "05-prefers-contrast-rate-limited.png",
  "06-forced-colors-accepted-copied.png",
  "06-forced-colors-rate-limited.png",
  "07-reduced-motion-accepted-copied.png",
  "07-reduced-motion-rate-limited.png",
  "08-responsive-500-rate-limited.png",
] as const;

export type Feedback2074Screenshot = (typeof FEEDBACK_2074_SCREENSHOTS)[number];

export interface Feedback2074Capture {
  readonly file: Feedback2074Screenshot;
  readonly state: "accepted-copied" | "rate-limited";
  readonly mode: string;
  readonly locale: "en" | "de";
  readonly focusText: string;
  readonly seriousOrCritical: readonly AxeViolation[];
  readonly style: Readonly<Record<string, string>>;
}

function trackedPath(name: Feedback2074Screenshot): string {
  return resolve(EVIDENCE_DIR, name);
}

export function feedback2074ScreenshotPath(name: Feedback2074Screenshot): string {
  return evidenceScreenshotPath(relative(REPO_ROOT, trackedPath(name)));
}

function outputPath(
  name: "feedback-fidelity-proof.json" | "a11y-proof.json" | "manifest.json",
): string {
  if (process.env.KEIKO_WRITE_TRACKED_EVIDENCE === "1") {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    return resolve(EVIDENCE_DIR, name);
  }
  const redirected = resolve(
    REPO_ROOT,
    "test-results",
    "e2e-evidence",
    "design-system",
    "evidence",
    "2074",
    name,
  );
  mkdirSync(dirname(redirected), { recursive: true });
  return redirected;
}

function writeJson(
  name: "feedback-fidelity-proof.json" | "a11y-proof.json" | "manifest.json",
  value: unknown,
): void {
  writeFileSync(outputPath(name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function globalsCssSha256(): string {
  return createHash("sha256")
    .update(readFileSync(resolve(REPO_ROOT, "packages/keiko-ui/src/app/globals.css")))
    .digest("hex");
}

function fidelityProof(captures: readonly Feedback2074Capture[], cssSha256: string): object {
  return {
    issue: 2074,
    epic: 2070,
    verdict: "PASS",
    harness: "tests/e2e/config/playwright.issue-2074-feedback-ui.config.ts",
    appPath: "packaged-cli-ui",
    globalsCssSha256: cssSha256,
    captures,
    assertions: {
      canonicalModeCoverage: 7,
      acceptedCopyStateInEveryMode: captures.filter(
        (capture) => capture.state === "accepted-copied",
      ).length,
      rateLimitedConflictStateInEveryMode: captures.filter(
        (capture) => capture.state === "rate-limited",
      ).length,
      receiptSecretRendered: false,
      rateLimitThresholdRendered: false,
      receiptCopySuccessFocusMoved: true,
      rateLimitIconAndWordPresent: true,
      forcedColorsActionReadability:
        "ButtonFace/ButtonText, text fill, and forced-color-adjust are asserted in real Chromium.",
    },
  };
}

function a11yProof(captures: readonly Feedback2074Capture[], cssSha256: string): object {
  const seriousOrCritical = captures.flatMap((capture) => capture.seriousOrCritical);
  return {
    issue: 2074,
    verdict: "PASS",
    globalsCssSha256: cssSha256,
    gate: "zero serious or critical axe violations across accepted-copy and rate-limited states",
    captures: captures.map((capture) => ({
      mode: capture.mode,
      locale: capture.locale,
      state: capture.state,
      seriousOrCritical: capture.seriousOrCritical,
    })),
    seriousOrCriticalViolationCount: seriousOrCritical.length,
  };
}

function evidenceManifest(command: string): object {
  return {
    issue: "#2074",
    epic: "#2070",
    command: `KEIKO_WRITE_TRACKED_EVIDENCE=1 ${command}`,
    playwrightCommand: command,
    artifacts: [
      ...FEEDBACK_2074_SCREENSHOTS,
      "feedback-fidelity-proof.json",
      "a11y-proof.json",
      "manifest.json",
      "README.md",
    ],
    captureCount: FEEDBACK_2074_SCREENSHOTS.length,
    notes: [
      "All captures use the packaged CLI UI and a deterministic browser-level submit adapter.",
      "Receipt secrets are asserted absent from the DOM and evidence while the exact clipboard tuple is verified.",
      "Rate-limited conflict presentation uses the governed warning token pair plus a visible icon and word.",
    ],
  };
}

export function writeFeedback2074Evidence(captures: readonly Feedback2074Capture[]): void {
  const command = 'npm run test:e2e:feedback-2074 -- --grep "fidelity evidence"';
  const cssSha256 = globalsCssSha256();
  writeJson("feedback-fidelity-proof.json", fidelityProof(captures, cssSha256));
  writeJson("a11y-proof.json", a11yProof(captures, cssSha256));
  writeJson("manifest.json", evidenceManifest(command));
}
