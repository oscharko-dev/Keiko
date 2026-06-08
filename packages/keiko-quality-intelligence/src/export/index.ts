// Public barrel for the Quality Intelligence export sub-namespace (Epic #270, Issue #283).
//
// Pure-domain leaf. NO IO, NO HTTP, NO provider SDK imports, NO new runtime dependency.
// Adapters consume `QualityIntelligenceExportBundle` + `QualityIntelligenceTestCaseCandidate`
// from `@oscharko-dev/keiko-contracts` and produce typed serialised bodies. Persistence of
// these bodies is owned by `@oscharko-dev/keiko-evidence` via the side-file primitive — this
// layer never touches `node:fs`.

export {
  QUALITY_INTELLIGENCE_EXPORT_FORMAT_TABLE,
  getExportFormatDescriptor,
  type QualityIntelligenceExportFormat,
  type QualityIntelligenceExportFormatDescriptor,
} from "./formats.js";

export {
  adaptToAlm,
  adaptToCsv,
  adaptToJiraIssues,
  adaptToJson,
  adaptToMarkdown,
  adaptToPlainText,
  adaptToPolarion,
  adaptToQtest,
  adaptToQualityCenter,
  adaptToSpreadsheetSafeCsv,
  adaptToXray,
  ALM_CSV_HEADERS,
  CSV_HEADERS,
  encodeSpreadsheetSafeCell,
  encodeSpreadsheetSafeRow,
  JIRA_CSV_HEADERS,
  POLARION_CSV_HEADERS,
  QTEST_CSV_HEADERS,
  SPREADSHEET_FORMULA_LEAD_CHARS,
  SPREADSHEET_SAFE_CSV_HEADERS,
  startsWithFormulaLead,
  XRAY_CSV_HEADERS,
} from "./adapters/index.js";

export { serializeExportBundle, type SerializedExportBundle } from "./serialize.js";
