import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";

const calls = [];
vi.mock("../testing/jira-chat-lab/seed-admin.mjs", () => ({
  withLabAdmin: async (_session, run) => run("page"),
  setFixtureFieldRequirement: async (_page, _session, required) => {
    calls.push(required);
  },
  configureFixtureTransition: async () => undefined,
}));
const { withFixtureFieldOptional } = await import("../testing/jira-chat-lab/seed-fields.mjs");

const directories = [];
afterEach(() => {
  vi.restoreAllMocks();
  calls.length = 0;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
function session(fields) {
  const directory = mkdtempSync(join(tmpdir(), "keiko-field-bracket-"));
  directories.push(directory);
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic", { mode: 0o600 });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new globalThis.Response(JSON.stringify(fields), { status: 200 }),
  );
  return { ...DEFAULT_LAB_CONNECTION, directory };
}

it("lifts the qualification requirement for the work and restores it afterwards", async () => {
  const result = await withFixtureFieldOptional(
    session([{ id: "customfield_10000", name: "Keiko required text" }]),
    async () => {
      expect(calls).toEqual([false]);
      return "done";
    },
  );
  expect(result).toBe("done");
  expect(calls).toEqual([false, true]);
});

it("restores the requirement when the work fails", async () => {
  await expect(
    withFixtureFieldOptional(session([{ name: "Keiko required text" }]), async () => {
      throw new TypeError("bulk refused");
    }),
  ).rejects.toThrow("bulk refused");
  expect(calls).toEqual([false, true]);
});

it("leaves a lab without the qualification field untouched", async () => {
  expect(await withFixtureFieldOptional(session([{ name: "Other" }]), async () => 7)).toBe(7);
  expect(calls).toEqual([]);
});
