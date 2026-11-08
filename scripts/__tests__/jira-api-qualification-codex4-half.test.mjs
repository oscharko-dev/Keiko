import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it } from "vitest";
import { API_QUALIFICATION_ALL_CASES } from "../testing/jira-chat-lab/api-qualification-case-list.mjs";

// Fixed handoff scope: operations 1–51 minus the three deferred identities (#4321) from the agreed Codex 4 / integrator split.
// The separate completeness test continues to require all 439 native inventory identities.
const assigned = JSON.parse(
  readFileSync(new URL("./fixtures/jira-ac7-codex4-half.json", import.meta.url), "utf8"),
);
const ledger = JSON.parse(
  readFileSync(
    new URL("../../docs/local-knowledge/jira-api-coverage/operations.json", import.meta.url),
    "utf8",
  ),
);

it("pins exactly 48 distinct assigned tool-to-native bindings in the handoff fixture", () => {
  expect(assigned).toHaveLength(48);
  expect(new Set(assigned.map((row) => row.tool)).size).toBe(48);
  expect(new Set(assigned.map((row) => row.identity)).size).toBe(48);
  for (const row of assigned) {
    expect(Object.keys(row).sort()).toEqual(["identity", "tool"]);
    expect(row.tool).toMatch(/^jira\.[a-z-]+$/u);
    expect(row.identity).toMatch(/^(?:GET|POST|PUT|DELETE) \/rest\//u);
  }
});

it("keeps every registered recipe tool and its native identity unique across all case arrays", () => {
  const tools = new Set();
  const identities = new Set();
  for (const entry of API_QUALIFICATION_ALL_CASES) {
    expect(tools.has(entry.tool), entry.tool).toBe(false);
    tools.add(entry.tool);
    const capability = ledger.currentCapabilities[entry.tool];
    expect(capability, entry.tool).toBeDefined();
    expect(identities.has(capability.identity), capability.identity).toBe(false);
    identities.add(capability.identity);
  }
  expect(tools.size).toBe(API_QUALIFICATION_ALL_CASES.length);
  expect(identities.size).toBe(API_QUALIFICATION_ALL_CASES.length);
});

it.each(assigned)(
  "registers $tool exactly once with the assigned $identity contract",
  ({ tool, identity }) => {
    const matches = API_QUALIFICATION_ALL_CASES.filter((entry) => entry.tool === tool);
    expect(matches, tool).toHaveLength(1);
    const entry = matches[0];
    const capability = ledger.currentCapabilities[tool];
    expect(capability, tool).toBeDefined();
    expect(capability.identity).toBe(identity);
    const nativeRows = ledger.operations.filter((row) => row.identity === identity);
    expect(nativeRows, identity).toHaveLength(1);
    expect(nativeRows[0].currentCapabilityIds).toContain(tool);
    expect(`${nativeRows[0].method} ${nativeRows[0].path}`).toBe(identity);
    expect(typeof entry.arguments, tool).toBe("function");
    expect(typeof entry.readback, tool).toBe("function");
    expect(new Set(["read", "write"]).has(capability.effect), tool).toBe(true);
    expect(entry.mutation === true, tool).toBe(capability.effect === "write");
  },
);
