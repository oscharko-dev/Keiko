import { describe, expect, it } from "vitest";

import {
  completionRequestSupersedes,
  isResponseCurrent,
  shouldDiscardResponse,
} from "./completion-identity.js";
import type { EditorRequestIdentity } from "./types.js";

const req = (streamId: string, sequence: number): EditorRequestIdentity => ({
  requestId: `${streamId}:${String(sequence)}`,
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
  it("is current for an equal sequence", () => {
    expect(isResponseCurrent(req("s1", 5), req("s1", 5))).toBe(true);
  });

  it("is current for a newer sequence", () => {
    expect(isResponseCurrent(req("s1", 6), req("s1", 5))).toBe(true);
  });

  it("is stale for an older sequence in the same stream", () => {
    expect(isResponseCurrent(req("s1", 4), req("s1", 5))).toBe(false);
  });

  it("is stale across streams", () => {
    expect(isResponseCurrent(req("s2", 5), req("s1", 5))).toBe(false);
  });
});

describe("shouldDiscardResponse", () => {
  it("is the negation of isResponseCurrent", () => {
    const response = req("s1", 4);
    const latest = req("s1", 5);
    expect(shouldDiscardResponse(response, latest)).toBe(!isResponseCurrent(response, latest));
    expect(shouldDiscardResponse(req("s1", 5), req("s1", 5))).toBe(false);
    expect(shouldDiscardResponse(req("s1", 3), req("s1", 5))).toBe(true);
  });

  it("discards a cross-stream response regardless of sequence", () => {
    expect(shouldDiscardResponse(req("s2", 99), req("s1", 1))).toBe(true);
    expect(shouldDiscardResponse(req("s2", 1), req("s1", 99))).toBe(true);
  });
});
