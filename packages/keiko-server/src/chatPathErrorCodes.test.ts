import { describe, expect, it } from "vitest";
import { CHAT_PATH_ERROR_CODES } from "@oscharko-dev/keiko-contracts/bff-wire";
import { ERROR_CODES } from "@oscharko-dev/keiko-model-gateway";

// #4355: the Chat words every code a person can reach on its path. The gateway's codes are the
// largest class and the one a customer's gateway operator meets, so they are pinned to the
// gateway's own taxonomy: a code added there without its place in the Chat's vocabulary (and so,
// through the Chat's table, without text) fails here.
describe("the Chat error code vocabulary", () => {
  it("contains every gateway error code", () => {
    const vocabulary: readonly string[] = CHAT_PATH_ERROR_CODES;
    for (const code of Object.values(ERROR_CODES)) expect(vocabulary, code).toContain(code);
  });

  it("lists each code once", () => {
    expect(new Set(CHAT_PATH_ERROR_CODES).size).toBe(CHAT_PATH_ERROR_CODES.length);
  });
});
