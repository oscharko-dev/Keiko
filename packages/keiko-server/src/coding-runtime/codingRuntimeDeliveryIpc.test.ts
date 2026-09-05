import { describe, expect, it } from "vitest";
import { parseCodingToolRequest } from "./codingToolIpc.js";
const base = {
  action: "delivery",
  actionId: "action-1",
  idempotencyKey: "action-1",
  intent: "push",
  phase: "propose",
};
function parse(value: unknown): ReturnType<typeof parseCodingToolRequest> {
  return parseCodingToolRequest(JSON.stringify(value), 65536);
}
describe("bounded semantic delivery IPC", () => {
  it.each(["push", "pull-request"])(
    "admits server-proposed %s IDs and read-only reconciliation",
    (intent) => {
      expect(parse({ ...base, intent, phase: "execute", proposalId: "delivery-123" })).toEqual({
        ...base,
        intent,
        phase: "execute",
        proposalId: "delivery-123",
      });
      expect(parse({ ...base, intent, phase: "reconcile" })).toEqual({
        ...base,
        intent,
        phase: "reconcile",
      });
    },
  );
  it.each([
    "body",
    "root",
    "cwd",
    "repository",
    "ownerAndRepo",
    "remoteAlias",
    "remoteUrl",
    "baseRef",
    "headRef",
    "headSha",
    "argv",
    "env",
    "stdin",
    "forcePush",
    "isDraft",
    "approvalToken",
    "approvalProof",
  ])("refuses model-supplied %s on all remote phases", (key) => {
    for (const request of [
      base,
      { ...base, intent: "pull-request", title: "feat: change" },
      { ...base, phase: "execute", proposalId: "delivery-123" },
      { ...base, phase: "reconcile" },
    ])
      expect(parse({ ...request, [key]: "forged" })).toBeUndefined();
  });
  it.each([
    "delivery-",
    "delivery-abc",
    "commit-123",
    "delivery-" + "1".repeat(40),
    "delivery-12\n",
    "../delivery-1",
  ])("rejects invalid proposal %j", (proposalId) => {
    expect(parse({ ...base, phase: "execute", proposalId })).toBeUndefined();
  });
  it.each(["", " ", "x\0y", "x\ny", "x\ry", "é".repeat(129)])(
    "rejects an invalid title %j",
    (title) => {
      expect(parse({ ...base, intent: "pull-request", title })).toBeUndefined();
    },
  );
  it("does not extend merge or legacy commit shapes", () => {
    expect(parse({ ...base, intent: "merge" })).toBeUndefined();
    expect(parse({ ...base, intent: "commit", phase: "reconcile" })).toBeUndefined();
    expect(parse({ ...base, title: "not a push operand" })).toBeUndefined();
  });
  it("snapshots request operands before returning the admitted object", () => {
    const request = { ...base, intent: "pull-request", title: "feat: reviewed" };
    const admitted = parse(request);
    request.title = "Closes #999";
    expect(admitted).toMatchObject({ title: "feat: reviewed" });
    expect(Object.isFrozen(admitted)).toBe(true);
  });
});
