import { describe, expect, it } from "vitest";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import {
  recordJiraCatalogSelection,
  recordJiraCatalogSelectionRefused,
} from "./jiraCatalogSelectionActivity.js";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";

describe("recordJiraCatalogSelection", () => {
  it("records retained, added and dropped operations as counts under the turn correlation", () => {
    const logs = createBufferedServerLogSink();
    recordJiraCatalogSelection(logs, {
      correlationId: "jira-selection-proof",
      surface: "chat",
      previous: ["POST /rest/api/2/project", "GET /rest/api/2/mypermissions"],
      selected: ["GET /rest/api/2/mypermissions", "GET /rest/api/2/project/type"],
    });
    const event = logs.events.find((entry) => entry.op === "jira.catalog.selection");
    expect(event?.extra).toMatchObject({
      surface: "chat",
      selectedCount: 2,
      retainedCount: 1,
      deselectedCount: 1,
    });
    const line = formatActivityLogProofLine(event ?? {});
    expectActivityLogProof("jira.catalog.selection.line", line);
    expect(line).not.toMatch(/rest\/api|mypermissions|project\/type/u);
    expect(analyzeLogText(line).timelines).toMatchObject([
      { correlationId: "jira-selection-proof", lines: [{ op: "jira.catalog.selection" }] },
    ]);
  });

  it("counts a first selection and a repeated identity once", () => {
    const logs = createBufferedServerLogSink();
    recordJiraCatalogSelection(logs, {
      correlationId: "jira-selection-first",
      surface: "coding",
      previous: [],
      selected: ["GET /synthetic", "GET /synthetic"],
    });
    expect(logs.events.find((entry) => entry.op === "jira.catalog.selection")?.extra).toMatchObject(
      { surface: "coding", selectedCount: 1, retainedCount: 0, deselectedCount: 0 },
    );
  });

  it("records a refused selection's counts and the part that reached the bound, never its content", () => {
    const logs = createBufferedServerLogSink();
    const bound = TOOL_CATALOG_LIMITS.maxArgumentBytes;
    recordJiraCatalogSelectionRefused(logs, {
      correlationId: "jira-selection-refused-proof",
      surface: "chat",
      requestedCount: 7,
      parts: {
        catalog: { secret: "x".repeat(bound) },
        projection: { tools: [] },
        offered: { toolRefs: [] },
      },
    });
    const event = logs.events.find((entry) => entry.op === "jira.catalog.selection-refused");
    expect(event?.extra).toMatchObject({
      surface: "chat",
      requestedCount: 7,
      boundBytes: bound,
      exceeded: "catalog",
      projectionBytes: JSON.stringify({ tools: [] }).length,
      offeredBytes: JSON.stringify({ toolRefs: [] }).length,
    });
    expect(event?.extra?.catalogBytes).toBeGreaterThan(bound);
    const line = formatActivityLogProofLine(event ?? {});
    expectActivityLogProof("jira.catalog.selection-refused.line", line);
    expect(line).not.toContain("xxxxxxxx");
    expect(analyzeLogText(line).timelines).toMatchObject([
      {
        correlationId: "jira-selection-refused-proof",
        lines: [{ op: "jira.catalog.selection-refused" }],
      },
    ]);
  });

  it("says a selection refused before its catalog was built has no sizes to report", () => {
    const logs = createBufferedServerLogSink();
    recordJiraCatalogSelectionRefused(logs, {
      correlationId: "jira-selection-not-built",
      surface: "chat",
      requestedCount: 99,
    });
    expect(
      logs.events.find((entry) => entry.op === "jira.catalog.selection-refused")?.extra,
    ).toMatchObject({
      requestedCount: 99,
      catalogBytes: 0,
      projectionBytes: 0,
      offeredBytes: 0,
      exceeded: "not-built",
    });
  });
});
