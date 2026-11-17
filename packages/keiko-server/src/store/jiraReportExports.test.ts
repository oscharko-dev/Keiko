import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { JIRA_REPORT_IDLE_TTL_MS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { buildUiStoreOverDatabase } from "./db.js";
import { runMigrations } from "./schema.js";
import { createJiraReportExportStore, type StoredJiraReportExports } from "./jiraReportExports.js";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
const id = (number: number): string =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const DIGEST = "a".repeat(64);

function fixture(maxTotalBytes?: number): {
  db: DatabaseSync;
  ui: ReturnType<typeof buildUiStoreOverDatabase>;
  store: ReturnType<typeof createJiraReportExportStore>;
  owner: string;
  other: string;
  put: (number: number, patch?: Partial<StoredJiraReportExports>) => boolean;
  tick: (time: number) => void;
  secret: (value: string) => void;
} {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  let now = 1000;
  let secret = "synthetic-private-value";
  const ui = buildUiStoreOverDatabase(db, { now: () => now });
  const project = ui.createProject(process.cwd());
  const owner = ui.createChat(project.path, "First", "synthetic").id;
  const other = ui.createChat(project.path, "Other", "synthetic").id;
  const store = createJiraReportExportStore(db, {
    now: () => now,
    redactContentString: (value) => value.replaceAll(secret, "[REDACTED]"),
    ...(maxTotalBytes === undefined ? {} : { maxTotalBytes }),
  });
  disposals.push(() => {
    ui.close();
  });
  return {
    db,
    ui,
    store,
    owner,
    other,
    put: (number, patch = {}) =>
      store.put({
        reportId: id(number),
        owner,
        lastUsedAt: now,
        reportDigest: DIGEST,
        markdown: "# Report\nTotal: 3",
        csv: "key\nSYN-1\nSYN-2\nSYN-3",
        ...patch,
      }),
    tick: (time): void => {
      now += time;
    },
    secret: (value): void => {
      secret = value;
    },
  };
}

describe("retained Jira report exports (#4390)", () => {
  it.each([
    { reportId: "not-a-report" },
    { reportDigest: "not-a-digest" },
    { lastUsedAt: -1 },
    { lastUsedAt: 1000.5 },
    { lastUsedAt: 1001 },
  ])("refuses an invalid stored report envelope %j", (patch) => {
    const f = fixture();
    expect(f.put(1, patch)).toBe(false);
    expect(f.store.read(id(1), f.owner, "csv")).toBeUndefined();
  });

  it("keeps both formats bound to their original Chat and immutable report identity", () => {
    const f = fixture();
    expect(f.put(1)).toBe(true);
    expect(f.store.read(id(1), f.other, "csv")).toBeUndefined();
    expect(f.put(1, { owner: f.other })).toBe(false);
    expect(f.put(1, { reportDigest: "b".repeat(64) })).toBe(false);
    expect(f.put(1, { csv: "replacement" })).toBe(false);
    expect(f.put(2, { owner: "missing-chat" })).toBe(false);
    expect(f.store.read(id(1), f.owner, "csv")).toMatchObject({
      format: "csv",
      reportDigest: DIGEST,
      content: "key\nSYN-1\nSYN-2\nSYN-3",
    });
    expect(f.store.read(id(1), f.owner, "markdown")?.fileName).toMatch(/\.md$/u);
  });

  it("does not renew the four-hour idle lifetime when downloading", () => {
    const f = fixture();
    f.put(1);
    f.tick(JIRA_REPORT_IDLE_TTL_MS - 1);
    expect(f.store.read(id(1), f.owner, "markdown")).toBeDefined();
    f.tick(2);
    expect(f.store.read(id(1), f.owner, "csv")).toBeUndefined();
    expect(f.store.touch(id(1), f.owner, DIGEST, 1000 + JIRA_REPORT_IDLE_TTL_MS + 1)).toBe(false);
    expect(f.put(1, { lastUsedAt: 1000 })).toBe(false);
  });

  it("renews only an existing matching report after tool use, never from an invalid clock or owner", () => {
    const f = fixture();
    f.put(1);
    f.tick(2000);
    expect(f.store.touch(id(1), f.other, DIGEST, 3000)).toBe(false);
    expect(f.store.touch(id(1), f.owner, "b".repeat(64), 3000)).toBe(false);
    expect(f.store.touch(id(1), f.owner, DIGEST, 3001)).toBe(false);
    expect(f.store.touch(id(1), f.owner, DIGEST, -1)).toBe(false);
    expect(f.store.touch(id(1), f.owner, DIGEST, 3000)).toBe(true);
    f.tick(JIRA_REPORT_IDLE_TTL_MS - 1);
    expect(f.store.read(id(1), f.owner, "csv")).toBeDefined();
  });

  it("retains at most four per Chat without evicting another Chat's report", () => {
    const f = fixture();
    f.put(9, { owner: f.other });
    for (let number = 1; number <= 5; number++) {
      f.tick(1);
      f.put(number);
    }
    expect(f.store.read(id(1), f.owner, "csv")).toBeUndefined();
    expect(f.store.read(id(2), f.owner, "csv")).toBeDefined();
    expect(f.store.read(id(5), f.owner, "csv")).toBeDefined();
    expect(f.store.read(id(9), f.other, "csv")).toBeDefined();
  });

  it("charges UTF-8 bytes and evicts the largest owner's oldest export at the total bound", () => {
    const f = fixture(1500);
    f.put(9, { owner: f.other });
    for (let number = 1; number <= 4; number++) {
      f.tick(1);
      f.put(number, { markdown: "ü".repeat(150), csv: "small" });
    }
    expect(f.store.read(id(9), f.other, "csv")).toBeDefined();
    expect(f.store.read(id(1), f.owner, "csv")).toBeUndefined();
    expect(f.store.read(id(4), f.owner, "markdown")?.byteCount).toBe(300);
    expect(
      Number(f.db.prepare("SELECT SUM(byte_count) AS bytes FROM jira_report_exports").get()?.bytes),
    ).toBeLessThanOrEqual(1500);
    expect(f.put(7, { markdown: "x".repeat(1500) })).toBe(false);
    expect(f.store.read(id(9), f.other, "csv")).toBeDefined();
  });

  it("projects configured secrets before storing and reapplies current policy when reading", () => {
    const f = fixture();
    f.put(1, {
      markdown: "synthetic-private-value and newly-private",
      csv: "synthetic-private-value",
    });
    const row = f.db.prepare("SELECT markdown, csv FROM jira_report_exports").get();
    expect(JSON.stringify(row)).not.toContain("synthetic-private-value");
    f.secret("newly-private");
    expect(f.store.read(id(1), f.owner, "markdown")?.content).toBe("[REDACTED] and [REDACTED]");
  });

  it("fails closed when stored content or its byte accounting changes", () => {
    const f = fixture();
    f.put(1);
    f.db
      .prepare("UPDATE jira_report_exports SET csv = ? WHERE report_id = ?")
      .run("tampered", id(1));
    expect(f.store.read(id(1), f.owner, "csv")).toBeUndefined();
    f.put(2);
    f.db
      .prepare("UPDATE jira_report_exports SET byte_count = byte_count + 1 WHERE report_id = ?")
      .run(id(2));
    expect(f.store.read(id(2), f.owner, "markdown")).toBeUndefined();
  });

  it("deletes exports with their Chat and project through existing foreign keys", () => {
    const f = fixture();
    f.put(1);
    f.put(2, { owner: f.other });
    f.ui.deleteChat(f.owner);
    expect(f.store.read(id(1), f.owner, "csv")).toBeUndefined();
    expect(f.store.read(id(2), f.other, "csv")).toBeDefined();
    f.ui.deleteProject(process.cwd());
    expect(f.db.prepare("SELECT count(*) AS count FROM jira_report_exports").get()?.count).toBe(0);
    expect(f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
