import { describe, expect, it } from "vitest";
import { CONNECTED_CONTEXT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { retrieveConnectedContextPack } from "./grounded-orchestrator.js";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const QUESTION =
  "Untersuche dazu jetzt die C#-Quelldateien im verbundenen Ordner. Welche Rechenfunktion ist implementiert, was liefert sie für 8 und 13, und welchen passenden kopierbaren Vitest-Test mit einer äquivalenten TypeScript-Funktion würdest du vorschlagen? Unterscheide ausdrücklich Bestand und vorgeschlagenen Code; führe nichts aus.";

describe("grounded ordinary-folder source inspection", () => {
  it("provides the actual C# computation and existing body-free read evidence for the follow-up", async () => {
    const activityLog = createBufferedServerLogSink();
    const output = await retrieveConnectedContextPack(
      {
        workspaceRoot: "/ws",
        scope: {
          schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
          scopeId: "csharp-ordinary",
          workspaceRoot: "/ws",
          kind: "workspace-root",
          relativePaths: [],
          conversationId: undefined,
          connectedAtMs: 0,
          explicitConnection: true,
        },
        query: {
          kind: "natural-language",
          text: QUESTION,
          maxResults: 50,
          caseSensitive: false,
          emittedAtMs: 0,
        },
      },
      {
        fs: memFs("/ws", {
          "src/Calculator.cs":
            "namespace Existing;\npublic static class Calculator {\n  public static int Add(int a, int b) => a + b;\n}\n",
          "App.csproj":
            "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>",
          "lateproject/Legacy.csproj":
            "<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
        }),
        detectWorkspace: () => ({
          root: "/ws",
          selectedRoot: "/ws",
          name: "ordinary-csharp",
          version: "0.0.0",
          languages: ["csharp"],
          testFramework: "unknown",
          sourceDirs: ["src"],
          testDirs: [],
          ignoreLines: [],
        }),
        answerer: {
          answer: (): Promise<string> =>
            Promise.reject(new Error("Retrieval must not invoke a model.")),
        },
        nowMs: () => 0,
        activityLog,
        correlationId: "csharp-source-inspection-proof",
      },
    );
    expect(output.plan.retrievalIntent).toBe("targeted-code-search");
    const source = output.pack.files.find((file) => file.scopePath === "src/Calculator.cs");
    expect(source).toBeDefined();
    expect(JSON.stringify(source)).toContain("public static int Add(int a, int b) => a + b;");
    const completed = activityLog.events.find(
      (event) => event.op === "search.connected-context.completed",
    );
    const proof = expectActivityLogProof(
      "search.connected-context.completed.line",
      formatActivityLogProofLine(completed ?? {}),
    );
    expect(proof.usageFilesRead).toBeGreaterThanOrEqual(1);
    expect(proof.selectedFileCount).toBe(output.pack.files.length);
  });
});
