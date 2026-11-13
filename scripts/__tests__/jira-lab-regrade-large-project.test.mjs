// The offline re-grade of a saved large-project run (#4369): the saved turn is found in the retained
// messages and read back, and no model or Keiko turn is needed.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  savedLargeTurn,
  savedMessages,
} from "../testing/jira-chat-lab/requirements/regrade-large-project.mjs";

const message = (role, content, toolTranscript) => ({ role, content, toolTranscript });
const PROMPT = "Werte den Fortschritt des Jira-Projekts LRG aus. Antworte nur mit Zeilen.";

describe("the saved large-project turn", () => {
  it("is the LRG progress prompt, its report exchanges and the answer that followed", () => {
    const exchanges = [{ call: { name: "jira_report" } }];
    const saved = savedLargeTurn([
      message("user", "Werte den Fortschritt des Jira-Projekts RPT aus."),
      message("assistant", "RPT-Antwort"),
      message("user", PROMPT, { exchanges }),
      message("assistant", "ANZAHL;Aufgabe;Fertig;810"),
      message("user", "Erstelle einen Fortschrittsbericht für das Jira-Projekt LRG."),
      message("assistant", "SCHÄTZUNG;NICHT_VERFÜGBAR"),
    ]);
    expect(saved).toEqual({ answer: "ANZAHL;Aufgabe;Fertig;810", toolExchanges: exchanges });
  });

  it("is refused when the run holds no such turn or the turn has no answer", () => {
    expect(() => savedLargeTurn([message("user", "Hallo")])).toThrow("no large-project");
    expect(() => savedLargeTurn([message("user", PROMPT)])).toThrow("no answer");
  });

  it("is read from the retained state's ui.db in order, with the transcript parsed", () => {
    const directory = mkdtempSync(join(tmpdir(), "regrade-"));
    const database = new DatabaseSync(join(directory, "ui.db"));
    database.exec(
      "create table chat_messages (role text, content text, tool_transcript_json text, timestamp integer)",
    );
    const insert = database.prepare("insert into chat_messages values (?, ?, ?, ?)");
    insert.run("assistant", "zweite", null, 2);
    insert.run("user", "erste", JSON.stringify({ exchanges: [{ call: { name: "x" } }] }), 1);
    database.close();
    const rows = savedMessages(directory);
    expect(rows.map((row) => row.content)).toEqual(["erste", "zweite"]);
    expect(rows[0].toolTranscript.exchanges).toHaveLength(1);
    expect(rows[1].toolTranscript).toBeUndefined();
  });
});
