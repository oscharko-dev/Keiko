// The lab counts product log lines where the lanes' sink writes them. Counting elsewhere reads as
// zero, which turned a correct S17 interruption into `unverified` (epic #4173).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chatReadLogDirectory } from "../testing/jira-chat-lab/chat-read.mjs";
import { logMatchCount } from "../testing/jira-chat-lab/requirements/journeys.mjs";

describe("logMatchCount", () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("counts lines in sealed and active segments of the lanes' log directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "jira-lab-log-"));
    roots.push(directory);
    const logs = join(chatReadLogDirectory({ directory }), "logs");
    mkdirSync(logs, { recursive: true });
    const line = (reason) =>
      `${JSON.stringify({ op: "chat.tool-turn.ended", extra: { reason } })}\n`;
    writeFileSync(join(logs, "activity-1.jsonl"), line("authority-invalid").repeat(2));
    writeFileSync(join(logs, "activity-2.active.jsonl"), line("authority-invalid"));
    writeFileSync(join(logs, "activity-3.jsonl"), line("budget-exhausted"));
    writeFileSync(join(logs, "notes.txt"), line("authority-invalid"));
    const root = chatReadLogDirectory({ directory });
    expect(logMatchCount(root, "chat.tool-turn.ended")).toBe(4);
    expect(logMatchCount(root, "chat.tool-turn.ended", '"reason":"authority-invalid"')).toBe(3);
    expect(logMatchCount(root, '"other.op"')).toBe(0);
  });
});
