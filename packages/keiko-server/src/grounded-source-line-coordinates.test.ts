import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redact } from "@oscharko-dev/keiko-security";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import { buildAnswerCitations, buildGroundedGatewayMessages } from "./grounded-qa.js";

const roots: string[] = [];
function redactValue(value: unknown): unknown {
  return typeof value === "string" ? redact(value) : value;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function sourceRoot(newline: string): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-grounded-source-lines-"));
  roots.push(root);
  mkdirSync(join(root, "nested"));
  const begin = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  const end = ["-----END ", "PRIVATE KEY-----"].join("");
  writeFileSync(
    join(root, "nested/source.txt"),
    [
      "preamble",
      begin,
      "first-private-body",
      end,
      "PhysicalCoordinateProbe VERIFIED_MIDDLE",
      begin,
      "second-private-body",
      end,
      "PhysicalCoordinateProbe VERIFIED_LAST",
    ].join(newline),
  );
  return root;
}
async function retrieve(
  root: string,
): Promise<Awaited<ReturnType<typeof retrieveConnectedContextPack>>> {
  return retrieveConnectedContextPack(
    {
      workspaceRoot: root,
      scope: {
        schemaVersion: "1",
        scopeId: "physical-source-lines",
        workspaceRoot: root,
        kind: "workspace-root",
        relativePaths: [],
        explicitConnection: true,
        conversationId: undefined,
        connectedAtMs: 0,
      },
      query: {
        kind: "exact-symbol",
        text: "PhysicalCoordinateProbe",
        caseSensitive: true,
        maxResults: 20,
        emittedAtMs: 0,
      },
    },
    {
      correlationId: undefined,
      nowMs: () => 0,
      answerer: {
        answer: (): Promise<never> => Promise.reject(new Error("No model call allowed")),
      },
    },
  );
}

describe("grounded source line coordinates", () => {
  it.each(["\n", "\r\n"])(
    "projects actual physical lines after separate redacted spans (%j)",
    async (newline) => {
      const { pack } = await retrieve(sourceRoot(newline));
      const prompt = JSON.stringify(
        buildGroundedGatewayMessages("PhysicalCoordinateProbe", pack, redactValue),
      );
      expect(prompt).toContain("5 | PhysicalCoordinateProbe VERIFIED_MIDDLE");
      expect(prompt).toContain("9 | PhysicalCoordinateProbe VERIFIED_LAST");
      expect(prompt).not.toContain("3 | PhysicalCoordinateProbe VERIFIED_MIDDLE");
      expect(prompt).not.toContain("first-private-body");
      expect(prompt).not.toContain("second-private-body");
      const citations = buildAnswerCitations(
        pack,
        "The last value is VERIFIED_LAST [nested/source.txt:9].",
        redactValue,
      );
      expect(citations).toContainEqual(
        expect.objectContaining({
          scopePath: "nested/source.txt",
          lineRange: { startLine: 9, endLine: 9 },
        }),
      );
    },
  );
});
