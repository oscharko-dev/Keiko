import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FullResult, Reporter } from "@playwright/test/reporter";

const RECEIPTS = [
  ["a11y-results.json", "a11y-proof.json"],
  ["fidelity-results.json", "fidelity-proof.json"],
] as const;

export function settleMaintainerEvidence(directory: string, passed: boolean): void {
  for (const [draftName, proofName] of RECEIPTS) {
    const draft = resolve(directory, draftName);
    const proof = resolve(directory, proofName);
    if (!passed || !existsSync(draft)) {
      if (existsSync(proof)) unlinkSync(proof);
      if (existsSync(draft)) unlinkSync(draft);
      continue;
    }
    const value = JSON.parse(readFileSync(draft, "utf8")) as Readonly<Record<string, unknown>>;
    writeFileSync(proof, JSON.stringify({ ...value, result: "PASS" }, null, 2));
    unlinkSync(draft);
  }
}

export default class MaintainerEvidenceReporter implements Reporter {
  onEnd(result: FullResult): void {
    settleMaintainerEvidence(
      resolve("docs/design-system/evidence/2075"),
      result.status === "passed",
    );
  }
}
