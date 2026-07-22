import { describe, expect, it } from "vitest";
import { parseExpectedGroundingScopeIdentity } from "./chat-handlers.js";

const VALID_GROUNDING_SCOPE_IDENTITY = `gsi-v1:${"a".repeat(64)}`;

describe("parseExpectedGroundingScopeIdentity", () => {
  it("passes through an omitted or valid server-issued identity", () => {
    expect(parseExpectedGroundingScopeIdentity(undefined)).toBeUndefined();
    expect(parseExpectedGroundingScopeIdentity(VALID_GROUNDING_SCOPE_IDENTITY)).toBe(
      VALID_GROUNDING_SCOPE_IDENTITY,
    );
  });

  it.each([null, "", "gsi-v1:not-a-digest", `gsi-v1:${"a".repeat(63)}`, { value: "forged" }])(
    "rejects an invalid or forged identity %#",
    (value) => {
      expect(parseExpectedGroundingScopeIdentity(value)).toEqual({
        status: 400,
        body: {
          error: {
            code: "BAD_REQUEST",
            message: "expectedGroundingScopeIdentity must be a valid server-issued identity.",
          },
        },
      });
    },
  );
});
