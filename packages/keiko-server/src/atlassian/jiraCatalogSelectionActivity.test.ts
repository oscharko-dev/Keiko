import { describe, expect, it } from "vitest";
import { analyzeLogText } from "@oscharko-dev/keiko-activity-log/reader";
import { recordJiraCatalogSelection } from "./jiraCatalogSelectionActivity.js";
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
});
