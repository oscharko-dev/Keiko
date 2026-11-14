import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  correctedByKind,
  renderSweep,
  sweep,
} from "../testing/jira-chat-lab/announced-create-sweep.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function session() {
  const directory = mkdtempSync(join(tmpdir(), "announce-sweep-"));
  directories.push(directory);
  return directory;
}

function state(directory, name, rows) {
  const path = join(directory, name);
  mkdirSync(path);
  const database = new DatabaseSync(join(path, "ui.db"));
  database.exec(
    "create table chat_messages (id text, chat_id text, role text, content text, timestamp integer, tool_transcript_json text)",
  );
  const insert = database.prepare("insert into chat_messages values (?, ?, ?, ?, ?, ?)");
  rows.forEach((row, index) =>
    insert.run(String(index), row.chat, row.role, row.content, row.at, row.exchanges ?? null),
  );
  database.close();
}

const line = (kind) =>
  `${JSON.stringify({ op: "chat.tool-turn.corrected", extra: { correctionKind: kind } })}\n`;

describe("the announced-create sweep", () => {
  it("counts states, stored user turns, announcements without a receipt and corrections by kind", () => {
    const root = session();
    state(root, "keiko-jira-live-chat-a", [
      { chat: "c1", role: "user", content: "order", at: 1_000, exchanges: '{"exchanges":[]}' },
      { chat: "c1", role: "assistant", content: "Der Vorgang wurde angelegt.", at: 1_100 },
      { chat: "c2", role: "user", content: "ask", at: 2_000 },
      { chat: "c2", role: "assistant", content: "Nothing happened.", at: 2_100 },
    ]);
    // A state whose database has no chat table is counted as a state and never as readable.
    mkdirSync(join(root, "keiko-jira-live-chat-b"));
    new DatabaseSync(join(root, "keiko-jira-live-chat-b", "ui.db")).close();
    const logs = join(root, "chat-read-logs", "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "activity-20261114T100000000Z-1-x-000001.jsonl"),
      `${line("tool-schema")}${line("tool-schema")}${line("announced-create")}{"op":"other"}\n`,
    );
    const detector = (_exchanges, answer) => (answer.includes("angelegt") ? 1 : 0);
    const result = sweep({ session: root, detector });
    expect(result).toMatchObject({
      states: 2,
      readable: 1,
      turns: 2,
      announced: 1,
      first: 1_000,
      last: 2_000,
    });
    expect(result.logs.total).toBe(3);
    expect(result.logs.kinds.get("tool-schema")).toBe(2);
    expect(result.logs.kinds.get("announced-create")).toBe(1);
    // The cut-off removes later turns and later segments, never an earlier one.
    expect(sweep({ session: root, detector, until: 1_500 })).toMatchObject({
      turns: 1,
      announced: 1,
    });
    expect(correctedByKind(logs, Date.parse("2026-11-14T09:00:00Z")).total).toBe(0);
  });

  it("renders counts and closed kinds only", () => {
    const root = session();
    state(root, "keiko-jira-live-chat-a", [
      { chat: "c1", role: "user", content: "SECRET ORDER TEXT", at: 1_000 },
      { chat: "c1", role: "assistant", content: "SECRET ANSWER TEXT angelegt", at: 1_100 },
    ]);
    const result = sweep({ session: root, detector: () => 0 });
    const text = renderSweep(result, {
      distCommit: "abc1234",
      headCommit: "def5678",
      session: root,
    });
    expect(text).toContain("stored user turns swept: 1");
    expect(text).toContain("of kind announced-create: 0");
    expect(text).not.toContain("SECRET");
  });
});
