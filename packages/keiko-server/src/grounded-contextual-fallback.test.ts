import { describe, expect, it } from "vitest";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";

function neighboringNotes(): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `adjacent/station-${String(index).padStart(3, "0")}/procedure.md`,
      [
        `# Separate freight station ${String(index)}`,
        "Applies only to this station; local operations note.",
        "The local waiting period is 63 minutes.",
        "Record disposition after the local dispatch limit is crossed.",
        "Inspection records and witness journals belong to this station.",
        "Label preparation uses a receipt ledger and the local scanner policy.",
        ...Array.from(
          { length: 80 },
          () =>
            "Check the shipment waiting period, dispatch, storage, inspection, witness journal, policy revision and receipt before recording a local disposition.",
        ),
      ].join("\n"),
    ]),
  );
}

describe("contextual selection preserves the lexical producer's fallback evidence", () => {
  it.each(["Silver Birch sorting room", "Quiet Harbor transfer depot"])(
    "retains the unquoted operational subject %s in a neutrally named file",
    async (subject) => {
      const log = createBufferedServerLogSink();
      const { pack } = await runConnectedRetrievalEval({
        files: {
          ...neighboringNotes(),
          "records/current.md": [
            `# ${subject} operating note`,
            "Status: current, authorized by the operations owner.",
            "Maximum permitted dwell time: 32 minutes.",
            "After that interval, remove the shipment from the belt into the hold cage.",
            "Enter the disposition in the witness journal with 4 authorized staff.",
            "The applicable handbook revision is HB719.",
          ].join("\n"),
        },
        query: `For the ${subject}, how long may a shipment remain on the belt, where must it go afterward, how many staff must witness the journal entry, and which handbook revision governs this? Cite the operating note.`,
        activityLog: log,
        correlationId: "contextual-fallback-evidence",
      });
      expect(pack.files.map((file) => file.scopePath)).toEqual(["records/current.md"]);
      expect(pack.diagnostics?.selection?.selectionConfidence).toBe("low");
      expect(pack.diagnostics?.selection?.fallbackRankingSource).toBe("lexical-producer");
      expect(
        log.events.find((event) => event.op === "search.connected-context.selection-details")
          ?.extra,
      ).toMatchObject({
        keepOneFallbackApplied: true,
        fallbackRankingSource: "lexical-producer",
        selectionConfidence: "low",
      });
      expect(pack.uncertainty.some((marker) => marker.kind === "low-confidence-selection")).toBe(
        true,
      );
    },
  );

  it.each([
    ["UTF-8", "SHA-256", "utf8", "sha256", "hex"],
    ["UTF-16", "SHA-512", "utf16le", "sha512", "base64"],
  ])(
    "retains source logic for %s and %s without relying on the filename",
    async (encoding, algorithm, codec, hash, rendering) => {
      const { pack } = await runConnectedRetrievalEval({
        files: {
          ...neighboringNotes(),
          "src/transform.ts": [
            'import { createHash } from "node:crypto";',
            "export function transformNote(message: string): string {",
            `  const bytes = Buffer.from(message, "${codec}");`,
            `  return createHash("${hash}").update(bytes).digest("${rendering}");`,
            "}",
          ].join("\n"),
        },
        query: `Which routine encodes a note using ${encoding} and computes a ${algorithm} receipt, and how is the result rendered? Cite the implementation. Describe the source logic; no execution has been observed.`,
      });
      expect(pack.diagnostics?.rankedCandidates[0]?.scopePath).toBe("src/transform.ts");
      expect(pack.files.map((file) => file.scopePath)).toEqual(["src/transform.ts"]);
      expect(pack.files[0]?.excerpts.map((excerpt) => excerpt.content).join("\n")).toContain(
        `.digest("${rendering}")`,
      );
      expect(pack.diagnostics?.selection?.selectionConfidence).toBe("low");
    },
  );
});
