// #4458: a new question that merely contains an anaphoric word ("davon", "dafür") must not be
// answered only from the file the previous answer cited. That file stays an admitted continuity
// hint, but the question's own strongest evidence is still retained beside it. A genuine
// follow-up keeps the previous answer's file first.

import { describe, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";

const ROUTER = "IT/2024/Q3/Unterlagen/Netzwerk/Router-Konfiguration.md";
const BUDGET = "Finanzen/2025/Q2/Unterlagen/Budget/Jahresbudget-2026.TXT";

function paragraphs(seed: string, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `Absatz ${seed} ${String(index)} Planung Status Termin Team.`,
  ).join("\n");
}

function corpus(): Record<string, string> {
  const files: Record<string, string> = {
    [ROUTER]: `# Router\n\n${paragraphs("r", 3)}\n\nDas Admin-Netz des Standorts Bremen nutzt das VLAN 4711.\n\n${paragraphs("s", 3)}\n`,
    [BUDGET]: `${paragraphs("b", 4)}\nDas freigegebene IT-Budget für 2026 beträgt 1.284.500 Euro, davon 312.000 Euro für Cloud-Dienste.\n${paragraphs("c", 4)}\n`,
  };
  for (let index = 0; index < 30; index += 1)
    files[`Einkauf/2020/Q${String((index % 4) + 1)}/Unterlagen/dok-${String(index)}.json`] =
      JSON.stringify({
        notiz: "Server Budget Prüfung Netzwerk Wartung Team Planung",
        text: paragraphs(`d${String(index)}`, 12),
      });
  return files;
}

const HISTORY = [
  { role: "user" as const, content: "Welches VLAN nutzt das Admin-Netz in Bremen?" },
  {
    role: "assistant" as const,
    content: `Das Admin-Netz in Bremen nutzt das VLAN 4711 [${ROUTER}:5].`,
  },
];

async function sentFiles(
  query: string,
): Promise<{ readonly sent: readonly string[]; readonly extra: Record<string, unknown> }> {
  const log = createBufferedServerLogSink();
  const { pack } = await runConnectedRetrievalEval({
    files: corpus(),
    query,
    history: HISTORY,
    activityLog: log,
    correlationId: "continuity-new-topic",
  });
  const event = log.events.find(
    (entry) => entry.op === "search.connected-context.selection-details",
  );
  expect(event?.correlationId).toBe("continuity-new-topic");
  return { sent: pack.files.map((file) => file.scopePath), extra: event?.extra ?? {} };
}

describe("previous-answer continuity on a new question (#4458)", () => {
  it.each([
    "Wie hoch ist das IT-Budget 2026 und wie viel davon entfällt auf Cloud-Dienste?",
    "Wie viel IT-Budget gibt es dafür 2026?",
  ])("retains the question's own evidence for %j", async (query) => {
    const { sent, extra } = await sentFiles(query);
    expect(sent).toContain(BUDGET);
    expect(extra).toMatchObject({
      continuityReferentSource: "assistant-paths",
      continuityAdmittedCount: 1,
      selectionConfidence: "low",
      keepOneFallbackApplied: true,
    });
  });

  it("keeps the previous answer's file first for a genuine follow-up", async () => {
    const { sent, extra } = await sentFiles("Und wer ist dafür zuständig?");
    expect(sent[0]).toBe(ROUTER);
    expect(extra).toMatchObject({
      continuityReferentSource: "assistant-paths",
      continuityAdmittedCount: 1,
    });
  });
});
