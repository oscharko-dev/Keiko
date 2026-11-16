// A retained required-field marker is recovered before any seed skip path (#4352).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const recover = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../testing/jira-chat-lab/seed-fields.mjs", () => ({
  recoverFixtureFieldRequirement: recover,
  withFixtureFieldOptional: async () => {
    throw new TypeError("a skipped seed must not lift the requirement");
  },
}));
const { main } = await import("../testing/jira-chat-lab/requirements/seed-projects.mjs");

const directories = [];
afterEach(() => {
  recover.mockClear();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function seededLab(truth) {
  const directory = mkdtempSync(join(tmpdir(), "keiko-seed-recovery-"));
  directories.push(directory);
  mkdirSync(join(directory, "secrets"), { mode: 0o700 });
  writeFileSync(join(directory, "secrets", "admin-password"), "synthetic", { mode: 0o600 });
  writeFileSync(
    join(directory, "session.json"),
    JSON.stringify({
      schemaVersion: 1,
      syntheticOnly: true,
      project: "keiko-jira-4081-seed-recovery",
      httpPort: 18080,
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(directory, "requirements-truth.json"), JSON.stringify(truth));
  return directory;
}

it("recovers a retained marker before the truth-exists skip of a full seed", async () => {
  const directory = seededLab({ projects: { work: "REQ" } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await main([directory]);
  expect(recover).toHaveBeenCalledTimes(1);
});

it("recovers a retained marker before the large-project skip of --only LRG", async () => {
  const directory = seededLab({ projects: { work: "REQ" }, large: { issueCount: 1 } });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const lab = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("no native request expected before recovery");
  });
  await main([directory, "--only", "LRG"]);
  expect(recover).toHaveBeenCalledTimes(1);
  lab.mockRestore();
});
