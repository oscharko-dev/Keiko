import { parseRuntimeGitRequest } from "./codingRuntimeGitIpc.js";
import {
  CODING_RUNTIME_GIT_MAX_PATHS,
  CODING_RUNTIME_GIT_MAX_STAGE_PATHS,
} from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-git";
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
    { operation: "ci", forceFresh: false },
    { operation: "diff", scope: "working-tree", paths: ["code.ts"] },
    { operation: "diff", scope: "index", paths: ["code.ts"] },
    { operation: "stage", phase: "propose", paths: ["code.ts"] },
    { operation: "stage", phase: "execute", proposalId: "stage-123" },
    // U-28: a path may name a directory, and "." names the whole workspace.
    { operation: "stage", phase: "propose", paths: ["src", "test"] },
    { operation: "stage", phase: "propose", paths: ["."] },
    { operation: "unstage", phase: "propose", paths: ["src"] },
  ])("admits the closed semantic request %j", (request) => {
    expect(parse({ ...identity, ...request })).toEqual({ ...identity, ...request });
  });
  it.each([
    // Freshness is a bounded observation intent; repository/PR identity remains server-owned.
    { operation: "ci", forceFresh: true, prNumber: 99 },
    { operation: "ci", forceFresh: true, headSha: "a".repeat(40) },
    { operation: "ci", forceFresh: "true" },
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
    { operation: "stage", phase: "propose", paths: ["../outside"] },
    { operation: "stage", phase: "propose", paths: ["src/../../outside"] },
    { operation: "stage", phase: "propose", paths: ["/abs"] },
    { operation: "stage", phase: "propose", paths: [".", "."] },
    { operation: "unstage", phase: "propose", paths: ["../outside"] },
    { operation: "stage", phase: "execute", proposalId: "stage-123", paths: ["extra.ts"] },
    { operation: "stage", phase: "execute", proposalId: "stage-123", root: "/tmp" },
  ])("refuses scope widening %j", (request) => {
    expect(parse({ ...identity, ...request })).toBeUndefined();
  });
});
// U-28: the request carries few entries (the model's context window), the proposal it expands to
// may bind many more (memory only).
describe("request path bound versus expanded stage bound", () => {
  const entries = (count: number): string[] =>
    Array.from({ length: count }, (_unused, at) => `dir${String(at)}`);
  it("admits exactly the request bound and refuses one more", () => {
    const request = { ...identity, operation: "stage", phase: "propose" };
    expect(parse({ ...request, paths: entries(CODING_RUNTIME_GIT_MAX_PATHS) })).toBeDefined();
    expect(parse({ ...request, paths: entries(CODING_RUNTIME_GIT_MAX_PATHS + 1) })).toBeUndefined();
  });
  it("keeps the expanded bound far above the request bound", () => {
    expect(CODING_RUNTIME_GIT_MAX_STAGE_PATHS).toBeGreaterThanOrEqual(
      10 * CODING_RUNTIME_GIT_MAX_PATHS,
    );
  });
});
