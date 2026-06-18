import { describe, expect, it } from "vitest";

import {
  completionRequestSupersedes,
  isResponseCurrent,
  shouldDiscardResponse,
} from "./completion-identity.js";
import type { EditorRequestIdentity } from "./types.js";

const req = (
  streamId: string,
  sequence: number,
  requestId = `${streamId}:${String(sequence)}`,
): EditorRequestIdentity => ({
  requestId,
  streamId,
  sequence,
});

describe("completionRequestSupersedes", () => {
  it("supersedes a lower sequence in the same stream", () => {
    expect(completionRequestSupersedes(req("s1", 2), req("s1", 1))).toBe(true);
  });

  it("does not supersede an equal sequence", () => {
    expect(completionRequestSupersedes(req("s1", 2), req("s1", 2))).toBe(false);
  });

  it("does not supersede a lower or equal sequence", () => {
    expect(completionRequestSupersedes(req("s1", 1), req("s1", 2))).toBe(false);
  });

  it("never supersedes across streams", () => {
    expect(completionRequestSupersedes(req("s2", 99), req("s1", 1))).toBe(false);
  });
});

describe("isResponseCurrent", () => {
  it("is current for an equal identity", () => {
    expect(isResponseCurrent(req("s1", 5), req("s1", 5))).toBe(true);
  });

  it("is stale for a lower sequence in the same stream", () => {
    expect(isResponseCurrent(req("s1", 4), req("s1", 5))).toBe(false);
  });

  it("is stale for a higher sequence in the same stream", () => {
    expect(isResponseCurrent(req("s1", 6), req("s1", 5))).toBe(false);
  });

  it("is stale for the same stream and sequence with a mismatched request id", () => {
    expect(isResponseCurrent(req("s1", 5, "foreign-request"), req("s1", 5))).toBe(false);
  });

  it("is stale across streams", () => {
    expect(isResponseCurrent(req("s2", 5), req("s1", 5))).toBe(false);
  });
});

describe("shouldDiscardResponse", () => {
  it("follows exact response identity", () => {
    const latest = req("s1", 5);

    expect(shouldDiscardResponse(latest, latest)).toBe(false);
    expect(shouldDiscardResponse(req("s1", 4), latest)).toBe(true);
    expect(shouldDiscardResponse(req("s1", 6), latest)).toBe(true);
    expect(shouldDiscardResponse(req("s1", 5, "foreign-request"), latest)).toBe(true);
    expect(shouldDiscardResponse(req("s2", 5), latest)).toBe(true);
  });
});
