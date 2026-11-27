import { describe, expect, it } from "vitest";
import {
  classifyCommitProofFailure,
  isPermanentCommitProofCause,
} from "./codingCommitProofCause.js";

const coded = (code: string): Error => Object.assign(new Error("PRIVATE_TEXT"), { code });

describe("classifyCommitProofFailure", () => {
  it.each([
    [coded("git-raw-unborn-head"), "unborn-head", true],
    [coded("git-raw-snapshot-incomplete"), "snapshot-incomplete", true],
    [coded("git-raw-snapshot-drift"), "snapshot-drift", false],
    [coded("git-raw-read-cancelled"), "read-cancelled", false],
    [coded("TOOL_COMMAND_TIMEOUT"), "read-timeout", false],
    [coded("WORKSPACE_PATH_ESCAPE"), "path-denied", true],
    [new Error("git-stage-path-denied"), "path-denied", true],
    [new Error("git-stage-link-denied"), "link-denied", true],
    [new Error("workspace-descriptor-read-not-regular"), "entry-unreadable", true],
    [new Error("git-stage-file-incomplete"), "entry-unreadable", true],
    [new Error("git rev-parse exited 128"), "read-failed", false],
    ["not an error", "read-failed", false],
  ] as const)("maps %s to %s without reading free text", (error, cause, permanent) => {
    expect(classifyCommitProofFailure(error)).toBe(cause);
    expect(isPermanentCommitProofCause(cause)).toBe(permanent);
  });
});
