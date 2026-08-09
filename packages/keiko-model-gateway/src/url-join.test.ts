import { describe, expect, it } from "vitest";
import { trimTrailingSlash } from "./config.js";

describe("trimTrailingSlash", () => {
  it("removes exactly one trailing slash", () => {
    // LiteLLM production audit: 'https://litellm.example.com/v1/' + '/chat/completions' yields
    // '//chat/completions', which LiteLLM answers with a 404.
    expect(trimTrailingSlash("https://litellm.example.com/v1/")).toBe(
      "https://litellm.example.com/v1",
    );
  });

  it("returns a URL without a trailing slash unchanged", () => {
    // The other branch: an unconditional slice(0, -1) would eat the last path character.
    expect(trimTrailingSlash("https://litellm.example.com/v1")).toBe(
      "https://litellm.example.com/v1",
    );
  });

  it("removes only the last slash of a doubled suffix", () => {
    // One owner, one rule: the helper is not a normalizer — it strips a single trailing slash,
    // exactly like every call site it replaces did (review finding on #3042).
    expect(trimTrailingSlash("https://litellm.example.com/v1//")).toBe(
      "https://litellm.example.com/v1/",
    );
  });

  it("leaves an empty string untouched", () => {
    expect(trimTrailingSlash("")).toBe("");
  });
});
