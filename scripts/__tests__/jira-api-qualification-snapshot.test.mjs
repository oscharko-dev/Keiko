import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  requireQualificationSnapshot,
  snapshotFileDigest,
} from "../testing/jira-chat-lab/api-qualification-snapshot.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";
import { privateJson } from "../testing/jira-chat-lab/private-json.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function snapshot() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-snapshot-"));
  roots.push(directory);
  const session = { directory, ...DEFAULT_LAB_CONNECTION, project: "keiko-jira-4081-owned" };
  const id = randomUUID();
  const backup = join(directory, `api-snapshot-${id}`);
  mkdirSync(backup, { mode: 0o700 });
  const database = join(backup, "database.dump");
  const home = join(backup, "jira-home.tar");
  writeFileSync(database, "synthetic database backup", { mode: 0o600 });
  writeFileSync(home, "synthetic home backup", { mode: 0o600 });
  const record = {
    schemaVersion: 1,
    id,
    project: session.project,
    jiraVersion: session.jiraVersion,
    jiraImageDigest: session.jiraImageDigest,
    servicesStopped: true,
    database: await snapshotFileDigest(database),
    jiraHome: await snapshotFileDigest(home),
  };
  privateJson(join(backup, "snapshot.json"), record, true);
  return { id, session, backup, database, home, record };
}

it("admits only the unchanged private backups of this exact session and release", async () => {
  const s = await snapshot();
  expect(await requireQualificationSnapshot(s.session, s.id)).toEqual(s.record);
  for (const change of [
    { project: "keiko-jira-4081-foreign" },
    { jiraVersion: "11.3.0" },
    { jiraImageDigest: "b".repeat(64) },
  ])
    await expect(requireQualificationSnapshot({ ...s.session, ...change }, s.id)).rejects.toThrow();
  writeFileSync(s.database, "changed backup", { mode: 0o600 });
  await expect(requireQualificationSnapshot(s.session, s.id)).rejects.toThrow();
});

it("refuses empty snapshots, path escapes and redirected backup files", async () => {
  const s = await snapshot();
  await expect(requireQualificationSnapshot(s.session, "../outside")).rejects.toThrow();
  writeFileSync(s.database, "", { mode: 0o600 });
  await expect(snapshotFileDigest(s.database)).rejects.toThrow();
  writeFileSync(s.database, "synthetic database backup", { mode: 0o600 });
  rmSync(s.home);
  symlinkSync(s.database, s.home);
  await expect(requireQualificationSnapshot(s.session, s.id)).rejects.toThrow();
});
