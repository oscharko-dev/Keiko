import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  JIRA_REPORT_EXPORT_MEDIA_TYPES,
  JIRA_REPORT_ID_PATTERN,
  JIRA_REPORT_IDLE_TTL_MS,
  JIRA_REPORT_OWNER_SESSIONS_MAX,
  JIRA_REPORT_STORE_MAX_BYTES,
  type JiraReportExportFormat,
  type JiraReportExportResponse,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { withImmediateTransaction } from "./transaction.js";

/** Completed download artifacts only. This port cannot resume a Jira read or restore authority. */
export interface StoredJiraReportExports {
  readonly reportId: string;
  readonly owner: string;
  readonly lastUsedAt: number;
  readonly reportDigest: string;
  readonly markdown: string;
  readonly csv: string;
}

export interface JiraReportExportStore {
  readonly put: (record: StoredJiraReportExports) => boolean;
  readonly touch: (reportId: string, owner: string, digest: string, lastUsedAt: number) => boolean;
  /** Downloads do not renew the report's idle lifetime. */
  readonly read: (
    reportId: string,
    owner: string,
    format: JiraReportExportFormat,
  ) => JiraReportExportResponse | undefined;
}

interface StoreOptions {
  readonly now: () => number;
  readonly redactContentString: (value: string) => string;
  readonly maxTotalBytes?: number;
}
interface ExportRow {
  readonly report_digest: string;
  readonly markdown: string;
  readonly csv: string;
  readonly content_digest: string;
  readonly byte_count: number;
}

const REPORT_ID = new RegExp(JIRA_REPORT_ID_PATTERN, "u");
const DIGEST = /^[a-f0-9]{64}$/u;
const METADATA_BYTES = 256;
const retainedBytes = (markdown: string, csv: string): number =>
  Buffer.byteLength(markdown) + Buffer.byteLength(csv) + METADATA_BYTES;

function contentDigest(markdown: string, csv: string): string {
  return createHash("sha256")
    .update(String(Buffer.byteLength(markdown)))
    .update(":")
    .update(markdown)
    .update(csv)
    .digest("hex");
}

function validUse(time: number, now: number): boolean {
  return (
    Number.isSafeInteger(time) && time >= 0 && time <= now && time >= now - JIRA_REPORT_IDLE_TTL_MS
  );
}

function prune(db: DatabaseSync, now: number, limit: number): void {
  db.prepare("DELETE FROM jira_report_exports WHERE last_used_at < ?").run(
    now - JIRA_REPORT_IDLE_TTL_MS,
  );
  const total = (): number =>
    Number(
      db.prepare("SELECT COALESCE(SUM(byte_count), 0) AS bytes FROM jira_report_exports").get()
        ?.bytes,
    );
  while (total() > limit) {
    // The largest owner pays first, as in the report session store; never evict a small neighbor first.
    db.prepare(
      `DELETE FROM jira_report_exports WHERE report_id = (
      SELECT report_id FROM jira_report_exports WHERE chat_id = (
        SELECT chat_id FROM jira_report_exports GROUP BY chat_id
        ORDER BY SUM(byte_count) DESC, chat_id LIMIT 1
      ) ORDER BY last_used_at, report_id LIMIT 1
    )`,
    ).run();
  }
}

function trimOwner(db: DatabaseSync, owner: string): void {
  db.prepare(
    `DELETE FROM jira_report_exports WHERE chat_id = ? AND report_id NOT IN (
    SELECT report_id FROM jira_report_exports WHERE chat_id = ?
    ORDER BY last_used_at DESC, report_id DESC LIMIT ?
  )`,
  ).run(owner, owner, JIRA_REPORT_OWNER_SESSIONS_MAX);
}

function put(db: DatabaseSync, options: StoreOptions, input: StoredJiraReportExports): boolean {
  const now = options.now();
  if (
    !REPORT_ID.test(input.reportId) ||
    !DIGEST.test(input.reportDigest) ||
    !validUse(input.lastUsedAt, now)
  )
    return false;
  const markdown = options.redactContentString(input.markdown);
  const csv = options.redactContentString(input.csv);
  const bytes = retainedBytes(markdown, csv);
  const limit = options.maxTotalBytes ?? JIRA_REPORT_STORE_MAX_BYTES;
  if (bytes > limit) return false;
  return withImmediateTransaction(db, () => {
    prune(db, now, limit);
    if (db.prepare("SELECT 1 FROM chats WHERE id = ?").get(input.owner) === undefined) return false;
    db.prepare(
      `INSERT INTO jira_report_exports
      (report_id, chat_id, last_used_at, report_digest, markdown, csv, content_digest, byte_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(report_id) DO UPDATE SET last_used_at = MAX(last_used_at, excluded.last_used_at)
      WHERE chat_id = excluded.chat_id AND report_digest = excluded.report_digest
        AND content_digest = excluded.content_digest`,
    ).run(
      input.reportId,
      input.owner,
      input.lastUsedAt,
      input.reportDigest,
      markdown,
      csv,
      contentDigest(markdown, csv),
      bytes,
    );
    trimOwner(db, input.owner);
    prune(db, now, limit);
    const row = db
      .prepare(
        "SELECT content_digest FROM jira_report_exports WHERE report_id = ? AND chat_id = ? AND report_digest = ?",
      )
      .get(input.reportId, input.owner, input.reportDigest);
    return row?.content_digest === contentDigest(markdown, csv);
  });
}

function read(
  db: DatabaseSync,
  reportId: string,
  owner: string,
  format: JiraReportExportFormat,
  options: StoreOptions,
): JiraReportExportResponse | undefined {
  prune(db, options.now(), options.maxTotalBytes ?? JIRA_REPORT_STORE_MAX_BYTES);
  const row = db
    .prepare(
      "SELECT report_digest, markdown, csv, content_digest, byte_count FROM jira_report_exports WHERE report_id = ? AND chat_id = ?",
    )
    .get(reportId, owner) as ExportRow | undefined;
  if (
    row === undefined ||
    !DIGEST.test(row.report_digest) ||
    row.byte_count !== retainedBytes(row.markdown, row.csv) ||
    row.content_digest !== contentDigest(row.markdown, row.csv)
  )
    return undefined;
  // Reapply today's content policy as configured secrets may have changed since the report was made.
  const content = options.redactContentString(format === "csv" ? row.csv : row.markdown);
  return {
    format,
    fileName: `keiko-jira-report-${row.report_digest.slice(0, 12)}.${format === "csv" ? "csv" : "md"}`,
    mediaType: JIRA_REPORT_EXPORT_MEDIA_TYPES[format],
    content,
    byteCount: Buffer.byteLength(content),
    reportDigest: row.report_digest,
  };
}

export function createJiraReportExportStore(
  db: DatabaseSync,
  options: StoreOptions,
): JiraReportExportStore {
  prune(db, options.now(), options.maxTotalBytes ?? JIRA_REPORT_STORE_MAX_BYTES);
  return {
    put: (input) => put(db, options, input),
    read: (id, owner, format) => read(db, id, owner, format, options),
    touch: (id, owner, digest, lastUsedAt): boolean => {
      const now = options.now();
      if (!validUse(lastUsedAt, now)) return false;
      prune(db, now, options.maxTotalBytes ?? JIRA_REPORT_STORE_MAX_BYTES);
      return (
        db
          .prepare(
            `UPDATE jira_report_exports SET last_used_at = MAX(last_used_at, ?)
        WHERE report_id = ? AND chat_id = ? AND report_digest = ?`,
          )
          .run(lastUsedAt, id, owner, digest).changes > 0
      );
    },
  };
}
