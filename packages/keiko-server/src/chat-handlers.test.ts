import { describe, expect, it } from "vitest";
import { MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS } from "@oscharko-dev/keiko-contracts/bff-wire";
import { parseClientTurnId, parseExpectedGroundingScopeIdentity } from "./chat-handlers.js";

const VALID_GROUNDING_SCOPE_IDENTITY = `gsi-v1:${"a".repeat(64)}`;
const INVALID_CLIENT_TURN_ID = {
  status: 400,
  body: {
    error: {
      code: "BAD_REQUEST",
      message: "clientTurnId must be a bounded non-blank string.",
    },
  },
} as const;

describe("parseClientTurnId", (): void => {
  it("preserves bounded opaque identifiers without normalizing their identity", (): void => {
    const paddedOpaqueId = "  opaque-id  ";
    const maximumLengthId = "x".repeat(MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS);

    expect(parseClientTurnId(undefined)).toBeUndefined();
    expect(parseClientTurnId(paddedOpaqueId)).toBe(paddedOpaqueId);
    expect(parseClientTurnId(maximumLengthId)).toBe(maximumLengthId);
  });

  it.each([
    null,
    "",
    " \t\r\n",
    "\u00a0\ufeff\u3000",
    "x".repeat(MAX_DESKTOP_CHAT_CLIENT_TURN_ID_CHARS + 1),
  ])("rejects an invalid identifier %#", (value): void => {
    expect(parseClientTurnId(value)).toEqual(INVALID_CLIENT_TURN_ID);
  });
});

describe("parseExpectedGroundingScopeIdentity", (): void => {
  it("passes through an omitted or valid server-issued identity", (): void => {
    expect(parseExpectedGroundingScopeIdentity(undefined)).toBeUndefined();
    expect(parseExpectedGroundingScopeIdentity(VALID_GROUNDING_SCOPE_IDENTITY)).toBe(
      VALID_GROUNDING_SCOPE_IDENTITY,
    );
  });

  it.each([null, "", "gsi-v1:not-a-digest", `gsi-v1:${"a".repeat(63)}`, { value: "forged" }])(
    "rejects an invalid or forged identity %#",
    (value): void => {
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
