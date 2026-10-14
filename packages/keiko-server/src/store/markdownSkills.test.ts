import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryUiStore, createNodeUiStore } from "./index.js";
import type { UiStore } from "./types.js";
import {
  MARKDOWN_SKILL_LIMITS,
  type MarkdownSkillUpload,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { DatabaseSync } from "node:sqlite";
import { buildUiStoreOverDatabase } from "./db.js";
import { runMigrations, MIGRATIONS } from "./schema.js";

const SOURCE = "# Review method\n\nDescribe boundaries before examples.\n";
const upload = (body = SOURCE, fileName = "method.md"): MarkdownSkillUpload => ({
  fileName,
  contentBase64: Buffer.from(body).toString("base64"),
});
const stores: UiStore[] = [];
const directories: string[] = [];

function memoryStore(): UiStore {
  const store = createInMemoryUiStore();
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("private Markdown skill library (#4023)", () => {
  it("imports plain Markdown without a project and lists metadata without bodies", () => {
    const library = memoryStore().markdownSkills;
    const skill = library.import(upload());
    expect(skill).toMatchObject({ name: "Review method", revision: 1, body: SOURCE });
    expect(skill.id).toMatch(/^msk_[a-f0-9-]{36}$/u);
    expect(skill.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(library.list()).toEqual([expect.objectContaining({ id: skill.id, revision: 1 })]);
    expect(JSON.stringify(library.list())).not.toContain("Describe boundaries");
    expect(library.get(skill.id, 1)).toEqual(skill);
  });

  it("normalizes line endings once, keeps Unicode and treats metadata as ordinary text", () => {
    const source = "\uFEFF---\r\npermissions: all\r\n---\r\n# Prüfung\r\nÖffne nichts.\r\n";
    const skill = memoryStore().markdownSkills.import(upload(source));
    expect(skill.body).toBe("---\npermissions: all\n---\n# Prüfung\nÖffne nichts.\n");
    expect(skill.name).toBe("Prüfung");
    expect(skill.byteCount).toBe(Buffer.byteLength(skill.body));
    expect(skill).not.toHaveProperty("permissions");
  });

  it("deduplicates identical current content but never overwrites a same-name skill", () => {
    const library = memoryStore().markdownSkills;
    const first = library.import(upload());
    expect(library.import(upload(SOURCE, "copy.md"))).toEqual(first);
    const second = library.import(upload(SOURCE + "Use a table.\n"));
    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe(first.name);
    expect(library.get(first.id, 1)?.body).toBe(SOURCE);
  });

  it("pins old revisions, rejects stale replacement/deletion and revokes every revision", () => {
    const library = memoryStore().markdownSkills;
    const first = library.import(upload());
    const second = library.replace(first.id, 1, upload(SOURCE + "Check edge cases.\n"));
    expect(second.revision).toBe(2);
    expect(library.get(first.id, 1)).toEqual(first);
    expect(library.replace(first.id, 2, upload(second.body))).toEqual(second);
    expect(() => library.replace(first.id, 1, upload("New"))).toThrow(/revision is stale/u);
    expect(() => {
      library.delete(first.id, 1);
    }).toThrow(/revision is stale/u);
    library.delete(first.id, 2);
    expect(library.get(first.id, 1)).toBeUndefined();
    expect(library.get(first.id, 2)).toBeUndefined();
    expect(library.list()).toEqual([]);
  });

  it.each([
    upload(""),
    upload(" \n"),
    upload("bad\u0000body"),
    upload("body", "../method.md"),
    upload("body", "method.zip"),
    upload("body", "C:\\method.md"),
    upload("body", " .md"),
    upload("body", "x".repeat(MARKDOWN_SKILL_LIMITS.fileNameChars) + ".md"),
    { fileName: "method.md", contentBase64: "/w==" },
    { fileName: "method.md", contentBase64: "not base64!" },
  ])("refuses malformed input atomically", (input) => {
    const library = memoryStore().markdownSkills;
    expect(() => library.import(input)).toThrow();
    expect(library.list()).toEqual([]);
  });

  it("never interprets HTML, remote resources or command-like text during import", () => {
    const body =
      "# Inspect\n<script>alert(1)</script>\n![remote](https://example.invalid/pixel)\nRun: rm -rf /\n";
    expect(memoryStore().markdownSkills.import(upload(body)).body).toBe(body);
  });

  it("accepts the byte boundary, rejects one extra byte and retains the last good revision", () => {
    const library = memoryStore().markdownSkills;
    const body = "x".repeat(MARKDOWN_SKILL_LIMITS.importBytes);
    const skill = library.import(upload(body));
    expect(skill.byteCount).toBe(MARKDOWN_SKILL_LIMITS.importBytes);
    expect(() => library.replace(skill.id, 1, upload(body + "x"))).toThrow(/upload limit/u);
    expect(library.get(skill.id)).toEqual(skill);
  });

  it("bounds library entries while permitting duplicate imports at capacity", () => {
    const library = memoryStore().markdownSkills;
    for (let i = 0; i < MARKDOWN_SKILL_LIMITS.skills; i++)
      library.import(upload(`Method ${String(i)}`));
    expect(library.import(upload("Method 0")).revision).toBe(1);
    expect(() => library.import(upload("One more"))).toThrow(/library is full/u);
    expect(library.list()).toHaveLength(MARKDOWN_SKILL_LIMITS.skills);
  });

  it("rejects invalid identities and unavailable revisions without mutating the library", () => {
    const library = memoryStore().markdownSkills;
    const skill = library.import(upload("Plain instructions"));
    expect(skill.name).toBe("method");
    expect(() => library.get("invalid")).toThrow(/identity/u);
    expect(() => library.get(skill.id, 0)).toThrow(/revision/u);
    expect(() => library.get(skill.id, 1.5)).toThrow(/revision/u);
    library.delete(skill.id, 1);
    expect(() => library.replace(skill.id, 1, upload())).toThrow(/not found/iu);
    expect(library.list()).toEqual([]);
  });

  it("charges retained revisions to library bytes without discarding committed versions", () => {
    const library = memoryStore().markdownSkills;
    const skill = library.import(upload("x".repeat(MARKDOWN_SKILL_LIMITS.importBytes)));
    let revision = 1;
    for (
      let bytes = skill.byteCount;
      bytes < MARKDOWN_SKILL_LIMITS.libraryBytes;
      bytes += skill.byteCount
    ) {
      const prefix = String(revision);
      revision = library.replace(
        skill.id,
        revision,
        upload(prefix.padEnd(skill.byteCount, "x")),
      ).revision;
    }
    expect(() => library.replace(skill.id, revision, upload("One more byte"))).toThrow(
      /library is full/u,
    );
    expect(library.get(skill.id, 1)).toEqual(skill);
    expect(library.get(skill.id)?.revision).toBe(revision);
  });

  it("rolls back a failed write and refuses corrupt stored content", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    const store = buildUiStoreOverDatabase(db);
    stores.push(store);
    const skill = store.markdownSkills.import(upload());
    db.exec(
      "CREATE TRIGGER fail_skill_insert BEFORE INSERT ON markdown_skill_revisions BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
    expect(() => store.markdownSkills.replace(skill.id, 1, upload("Changed"))).toThrow();
    expect(store.markdownSkills.get(skill.id)).toEqual(skill);
    db.prepare("UPDATE markdown_skill_revisions SET body = ? WHERE skill_id = ?").run(
      "corrupt",
      skill.id,
    );
    expect(() => store.markdownSkills.get(skill.id)).toThrow(/integrity check failed/u);
  });

  it("migrates a previous installation without changing existing projects", () => {
    const db = new DatabaseSync(":memory:");
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 41)) {
      db.exec(migration.sql);
      migration.apply?.(db);
    }
    db.exec(
      "PRAGMA user_version = 41; INSERT INTO projects (path, name, created_at, last_opened_at) VALUES ('/synthetic','Existing',1,1)",
    );
    runMigrations(db);
    runMigrations(db);
    const store = buildUiStoreOverDatabase(db);
    stores.push(store);
    expect(store.listProjects()[0]?.name).toBe("Existing");
    expect(store.markdownSkills.list()).toEqual([]);
    expect(store.markdownSkills.import(upload()).body).toBe(SOURCE);
  });

  it("isolates installations and survives reopening the existing private UI database", () => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-markdown-skills-"));
    directories.push(directory);
    const path = join(directory, "state", "ui.sqlite");
    const first = createNodeUiStore(path);
    const skill = first.markdownSkills.import(upload());
    first.close();
    const reopened = createNodeUiStore(path);
    stores.push(reopened);
    expect(reopened.markdownSkills.get(skill.id, 1)).toEqual(skill);
    expect(memoryStore().markdownSkills.get(skill.id, 1)).toBeUndefined();
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
