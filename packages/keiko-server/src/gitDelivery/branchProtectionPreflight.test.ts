import { describe, expect, it } from "vitest";
import {
  githubOwnerAndRepoFromRemoteUrl,
  signatureRequirementOf,
} from "./branchProtectionPreflight.js";

describe("githubOwnerAndRepoFromRemoteUrl", () => {
  it.each([
    ["https://github.com/oscharko-dev/Keiko.git", "oscharko-dev/Keiko"],
    ["ssh://git@github.com/oscharko-dev/Keiko.git", "oscharko-dev/Keiko"],
    ["git@github.com:oscharko-dev/Keiko.git", "oscharko-dev/Keiko"],
  ])("derives a bounded repository operand from %s", (remoteUrl, expected) => {
    expect(githubOwnerAndRepoFromRemoteUrl(remoteUrl)).toBe(expected);
  });

  it.each([
    "https://example.com/oscharko-dev/Keiko.git",
    "https://github.com/oscharko-dev/../Keiko.git",
    "https://token@github.com/oscharko-dev/Keiko.git?credential=secret",
    "--hostname=evil",
  ])("rejects unsupported or ambiguous remote URL %s", (remoteUrl) => {
    expect(githubOwnerAndRepoFromRemoteUrl(remoteUrl)).toBeUndefined();
  });
});

describe("signatureRequirementOf", () => {
  it("does not collapse provider unavailability into not-required", () => {
    expect(signatureRequirementOf({ outcome: "unavailable" })).toBe("unavailable");
    expect(signatureRequirementOf({ outcome: "unprotected" })).toBe("not-required");
  });
});
