// The shared two-role recommendation and preflight (Issue #4137): the second role prefers a model
// different from the first and falls back to the same model only when no other one qualifies.

import { describe, expect, it } from "vitest";

import type { ModelCapability } from "@oscharko-dev/keiko-contracts";

import { preflightRoles } from "./preflight.js";
import {
  compareContextWindowDesc,
  indexedChatCapabilities,
  pickRoleModel,
  recommendRolePair,
  type IndexedCapability,
} from "./recommendation.js";

function model(
  id: string,
  contextWindow: number,
  kind: ModelCapability["kind"] = "chat",
): ModelCapability {
  return { id, kind, contextWindow } as ModelCapability;
}

const byWindow = (a: IndexedCapability, b: IndexedCapability): number =>
  compareContextWindowDesc(a.capability.contextWindow, b.capability.contextWindow) ||
  a.index - b.index;
const any = (): boolean => true;

describe("shared role recommendation", () => {
  const candidates = indexedChatCapabilities([
    model("small", 8_000),
    model("embed", 999_999, "embedding"),
    model("large", 128_000),
    model("medium", 32_000),
  ]);

  it("keeps the configured index of every chat model and drops other kinds", () => {
    expect(candidates.map((entry) => [entry.capability.id, entry.index])).toEqual([
      ["small", 0],
      ["large", 2],
      ["medium", 3],
    ]);
  });

  it("prefers a different second model and falls back to the same one when it is the only one", () => {
    expect(
      recommendRolePair(
        candidates,
        { eligible: any, order: byWindow },
        { eligible: any, order: byWindow },
      ),
    ).toMatchObject({
      first: { id: "large" },
      second: { id: "medium" },
      singleModel: false,
    });
    const only = (capability: ModelCapability): boolean => capability.id === "large";
    expect(
      recommendRolePair(
        candidates,
        { eligible: any, order: byWindow },
        { eligible: only, order: byWindow },
      ),
    ).toMatchObject({ first: { id: "large" }, second: { id: "large" }, singleModel: true });
    expect(pickRoleModel(candidates, () => false, byWindow)).toBeUndefined();
  });

  it("orders a placeholder window after every known window", () => {
    const placeholder = indexedChatCapabilities([model("unknown", 0), model("known", 4_096)]);
    expect(pickRoleModel(placeholder, any, byWindow)?.id).toBe("known");
  });

  it("preflights every role in order and collects every result", async () => {
    const seen: string[] = [];
    const results = await preflightRoles(["first", "second"] as const, (role) => {
      seen.push(role);
      return Promise.resolve(role.length);
    });
    expect(seen).toEqual(["first", "second"]);
    expect([...results.entries()]).toEqual([
      ["first", 5],
      ["second", 6],
    ]);
  });
});
