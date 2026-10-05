import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectWorkspaceAt, type WorkspaceFs } from "@oscharko-dev/keiko-workspace";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

function observedBinaryReads(reads: number[]): WorkspaceFs {
  const read = nodeWorkspaceFs.readFileBytes;
  if (read === undefined) throw new TypeError("Expected the native bounded byte reader");
  return {
    ...nodeWorkspaceFs,
    readFileBytes: async (...args): Promise<Uint8Array> => {
      const bytes = await read(...args);
      if (args[0].endsWith("/artifact.wasm")) reads.push(bytes.length);
      return bytes;
    },
  };
}

async function retrieveFixture(
  root: string,
  reads: number[],
): Promise<{
  readonly output: Awaited<ReturnType<typeof retrieveConnectedContextPack>>;
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
}> {
  const workspace = detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false });
  const log = createBufferedServerLogSink();
  const output = await retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      scope: {
        schemaVersion: "1",
        scopeId: "binary-probe",
        workspaceRoot: root,
        kind: "workspace-root",
        relativePaths: [],
        conversationId: undefined,
        connectedAtMs: 1,
        explicitConnection: true,
      },
      query: {
        kind: "natural-language",
        text: 'Find exact identifier "BinaryProbeNeedle".',
        maxResults: 50,
        caseSensitive: false,
        emittedAtMs: 1,
      },
    },
    {
      correlationId: "binary-probe-review-0001",
      activityLog: log,
      fs: observedBinaryReads(reads),
      nowMs: () => 1,
      detectWorkspace: () => workspace,
      answerer: { answer: () => Promise.resolve("") },
    },
  );
  return { output, log };
}

describe("binary prefilter evidence through actual connected retrieval", () => {
  it("records binary omission and complete lexical retrieval without full binary reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-grounded-binary-probe-"));
    try {
      writeFileSync(join(root, "artifact.wasm"), Buffer.alloc(1024 * 1024));
      writeFileSync(join(root, "main.ts"), "export const BinaryProbeNeedle = 7;\n");
      const reads: number[] = [];
      const { output, log } = await retrieveFixture(root, reads);
      expect(output.pack.files.map((file) => file.scopePath)).toEqual(["main.ts"]);
      expect(output.pack.diagnostics?.coverage).toMatchObject({
        incomplete: false,
        reasons: [],
        filesScanned: 2,
        filesSkipped: 1,
      });
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((bytes) => bytes <= 4096)).toBe(true);
      const event = log.events.find(
        (entry) => entry.op === "search.connected-context.source-details",
      );
      expect(event?.extra).toMatchObject({ omittedBinaryCount: 1 });
      expect(event?.correlationId).toBe("binary-probe-review-0001");
      expect(JSON.stringify(event)).not.toContain(root);
      expect(JSON.stringify(event)).not.toContain("BinaryProbeNeedle");
      const line = expectActivityLogProof(
        "search.connected-context.source-details.line",
        formatActivityLogProofLine(event ?? {}),
      );
      expect(line).toHaveProperty("omittedBinaryCount", 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
