// Dispatcher for Quality Intelligence export-bundle serialisation (Epic #270, Issue #283).
//
// Pure-domain leaf. Pre-asserts the contract invariant on the bundle, then dispatches
// to the format-specific adapter. The dispatch table is `satisfies` typed so every
// `QualityIntelligenceExportFormat` MUST have a registered adapter — adding a new
// format is a compile error here, by design.

import type {
  QualityIntelligenceExportBundle,
  QualityIntelligenceTestCaseCandidate,
} from "@oscharko-dev/keiko-contracts";
import { assertExportBundleInvariant } from "@oscharko-dev/keiko-contracts";

import { adaptToAlm } from "./adapters/alm.js";
import { adaptToCsv } from "./adapters/csv.js";
import { adaptToJiraIssues } from "./adapters/jira.js";
import { adaptToJson } from "./adapters/json.js";
import { adaptToPolarion } from "./adapters/polarion.js";
import { adaptToQtest } from "./adapters/qtest.js";
import { adaptToSpreadsheetSafeCsv } from "./adapters/spreadsheetSafeCsv.js";
import { adaptToXray } from "./adapters/xray.js";
import { getExportFormatDescriptor } from "./formats.js";
import type { QualityIntelligenceExportFormat } from "./formats.js";

export interface SerializedExportBundle {
  readonly format: QualityIntelligenceExportFormat;
  readonly body: string;
  readonly byteLen: number;
}

type AdapterFn = (
  bundle: QualityIntelligenceExportBundle,
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
) => string;

const DISPATCH: Readonly<Record<QualityIntelligenceExportFormat, AdapterFn>> = Object.freeze({
  "jira-issues": adaptToJiraIssues,
  qtest: adaptToQtest,
  xray: adaptToXray,
  polarion: adaptToPolarion,
  alm: adaptToAlm,
  csv: adaptToCsv,
  json: adaptToJson,
  "spreadsheet-safe-csv": adaptToSpreadsheetSafeCsv,
});

/**
 * Serialise an export bundle by dispatching on `bundle.targetAdapter`. The contract
 * invariant is asserted up front (TMS-bound bundles MUST carry
 * `redactionAttested === true`) before any adapter is invoked.
 *
 * `byteLen` is the UTF-8 byte length of the body — what an evidence side-file would
 * persist, which is what callers downstream need for capacity accounting.
 */
export function serializeExportBundle(
  bundle: QualityIntelligenceExportBundle,
  candidates: readonly QualityIntelligenceTestCaseCandidate[],
): SerializedExportBundle {
  assertExportBundleInvariant(bundle);
  const format: QualityIntelligenceExportFormat = bundle.targetAdapter;
  // The dispatch table is total over the format union; the indirection makes a
  // future format addition a compile-time failure here.
  const adapter = DISPATCH[format];
  // Pre-touch the descriptor so a missing format mapping shows up as a clear
  // runtime error rather than `undefined` propagating. Pure lookup, no side effect.
  getExportFormatDescriptor(format);
  const body = adapter(bundle, candidates);
  // TextEncoder is a Web-standard global (no node:* import); identical UTF-8 byte
  // length to Buffer.byteLength but keeps this leaf free of node:* surface so the
  // purity guard rule does not need to be widened for the export sub-namespace.
  const byteLen = new TextEncoder().encode(body).length;
  return { format, body, byteLen };
}
