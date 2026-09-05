import { parseRuntimeGitRequest } from "./codingRuntimeGitIpc.js";
import { describe, expect, it } from "vitest";
import { parseCodingToolRequest } from "./codingToolIpc.js";
const identity = { action: "git", actionId: "action-1", idempotencyKey: "key-1" };
const parse = (value: unknown): ReturnType<typeof parseCodingToolRequest> =>
  parseCodingToolRequest(JSON.stringify(value), 262_144);
describe("semantic runtime Git IPC", () => {
  it.each([
    { operation: "diff", scope: "index" },
    { operation: "stage", phase: "propose" },
  ])("captures immutable path operands at direct IPC admission %j", (fields) => {
    const paths = ["code.ts"];
    const request = parseRuntimeGitRequest({ ...identity, ...fields, paths }, identity);
    paths[0] = "other.ts";
    expect(request).toMatchObject({ paths: ["code.ts"] });
    expect(Object.isFrozen(request)).toBe(true);
    if (request === undefined || !("paths" in request)) throw new Error("request unavailable");
    expect(Object.isFrozen(request.paths)).toBe(true);
  });
  it.each([
    { operation: "status" },
    { operation: "ci" },
    { operation: "ci", forceFresh: true },
    { operation: "diff", scope: "working-tree", paths: ["code.ts"] },
    { operation: "diff", scope: "index", paths: ["code.ts"] },
    { operation: "stage", phase: "propose", paths: ["code.ts"] },
    { operation: "stage", phase: "execute", proposalId: "stage-123" },
  ])("admits the closed semantic request %j", (request) => {
    expect(parse({ ...identity, ...request })).toEqual({ ...identity, ...request });
  });
  it.each([
    // forceFresh is the documented optional flag of the ci observation (#3388); only a non-boolean
    // value is scope widening.
    { operation: "ci", forceFresh: "yes" },
    { operation: "ci", prNumber: 99 },
    { operation: "ci", headSha: "a".repeat(40) },
    { operation: "status", argv: ["status"] },
    { operation: "diff", scope: "index", paths: ["../outside"] },
    { operation: "stage", phase: "propose", paths: [] },
    { operation: "stage", phase: "propose", paths: ["code.ts", "code.ts"] },
    { operation: "stage", phase: "propose", paths: [".git/config"] },
    { operation: "stage", phase: "propose", paths: ["dir/"] },
    { operation: "stage", phase: "execute", proposalId: "stage-123", paths: ["extra.ts"] },
    { operation: "stage", phase: "execute", proposalId: "stage-123", root: "/tmp" },
  ])("refuses scope widening %j", (request) => {
    expect(parse({ ...identity, ...request })).toBeUndefined();
  });
});
