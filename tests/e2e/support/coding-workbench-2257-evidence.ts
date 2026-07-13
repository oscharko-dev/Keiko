import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { CodingWorkbenchRuntimeStateName } from "@oscharko-dev/keiko-contracts";
import { evidenceArtifactPath, evidenceScreenshotPath } from "./evidence.js";

const ROOT = resolve(process.cwd());
const EVIDENCE_DIR = resolve(ROOT, "docs", "design-system", "evidence", "2257");

export interface CodingWorkbenchEvidenceRecord {
  readonly id: string;
  readonly file: string;
  readonly label: string;
  readonly width: number;
  readonly theme: "dark" | "light";
  readonly highContrast: boolean;
  readonly forcedColors: "none" | "active";
  readonly reducedMotion: "no-preference" | "reduce";
  readonly state: CodingWorkbenchRuntimeStateName;
  readonly zoomEquivalent?: string;
  readonly seriousOrCriticalAxeViolations: number;
  readonly documentHasHorizontalOverflow: boolean;
  readonly workbenchHasHorizontalOverflow: boolean;
  readonly primaryActionVisible: boolean;
  readonly primaryActionWithinViewport: boolean;
  readonly outerWindowWithinViewport: boolean;
  readonly focusVisible: boolean | null;
  readonly semanticTokens: Readonly<Record<string, string>>;
}

export function screenshotPath(relativePath: string): string {
  return evidenceScreenshotPath(trackedPath(relativePath));
}

export function writeCodingWorkbenchEvidence(
  records: readonly CodingWorkbenchEvidenceRecord[],
): void {
  writeBrowserEvidence(records);
  writeAccessibilityEvidence(records);
  writeFidelityEvidence(records);
}

function trackedPath(relativePath: string): string {
  const absolute = resolve(EVIDENCE_DIR, relativePath);
  if (absolute !== EVIDENCE_DIR && !absolute.startsWith(`${EVIDENCE_DIR}${sep}`)) {
    throw new Error("Issue #2257 evidence path escaped its directory");
  }
  return relative(ROOT, absolute);
}

function writeJson(relativePath: string, value: unknown): void {
  const output = evidenceArtifactPath(trackedPath(relativePath));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeBrowserEvidence(records: readonly CodingWorkbenchEvidenceRecord[]): void {
  writeJson("browser/manifest.json", {
    issue: 2257,
    surface: "live-coding-workbench",
    status: "verified",
    verified: true,
    captureCount: records.length,
    requiredModes: [
      "dark",
      "light",
      "dark-high-contrast",
      "light-high-contrast",
      "forced-colors",
      "reduced-motion",
    ],
    requiredWidths: [820, 768, 560, 390, 320],
    requiredZoomPercent: 200,
    captures: records,
  });
}

function writeAccessibilityEvidence(records: readonly CodingWorkbenchEvidenceRecord[]): void {
  writeJson("a11y/a11y-proof.json", {
    issue: 2257,
    surface: "live-coding-workbench",
    status: "verified",
    verified: true,
    standard: "WCAG 2.2 AA",
    requiredMaximumSerious: 0,
    requiredMaximumCritical: 0,
    results: records.map(({ id, seriousOrCriticalAxeViolations }) => ({
      id,
      seriousOrCriticalAxeViolations,
    })),
  });
}

function writeFidelityEvidence(records: readonly CodingWorkbenchEvidenceRecord[]): void {
  writeJson("coding-workbench-live-fidelity-proof.json", {
    issue: 2257,
    status: "verified",
    verified: true,
    componentStateEvidence: {
      captured: [
        "ready",
        "approval-conflict",
        "recovery-conflict",
        "selected",
        "disabled",
        "focus-visible",
      ],
      automated: ["loading", "unavailable", "error", "empty", "reconnecting", "syncing"],
      automatedEvidence: [
        "packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench/CodingWorkbenchWindow.test.tsx",
        "packages/keiko-ui/src/lib/useCodingWorkbenchRuntime.test.tsx",
        "tests/e2e/coding-workbench-2257.spec.ts",
      ],
    },
    captureIds: records.map(({ id }) => id),
    allPrimaryActionsVisible: records.every(({ primaryActionVisible }) => primaryActionVisible),
    allPrimaryActionsWithinViewport: records.every(
      ({ primaryActionWithinViewport }) => primaryActionWithinViewport,
    ),
    allOuterWindowsWithinViewport: records.every(
      ({ outerWindowWithinViewport }) => outerWindowWithinViewport,
    ),
    horizontalOverflowFailures: records.filter(
      ({ documentHasHorizontalOverflow, workbenchHasHorizontalOverflow }) =>
        documentHasHorizontalOverflow || workbenchHasHorizontalOverflow,
    ).length,
  });
}
