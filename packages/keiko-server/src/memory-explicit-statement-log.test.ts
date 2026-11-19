// #4223: the closed vocabularies of `memory.explicit.forget` follow the contracts they restate. The
// registration needs literal lists, so a kind added to a union must fail here, not at the sink.

import { describe, expect, it } from "vitest";
import { MEMORY_SCOPE_KINDS } from "@oscharko-dev/keiko-contracts/runtime/memory";
import type { ForgetSelector } from "@oscharko-dev/keiko-memory-governance";

import {
  MEMORY_FORGET_SCOPE_KINDS,
  MEMORY_FORGET_SELECTOR_KINDS,
} from "./memory-explicit-statement-log.js";

// A kind added to or removed from the governance selector fails to compile here.
const EVERY_SELECTOR_KIND: Record<ForgetSelector["kind"], true> = {
  "by-id": true,
  "by-scope": true,
  "by-type": true,
  "by-source-conversation": true,
  "by-time-window": true,
};

describe("memory.explicit.forget vocabularies", () => {
  it("lists exactly the contract's scope kinds", () => {
    expect([...MEMORY_FORGET_SCOPE_KINDS].sort()).toEqual([...MEMORY_SCOPE_KINDS].sort());
  });

  it("lists every selector kind and the statement that nothing was stored from", () => {
    expect([...MEMORY_FORGET_SELECTOR_KINDS].sort()).toEqual(
      [...Object.keys(EVERY_SELECTOR_KIND), "statement"].sort(),
    );
  });
});
