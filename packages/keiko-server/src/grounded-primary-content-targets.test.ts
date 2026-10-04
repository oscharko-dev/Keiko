import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SemanticSearchProvider } from "@oscharko-dev/keiko-workspace";
import { buildGroundedGatewayMessages, buildQuery } from "./grounded-qa.js";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";

const NOW = 1_784_653_600_000;
let root = "";
beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "keiko-primary-content-"));
  mkdirSync(join(root, "facts"));
});
afterEach((): void => {
  rmSync(root, { recursive: true, force: true });
});

async function retrieve(
  content: string,
  provider?: SemanticSearchProvider,
): Promise<Awaited<ReturnType<typeof retrieveConnectedContextPack>>> {
  return retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      scope: {
        schemaVersion: "1",
        scopeId: "primary-content",
        workspaceRoot: root,
        kind: "workspace-root",
        relativePaths: [],
        explicitConnection: true,
        conversationId: "chat",
        connectedAtMs: NOW,
      },
      query: buildQuery(content, () => NOW),
    },
    {
      correlationId: undefined,
      nowMs: () => NOW,
      ...(provider === undefined ? {} : { repoSemanticSearchProvider: provider }),
      answerer: {
        answer: (): Promise<string> => Promise.reject(new Error("Unexpected model call")),
      },
    },
  );
}

function facts(target: string, extension: string, count = 16): void {
  for (let index = 1; index <= count; index += 1) {
    const body = `${target} ${String(71000 + index)}`;
    writeFileSync(
      join(root, "facts", `record-${String(index)}.${extension}`),
      extension === "html" ? `<p>${body}</p>\n` : `${body}\n`,
    );
  }
  writeFileSync(join(root, "facts", `unrelated-16.${extension}`), "unrelated values 16\n");
}

const variants = [
  ["InventoryMarker", "txt", "InventoryMarker"],
  ["WindowReadingSignal", "html", "Welche Werte stehen zu WindowReadingSignal?"],
  ["VerifiedRecordProbe", "txt", "Zeige VerifiedRecordProbe für alle 16 Einträge."],
  ["ThermalAuditReading", "ts", "List every value for ThermalAuditReading across 16 files."],
  [
    "DruckMesswert",
    "html",
    "Für alle 16 Einträge: DruckMesswert, gelesener Wert und belegte Zeile.",
  ],
  [
    "IndependentFactProbe",
    "txt",
    "Show IndependentFactProbe. Use only read values, no guesses. Include all 999 entries when evidenced.",
  ],
] as const;

describe("primary content evidence is independent of presentation wording", () => {
  it.each(variants)(
    "retains actual %s content for the paraphrased request",
    async (target, extension, content): Promise<void> => {
      facts(target, extension);
      const { pack } = await retrieve(content);
      expect(pack.files).toHaveLength(16);
      expect(pack.files.some((file) => file.scopePath.includes("unrelated"))).toBe(false);
      const prompt = JSON.stringify(buildGroundedGatewayMessages(content, pack, (value) => value));
      for (let index = 1; index <= 16; index += 1)
        expect(prompt.includes(`${target} ${String(71000 + index)}`)).toBe(true);
      expect(pack.omitted).toEqual([]);
    },
  );

  it("preserves multiple independent targets without protecting unrelated prose", async (): Promise<void> => {
    facts("FirstTargetProbe", "txt", 8);
    facts("SecondTargetSignal", "html", 8);
    const { pack } = await retrieve(
      "Zeige FirstTargetProbe und SecondTargetSignal für alle 16 Einträge.",
    );
    expect(pack.files).toHaveLength(16);
    expect(pack.files.some((file) => file.scopePath.includes("unrelated"))).toBe(false);
  });

  it("preserves semantic augmentation when primary named content is actually present", async (): Promise<void> => {
    facts("PrimaryReadingProbe", "txt", 8);
    writeFileSync(join(root, "facts", "related.txt"), "Additional related documentation\n");
    const { pack } = await retrieve("Welche Werte stehen zu PrimaryReadingProbe?", {
      name: "related fixture",
      search: (): Promise<readonly { scopePath: string; line: number; score: number }[]> =>
        Promise.resolve([{ scopePath: "facts/related.txt", line: 1, score: 0.99 }]),
    });
    expect(pack.files.some((file) => file.scopePath === "facts/related.txt")).toBe(true);
    const prompt = JSON.stringify(
      buildGroundedGatewayMessages("PrimaryReadingProbe", pack, (value) => value),
    );
    for (let index = 1; index <= 8; index += 1)
      expect(prompt.includes(`PrimaryReadingProbe ${String(71000 + index)}`)).toBe(true);
  });

  it("does not substitute another identifier's semantic evidence for named fact absence", async (): Promise<void> => {
    writeFileSync(join(root, "facts", "related.txt"), "OtherReadingProbe 81234\n");
    const { pack } = await retrieve(
      "CompactAbsentProbe: Welche Information ist dazu in diesem Ordner belegt?",
      {
        name: "related fixture",
        search: (): Promise<readonly { scopePath: string; line: number; score: number }[]> =>
          Promise.resolve([{ scopePath: "facts/related.txt", line: 1, score: 0.99 }]),
      },
    );
    expect(pack.files).toEqual([]);
    expect(pack.diagnostics?.coverage?.matchesReturned).toBe(0);
  });

  it("does not turn exact identifier absence into a fuzzy related-word hit", async (): Promise<void> => {
    writeFileSync(join(root, "facts", "related.txt"), "Absent target probe values\n");
    const { pack } = await retrieve(
      "Welche Werte stehen zu AbsentTargetProbe? Nenne alle 16 Einträge.",
    );
    expect(pack.files).toEqual([]);
    expect(pack.diagnostics?.coverage?.filesScanned).toBe(1);
  });

  it.each(["Suche nach 256", 'Suche nach "256"', 'Find the literal "präziser Druck"'])(
    "preserves the actual literal target in %s",
    async (content): Promise<void> => {
      writeFileSync(join(root, "facts", "target.txt"), "256 präziser Druck 81234\n");
      writeFileSync(join(root, "facts", "unrelated.txt"), "ordinary unrelated prose\n");
      const { pack } = await retrieve(content);
      expect(pack.files.map((file) => file.scopePath)).toEqual(["facts/target.txt"]);
    },
  );
});
