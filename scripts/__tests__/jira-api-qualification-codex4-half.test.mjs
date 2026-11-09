import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";
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

it("gives the update-myself cleanup write its protected login input owner", async () => {
  const entry = API_QUALIFICATION_ALL_CASES.find((row) => row.tool === "jira.update-myself");
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-myself-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  const native = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () =>
        new globalThis.Response(
          JSON.stringify({ key: "K", name: "keiko-admin", displayName: "D", active: true }),
          { status: 200 },
        ),
    );
  const written = [];
  try {
    await entry.cleanup(
      {
        session: { ...DEFAULT_LAB_CONNECTION, directory },
        actor: "admin",
        qualificationFixture: async (fixtureEntry) => {
          written.push(fixtureEntry);
        },
      },
      { adminActorKey: "K", myselfBefore: { displayName: "D" } },
    );
    expect(written).toHaveLength(1);
    expect(written[0].tool).toBe("jira.update-myself");
    expect(typeof written[0].publishHumanInput).toBe("function");
  } finally {
    native.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  [403, '{"message":"The request was rejected due to two-step verification being enabled."}', true],
  [403, '{"message":"CAPTCHA required"}', false],
  [401, '{"message":"two-step verification"}', false],
])(
  "recognizes a two-step-verification login refusal only for %s %s",
  async (status, body, refused) => {
    const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-login-"));
    mkdirSync(join(directory, "secrets"));
    writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
    const native = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new globalThis.Response(body, { status }));
    try {
      const { nativeLoginRefusedByTwoStep } =
        await import("../testing/jira-chat-lab/api-qualification-integrator-c-cases.mjs");
      await expect(
        nativeLoginRefusedByTwoStep({ session: { ...DEFAULT_LAB_CONNECTION, directory } }),
      ).resolves.toBe(refused);
    } finally {
      native.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
