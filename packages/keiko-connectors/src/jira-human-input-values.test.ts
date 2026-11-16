import { describe, expect, it } from "vitest";
import { privateJiraCustodyFixture } from "../../../tests/support/jira-private-custody-fixture.js";
import {
  copyHumanInputBinding,
  humanInputReference,
  parseHumanInputRecord,
} from "./jira-human-input-values.js";

describe("private human input operation correlation", () => {
  it("retains the operation in sealed custody across restart without exposing it in the public view", () => {
    const f = privateJiraCustodyFixture("jira.login");
    const binding = { ...f.binding, operationCorrelationId: "originating-operation-proof" };
    const view = f.inputs.prepare(binding);
    const restarted = f.fork().custody.humanInputs;
    expect(restarted?.bindingFor(view.requestId, binding.principalDigest)).toEqual(binding);
    expect(restarted?.inspect(view.requestId, binding)).toEqual(view);
    expect(view).not.toHaveProperty("operationCorrelationId");
    expect(JSON.stringify(view)).not.toContain(binding.operationCorrelationId);
  });

  it("preserves the legacy serialized binding and request identity without adding a correlation", () => {
    const f = privateJiraCustodyFixture("jira.login");
    const view = f.inputs.prepare(f.binding);
    const reference = humanInputReference(view.requestId);
    if (reference === undefined) throw new TypeError("Missing input reference");
    const serialized = f.sealedPortEntries.get(reference);
    if (serialized === undefined) throw new TypeError("Missing sealed input record");
    const parsed = parseHumanInputRecord(serialized);
    expect(parsed?.requestId).toBe(view.requestId);
    expect(parsed?.binding).toEqual(f.binding);
    expect(parsed?.binding).not.toHaveProperty("operationCorrelationId");
    expect(JSON.stringify(parsed)).toBe(serialized);
  });

  it.each([undefined, null, "short", "line\nbreak", "x".repeat(129)])(
    "refuses an explicitly invalid operation correlation %s",
    (operationCorrelationId) => {
      const f = privateJiraCustodyFixture("jira.login");
      expect(copyHumanInputBinding({ ...f.binding, operationCorrelationId })).toBeUndefined();
    },
  );
});
