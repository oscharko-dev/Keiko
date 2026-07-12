import { resolve } from "node:path";
import type { FullResult, Reporter } from "@playwright/test/reporter";
import { settleMaintainerEvidence } from "./maintainer-review-2075-reporter.js";

export default class MaintainerPublicationEvidenceReporter implements Reporter {
  onEnd(result: FullResult): void {
    settleMaintainerEvidence(
      resolve("docs/design-system/evidence/2076"),
      result.status === "passed",
    );
  }
}
