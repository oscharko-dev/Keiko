import { describe, expect, it } from "vitest";

import { debugActivationWorkspaceFingerprint } from "./debugActivationEvidence.js";

describe("debug activation evidence", () => {
  it("derives a stable opaque workspace fingerprint without retaining activation state", () => {
    const workspace = "/private/workspace";

    const fingerprint = debugActivationWorkspaceFingerprint(workspace);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprint).not.toContain(workspace);
    expect(debugActivationWorkspaceFingerprint(workspace)).toBe(fingerprint);
  });
});
