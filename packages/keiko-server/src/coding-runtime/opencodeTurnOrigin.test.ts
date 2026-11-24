import { describe, expect, it } from "vitest";
import {
  KEIKO_CONTINUATION_ORIGINS,
  keikoContinuationOrigin,
  OPENCODE_TURN_ORIGIN_METADATA,
} from "./opencodeTurnOrigin.js";
import { OPENCODE_TURN_ORIGIN_METADATA as CLIENT_METADATA_KEY } from "./opencodeV2HttpClient.js";

describe("keikoContinuationOrigin", () => {
  it.each(KEIKO_CONTINUATION_ORIGINS)("reads %s from the message's own metadata", (origin) => {
    expect(keikoContinuationOrigin({ [OPENCODE_TURN_ORIGIN_METADATA]: origin })).toBe(origin);
  });

  it.each([
    ["no metadata", undefined],
    ["null", null],
    ["a string", "verification-continuation"],
    ["another key", { other: "verification-continuation" }],
    ["an unknown word", { [OPENCODE_TURN_ORIGIN_METADATA]: "schedule-wake" }],
    ["a non-string", { [OPENCODE_TURN_ORIGIN_METADATA]: 1 }],
  ])("reads no origin from %s", (_label, metadata) => {
    expect(keikoContinuationOrigin(metadata)).toBeUndefined();
  });

  it("is the one key the HTTP client stamps", () => {
    expect(CLIENT_METADATA_KEY).toBe(OPENCODE_TURN_ORIGIN_METADATA);
  });
});
