import { describe, expect, it } from "vitest";
import { parsedAutonomyPolicyUpdate } from "./autonomyPolicyRequest.js";

describe("parsedAutonomyPolicyUpdate", (): void => {
  it("accepts each product mode the contracts define", (): void => {
    expect(
      parsedAutonomyPolicyUpdate('{"requestedMode":"governed-assist","expectedRevision":0}'),
    ).toEqual({ requestedMode: "governed-assist", expectedRevision: 0 });
    expect(
      parsedAutonomyPolicyUpdate('{"requestedMode":"supervised-coding","expectedRevision":2}'),
    ).toEqual({ requestedMode: "supervised-coding", expectedRevision: 2 });
    expect(
      parsedAutonomyPolicyUpdate('{"requestedMode":"autonomous-delivery","expectedRevision":3}'),
    ).toEqual({ requestedMode: "autonomous-delivery", expectedRevision: 3 });
  });

  it.each([
    ["an absent body", null],
    ["invalid JSON", "{requestedMode:"],
    ["a JSON primitive", '"governed-assist"'],
    ["a JSON array", '["governed-assist"]'],
    ["JSON null", "null"],
    ["a missing mode", "{}"],
    ["an unknown mode", '{"requestedMode":"root-access","expectedRevision":0}'],
    ["a non-string mode", '{"requestedMode":42,"expectedRevision":0}'],
    ["a case-shifted mode", '{"requestedMode":"Governed-Assist","expectedRevision":0}'],
    ["a missing revision", '{"requestedMode":"governed-assist"}'],
    ["a negative revision", '{"requestedMode":"governed-assist","expectedRevision":-1}'],
    ["a fractional revision", '{"requestedMode":"governed-assist","expectedRevision":1.5}'],
  ])("refuses %s", (_label, payload): void => {
    expect(parsedAutonomyPolicyUpdate(payload)).toBeNull();
  });
});
