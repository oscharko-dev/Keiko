// Oracle of the report journey S13 (epic #4173, #4174, #4181). Two effects of a finished report are
// graded against what the laboratory itself can read:
//   - the local export (CSV and Markdown) the user downloads from the report card: the CSV must list
//     exactly the issues Jira holds and carry the digest of the report the tool returned;
//   - the Jira comment: it must be the comment text the report tool computed, verbatim, so a
//     model's own prose can never stand in for the computed figures.
import { Buffer } from "node:buffer";
import { completedToolExchange } from "./tool-exchanges.mjs";

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const DIGEST = /^[0-9a-f]{64}$/;

/** The finished reports of the turn: the completed `jira.report` results that carry their digest. */
export function finishedReports(exchanges) {
  return (Array.isArray(exchanges) ? exchanges : [])
    .filter((exchange) => completedToolExchange(exchange, "jira.report"))
    .map((exchange) => exchange.result.data)
    .filter(
      (data) =>
        isRecord(data) &&
        data.outcome === "succeeded" &&
        data.status === "complete" &&
        typeof data.reportId === "string" &&
        typeof data.report?.digest === "string" &&
        DIGEST.test(data.report.digest),
    )
    .map((data) => ({
      reportId: data.reportId,
      digest: data.report.digest,
      issuesRead: data.report.completeness?.issuesRead,
    }));
}

/** The comment texts the report tool computed in the turn, with the report each belongs to. */
export function computedCommentTexts(exchanges) {
  return (Array.isArray(exchanges) ? exchanges : [])
    .filter((exchange) => completedToolExchange(exchange, "jira.report"))
    .map((exchange) => exchange.result.data)
    .filter(
      (data) =>
        isRecord(data) &&
        data.outcome === "succeeded" &&
        isRecord(data.section) &&
        data.section.name === "comment" &&
        typeof data.section.text === "string",
    )
    .map((data) => ({ reportId: data.reportId, text: data.section.text }));
}

const normalizedText = (text) => text.replaceAll("\r\n", "\n").trim();

/**
 * Grades the Jira comments added during the turn: exactly one, and it is the computed comment text
 * of a finished report of the turn (whose digest it names).
 */
export function gradeReportComment(newComments, texts, reports) {
  const body = newComments.length === 1 ? normalizedText(newComments[0].body ?? "") : undefined;
  const text = texts.find((candidate) => normalizedText(candidate.text) === body);
  const report = reports.find((candidate) => candidate.reportId === text?.reportId);
  const named = report !== undefined && body.includes(`digest ${report.digest}`);
  return {
    ok: text !== undefined && named,
    newComments: newComments.length,
    computedTexts: texts.length,
    report,
  };
}

// ---------- the exports ----------

const CSV_CELL = /("(?:[^"]|"")*"|[^",\r\n]*)(,|\r\n|\n|\r|$)/gy;

/** RFC 4180 records of a CSV text (a leading byte order mark is dropped). */
export function parseCsv(text) {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const cells = new RegExp(CSV_CELL);
  const records = [];
  let record = [];
  while (cells.lastIndex < source.length) {
    const match = cells.exec(source);
    if (match === null) throw new TypeError("Malformed CSV export");
    const [, cell, separator] = match;
    record.push(cell.startsWith('"') ? cell.slice(1, -1).replaceAll('""', '"') : cell);
    if (separator !== ",") {
      records.push(record);
      record = [];
    }
  }
  return records;
}

const fileFacts = (file, format) =>
  isRecord(file) &&
  file.format === format &&
  typeof file.content === "string" &&
  file.byteCount === Buffer.byteLength(file.content, "utf8");

/**
 * The CSV export must be the report the tool returned (same digest) and list exactly the issues of
 * the project as Jira holds them: one `issue` record per key, none missing, none invented.
 */
export function gradeCsvExport(file, digest, jiraKeys) {
  if (!fileFacts(file, "csv")) return { ok: false, reason: "not a CSV export file" };
  const records = parseCsv(file.content);
  const report = records.find((record) => record[0] === "report");
  const keys = records.filter((record) => record[0] === "issue").map((record) => record[1]);
  const expected = new Set(jiraKeys);
  const missing = [...expected].filter((key) => !keys.includes(key));
  const invented = keys.filter((key) => !expected.has(key));
  const duplicated = keys.length - new Set(keys).size;
  const digestOk = file.reportDigest === digest && report?.[1] === digest;
  return {
    ok: digestOk && missing.length === 0 && invented.length === 0 && duplicated === 0,
    reason: `${keys.length}/${expected.size} issues, ${missing.length} missing, ${invented.length} invented, ${duplicated} duplicated, digest ${digestOk ? "matches" : "differs"}`,
  };
}

const REPORT_SECTIONS = ["## Progress", "## Epics and containers", "## Compliance", "## Coverage"];
const CATEGORIES = ["new", "indeterminate", "done"];

/**
 * What the laboratory reads from Jira itself about the reported issues: their keys, the epic keys
 * and the issue count per status category (`noCategory` for a status without one).
 */
export function jiraReportFacts(issues) {
  const category = (issue) => issue.fields?.status?.statusCategory?.key;
  const count = (key) => issues.filter((issue) => category(issue) === key).length;
  return {
    keys: issues.map((issue) => issue.key),
    epicKeys: issues
      .filter((issue) => issue.fields?.issuetype?.name === "Epic")
      .map((issue) => issue.key),
    byCategory: [
      ...CATEGORIES.map(count),
      issues.filter((issue) => !CATEGORIES.includes(category(issue))).length,
    ],
  };
}

/** The lines under `heading` up to the next heading of the same level. */
function sectionOf(content, heading) {
  const lines = content.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/**
 * The Markdown export must be the report the tool returned (same digest) and say what Jira holds:
 * every report section, all issues read, the project's issue count per status category and every
 * epic. A digest alone does not prove the download carries the report.
 */
export function gradeMarkdownExport(file, digest, facts) {
  if (!fileFacts(file, "markdown")) return { ok: false, reason: "not a Markdown export file" };
  const content = file.content.replaceAll(/\\(.)/gu, "$1");
  const total = facts.keys.length;
  const checks = {
    digest: file.reportDigest === digest && content.includes(`Report digest: ${digest}`),
    sections: REPORT_SECTIONS.every((heading) => content.split("\n").includes(heading)),
    issuesRead: content.includes(`${String(total)} of ${String(total)} issues read`),
    progress: content.includes(`| Project | ${[total, ...facts.byCategory].join(" | ")} |`),
    epics: facts.epicKeys.every((key) =>
      new RegExp(String.raw`^\| ${key} \|`, "mu").test(
        sectionOf(content, "## Epics and containers"),
      ),
    ),
  };
  const failed = Object.keys(checks).filter((name) => !checks[name]);
  return {
    ok: failed.length === 0,
    reason:
      failed.length === 0
        ? "report sections and figures match Jira"
        : `differs: ${failed.join(", ")}`,
  };
}
