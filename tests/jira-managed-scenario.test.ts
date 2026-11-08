import { describe, expect, it } from "vitest";
import { jiraManagedScenarios, type JiraManagedScenario } from "./support/jira-managed-scenario.js";

const ROWS = {
  "jira.synthetic-confirmed": {
    args: { expectedActorKey: "leaf-actor", enabled: false, orderedIds: ["82", "81"], value: null },
    receipt: { userKey: "gateway-actor", id: "9007199254740993", enabled: false },
    remoteState: { lifecycle: { orderedIds: ["82", "81"], description: "", value: null } },
    outcome: "succeeded",
  },
  "jira.synthetic-unconfirmed": {
    args: { expectedActorKey: "leaf-actor", expectedIds: ["7"] },
    receipt: { userKey: "gateway-actor", id: "7", present: false },
    remoteState: { lifecycle: [] },
    outcome: "succeeded-unconfirmed",
  },
} satisfies Readonly<Record<string, JiraManagedScenario>>;

describe("Independent managed Jira scenario assembly", () => {
  it("rebinds only the reviewed actor while preserving false, null, ordering and exact IDs", () => {
    const before = structuredClone(ROWS);
    const result = jiraManagedScenarios(ROWS, "gateway-actor");
    expect(result.arguments["jira.synthetic-confirmed"]).toEqual({
      expectedActorKey: "gateway-actor", enabled: false, orderedIds: ["82", "81"], value: null,
    });
    expect(result.receipts["jira.synthetic-confirmed"]).toEqual({
      userKey: "gateway-actor", id: "9007199254740993", enabled: false,
    });
    expect(result.remoteState["jira.synthetic-confirmed"]).toEqual({
      lifecycle: { orderedIds: ["82", "81"], description: "", value: null },
    });
    expect(ROWS).toEqual(before);
    expect(result.arguments["jira.synthetic-confirmed"]).not.toBe(ROWS["jira.synthetic-confirmed"].args);
  });

  it("never infers confirmation from a requested absence or an empty remote collection", () => {
    const result = jiraManagedScenarios(ROWS, "gateway-actor");
    expect(result.receipts["jira.synthetic-unconfirmed"]).toEqual({
      userKey: "gateway-actor", id: "7", present: false,
    });
    expect(result.remoteState["jira.synthetic-unconfirmed"]).toEqual({ lifecycle: [] });
    expect(result.expectedOutcome("jira.synthetic-unconfirmed")).toBe("succeeded-unconfirmed");
    expect(result.expectedOutcome("jira.synthetic-confirmed")).toBe("succeeded");
  });

  it("keeps exactly the supplied operation keys and refuses inherited or unknown outcomes", () => {
    const result = jiraManagedScenarios(ROWS, "gateway-actor");
    for (const table of [result.arguments, result.receipts, result.remoteState, result.outcomes]) {
      expect(Object.keys(table)).toEqual(["jira.synthetic-confirmed", "jira.synthetic-unconfirmed"]);
    }
    for (const name of ["jira.unknown", "constructor", "toString", "__proto__"]) {
      expect(result.expectedOutcome(name)).toBeUndefined();
    }
  });
});
