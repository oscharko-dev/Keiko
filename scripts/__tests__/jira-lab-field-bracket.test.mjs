import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";

const calls = [];
const failures = { restore: false, lift: false };
vi.mock("../testing/jira-chat-lab/seed-admin.mjs", () => ({
  withLabAdmin: async (_session, run) => run("page"),
  setFixtureFieldRequirement: async (_page, _session, required) => {
    calls.push(required);
    if (!required && failures.lift) throw new TypeError("lift refused");
    if (required && failures.restore) throw new TypeError("restore refused");
  },
  configureFixtureTransition: async () => undefined,
}));
const { withFixtureFieldOptional, recoverFixtureFieldRequirement } =
  await import("../testing/jira-chat-lab/seed-fields.mjs");

const directories = [];
afterEach(() => {
  vi.restoreAllMocks();
  calls.length = 0;
  failures.restore = false;
  failures.lift = false;
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

const marker = (lab) => join(lab.directory, "required-field-lifted.json");
const FIELD = [{ name: "Keiko required text" }];

it("holds a private marker while the requirement is lifted and removes it afterwards", async () => {
  const lab = session(FIELD);
  await withFixtureFieldOptional(lab, async () => {
    expect(existsSync(marker(lab))).toBe(true);
  });
  expect(existsSync(marker(lab))).toBe(false);
});

it("restores first when a crashed run left its marker", async () => {
  const lab = session(FIELD);
  writeFileSync(marker(lab), "{}");
  await withFixtureFieldOptional(lab, async () => undefined);
  expect(calls).toEqual([true, false, true]);
  writeFileSync(marker(lab), "{}");
  expect(await recoverFixtureFieldRequirement(lab)).toBe(true);
  expect(await recoverFixtureFieldRequirement(lab)).toBe(false);
  expect(existsSync(marker(lab))).toBe(false);
});

it("keeps the work's own error when the restore also fails, and the marker for recovery", async () => {
  const lab = session(FIELD);
  failures.restore = true;
  const error = await withFixtureFieldOptional(lab, async () => {
    throw new TypeError("bulk refused");
  }).catch((value) => value);
  expect(error.message).toBe("bulk refused");
  expect(error.cause.message).toBe("restore refused");
  expect(existsSync(marker(lab))).toBe(true);
});

it("reports a failed restore after successful work", async () => {
  const lab = session(FIELD);
  failures.restore = true;
  await expect(withFixtureFieldOptional(lab, async () => 1)).rejects.toThrow("restore refused");
  expect(existsSync(marker(lab))).toBe(true);
});

it("restores the requirement when lifting it fails partway", async () => {
  const lab = session(FIELD);
  failures.lift = true;
  await expect(withFixtureFieldOptional(lab, async () => 1)).rejects.toThrow("lift refused");
  expect(calls).toEqual([false, true]);
  expect(existsSync(marker(lab))).toBe(false);
});

it("records a failed restore even when the work's error already has a cause", async () => {
  const lab = session(FIELD);
  failures.restore = true;
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = await withFixtureFieldOptional(lab, async () => {
    throw new TypeError("bulk refused", { cause: new Error("original cause") });
  }).catch((value) => value);
  expect(error.message).toBe("bulk refused");
  expect(error.cause.message).toBe("original cause");
  expect(log).toHaveBeenCalledWith(expect.stringContaining('"restoreFailed":true'));
  expect(existsSync(marker(lab))).toBe(true);
});
