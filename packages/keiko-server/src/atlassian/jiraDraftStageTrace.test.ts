import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJiraDraftStore,
  executeJiraDraftStageTool,
  type AtlassianHttpBodyPort,
} from "@oscharko-dev/keiko-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { podFixture, type PodFixture } from "../_requirementSupport.js";
import { resetRequirementTurnCache } from "../requirement-inventory.js";
import { draftTool } from "./jiraChatCatalogRuntime.js";

const fixtures: PodFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  resetRequirementTurnCache();
});

function source(macro: string, second: boolean): string {
  return [
    "# Lastenheft",
    "",
    "### LH-001 Thema",
    "",
    "Das Portal unterstützt das Thema; die Bearbeitung ist innerhalb von 10 Minuten abgeschlossen.",
    "",
    "Abnahmekriterien:",
    `- ${macro}`,
    ...(second ? ["- Fehler zu Thema 1 werden gemeldet."] : []),
    "",
    "Priorität: Muss.",
    "",
  ].join("\n");
}

async function stage(
  text: string,
  description: string,
): Promise<Awaited<ReturnType<typeof executeJiraDraftStageTool>>> {
  const f = await podFixture([{ capsuleId: "cap-stage", text }]);
  fixtures.push(f);
  const http = vi.fn<AtlassianHttpBodyPort>(() => Promise.reject(new Error("no Jira read")));
  const context = {
    invocationId: "invocation",
    correlationId: "correlation",
    signal: new AbortController().signal,
    beforeEffect: (): boolean => true,
    chatId: f.chatId,
    userMessageId: "m-1",
  };
  const deps = draftTool(f.deps, createJiraDraftStore());
  const args = {
    items: [
      {
        ref: "traced",
        projectId: "10000",
        issueTypeId: "10001",
        fields: { summary: "Source requirement", description },
        requirementIds: ["LH-001"],
      },
    ],
  } as unknown as CatalogJsonObject;
  return executeJiraDraftStageTool(
    args,
    context as never,
    {
      deployment: "data-center",
      baseUrl: "https://jira.example.invalid/context",
      identity: "credential-1",
      http,
    },
    deps as never,
  );
}

describe("jira.draft-stage refuses a criterion without a checkable representation (F16)", () => {
  it.each([
    "{code} Return an error if authentication fails.",
    "{noformat} Reject an invalid signature.",
  ])("refuses a description that omits %s", async (macro) => {
    const result = await stage(
      source(macro, false),
      "## Acceptance criteria\n\n- Unrelated description.",
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result.data)).toContain("acceptance-criteria-missing");
    expect(JSON.stringify(result.data)).not.toContain("digest");
  });

  it.each([
    "{code} Return an error if authentication fails.",
    "{noformat} Reject an invalid signature.",
  ])("refuses a description holding only the ordinary sibling of %s", async (macro) => {
    const result = await stage(
      source(macro, true),
      "## Acceptance criteria\n\n- Fehler zu Thema 1 werden gemeldet.",
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result.data)).toContain("acceptance-criteria-missing");
  });
});
