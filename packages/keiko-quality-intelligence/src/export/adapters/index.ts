// Public barrel for the Quality Intelligence export adapters (Epic #270, Issue #283).
// Pure-domain leaf. Re-exports each adapter alongside its column-header constant so
// downstream consumers and tests have a single import surface.

export { adaptToAlm, ALM_CSV_HEADERS } from "./alm.js";
export { adaptToCsv, CSV_HEADERS } from "./csv.js";
export { adaptToJiraIssues, JIRA_CSV_HEADERS } from "./jira.js";
export { adaptToJson } from "./json.js";
export { adaptToPolarion, POLARION_CSV_HEADERS } from "./polarion.js";
export { adaptToQtest, QTEST_CSV_HEADERS } from "./qtest.js";
export {
  adaptToSpreadsheetSafeCsv,
  encodeSpreadsheetSafeCell,
  encodeSpreadsheetSafeRow,
  SPREADSHEET_FORMULA_LEAD_CHARS,
  SPREADSHEET_SAFE_CSV_HEADERS,
  startsWithFormulaLead,
} from "./spreadsheetSafeCsv.js";
export { adaptToXray, XRAY_CSV_HEADERS } from "./xray.js";
export { adaptToMarkdown } from "./markdown.js";
export { adaptToPlainText } from "./plaintext.js";
export { adaptToQualityCenter } from "./qualityCenter.js";
export {
  adaptToTraceabilityCsv,
  adaptToTraceabilityMarkdown,
  TRACEABILITY_HEADERS,
  type QualityIntelligenceTraceabilityRow,
} from "./traceability.js";
