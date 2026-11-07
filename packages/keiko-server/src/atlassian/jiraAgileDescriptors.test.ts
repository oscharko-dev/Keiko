import { describe, expect, it } from "vitest";
import {
  JIRA_AGILE_READ_DEFINITIONS,
  JIRA_FILTER_READ_DEFINITIONS,
  JIRA_AGILE_WRITE_DEFINITIONS,
  jiraAgileDeclarationForTool,
} from "./jiraAgileDescriptors.js";

describe("native Agile declarations", () => {
  it("declares actual board and Epic destinations while sprint links name only board context", () => {
    expect(JIRA_AGILE_WRITE_DEFINITIONS["jira.board-create"].receipts).toHaveProperty("browseUrl");
    expect(JIRA_AGILE_WRITE_DEFINITIONS["jira.epic-update"].receipts).toHaveProperty("browseUrl");
    for (const operation of [
      "jira.sprint-create",
      "jira.sprint-update",
      "jira.sprint-move-issues",
    ] as const) {
      const receipt = JIRA_AGILE_WRITE_DEFINITIONS[operation].receipts;
      expect(receipt).toHaveProperty("originBoardId");
      expect(receipt).toHaveProperty("boardBrowseUrl");
      expect(receipt).not.toHaveProperty("browseUrl");
    }
  });
  it.each(Object.keys({ ...JIRA_AGILE_READ_DEFINITIONS, ...JIRA_FILTER_READ_DEFINITIONS }))(
    "declares only typed reads for %s",
    (name) => {
      const declaration = jiraAgileDeclarationForTool(name);
      expect(declaration?.risk).toBe("read");
      expect(declaration?.descriptor.toolRef.canonicalId).toBe(
        `keiko.${name.replaceAll("-", ".")}`,
      );
      expect(declaration?.descriptor.inputSchema.additionalProperties).toBe(false);
      expect(declaration?.descriptor.resultSchema.additionalProperties).toBe(false);
    },
  );
  it.each(Object.keys(JIRA_AGILE_WRITE_DEFINITIONS))(
    "requires governed idempotent dispatch for %s",
    (name) => {
      const declaration = jiraAgileDeclarationForTool(name);
      expect(declaration?.risk).toBe("write");
      expect(declaration?.descriptor.idempotency).toBe("server-key-required");
      expect(declaration?.descriptor.effects).toEqual(["connector-access"]);
      expect(declaration?.descriptor.inputSchema.additionalProperties).toBe(false);
      expect(declaration?.descriptor.resultSchema.additionalProperties).toBe(false);
    },
  );
  it("cannot declare an arbitrary native request", () => {
    expect(jiraAgileDeclarationForTool("jira.proxy")).toBeUndefined();
    expect(jiraAgileDeclarationForTool("constructor")).toBeUndefined();
  });
});
