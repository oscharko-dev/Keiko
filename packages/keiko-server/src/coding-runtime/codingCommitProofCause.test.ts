import { describe, expect, it } from "vitest";
import {
  classifyCommitProofFailure,
  isPermanentCommitProofCause,
} from "./codingCommitProofCause.js";
import { requireBornHead } from "../gitDelivery/verifiedCommitFacts.js";

const coded = (code: string): Error => Object.assign(new Error("PRIVATE_TEXT"), { code });

// #4491: an ordinary unborn branch is a committable state, so only a caller that needs an existing
// commit (a branch start point, a push) still meets the closed unborn-head cause.
describe("the unborn-head cause", () => {
  it("is produced only for a caller that requires a commit", () => {
    const unborn = { kind: "unborn", branch: "main", objectIdLength: 40 } as const;
    const failure = ((): unknown => {
      try {
        requireBornHead(unborn);
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(classifyCommitProofFailure(failure)).toBe("unborn-head");
    expect(requireBornHead({ kind: "born", sha: "a".repeat(40) })).toBe("a".repeat(40));
  });
});

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
