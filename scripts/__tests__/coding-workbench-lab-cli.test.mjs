// End-to-end tests of the fail-closed rules of the Coding Workbench live-lab drivers: each command is
// started as a child process, exactly as an operator would, and must refuse before it touches the
// network. No test pairs with a dev server: every refusal below happens while the arguments are
// validated, and the one that gets past them stops at the missing launcher secret.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const LAB = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "coding-workbench-lab");
const TEMP_DIRECTORIES = [];
const LAB_ENVIRONMENT = new Set([
  "KEIKO_LAB_REPO",
  "KEIKO_LAB_BASE_URL",
  "KEIKO_LAB_LOG_DIR",
  "KEIKO_STATE_DIR",
  "KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET",
]);

afterEach(() => {
  while (TEMP_DIRECTORIES.length > 0) {
    rmSync(TEMP_DIRECTORIES.pop(), { recursive: true, force: true });
  }
});

function tempDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRECTORIES.push(directory);
  return directory;
}

function labCopy(name) {
  const directory = tempDirectory("keiko-lab-cli-repo-");
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name }));
  return directory;
}

/** Runs one lab command with none of the lab environment set, so a refusal cannot come from a leftover. */
function run(script, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !LAB_ENVIRONMENT.has(name)),
  );
  const result = spawnSync(process.execPath, [join(LAB, script), ...args], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("the drivers refuse to approve silently", () => {
  it.each(["wb-run.mjs", "wb-ui.mjs"])("%s has no default approval policy", (script) => {
    const result = run(script, ["--task-id", "T1"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/pass --approve all\|none\|ask/u);
    expect(result.stdout).toBe("");
  });

  it.each(["wb-run.mjs", "wb-ui.mjs"])("%s refuses a policy it does not know", (script) => {
    const result = run(script, ["--task-id", "T1", "--approve", "yes"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--approve must be all, none or ask \(got "yes"\)/u);
  });

  it("chaos-suite.mjs needs the policy too, since it runs wb-run.mjs for you", () => {
    const result = run("chaos-suite.mjs", []);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/pass --approve all\|none\|ask/u);
  });
});

describe("the drivers refuse to run in whichever workspace the dev server has open", () => {
  it.each(["wb-run.mjs", "wb-ui.mjs"])("%s needs a repository", (script) => {
    const result = run(script, ["--task-id", "T1", "--approve", "ask"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/pass --repo <path> or set KEIKO_LAB_REPO/u);
    expect(result.stderr).toContain("docs/qa/coding-workbench-lab/README.md");
  });

  it.each(["wb-run.mjs", "wb-ui.mjs"])("%s refuses a checkout that is not the lab", (script) => {
    const result = run(script, ["--task-id", "T1", "--approve", "all", "--repo", labCopy("keiko")]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/is not a lab repository \(its package\.json names "keiko"\)/u);
  });

  it("chaos-suite.mjs needs a repository before it sets a single fault", () => {
    const result = run("chaos-suite.mjs", ["--approve", "none"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/pass --repo <path> or set KEIKO_LAB_REPO/u);
  });

  it("wb-trust.mjs names the action and the repository, since trust is a security decision", () => {
    const noAction = run("wb-trust.mjs", []);
    expect(noAction.status).toBe(2);
    expect(noAction.stderr).toMatch(/pass the action, grant or revoke \(got null\)/u);
    const noRepository = run("wb-trust.mjs", ["grant"]);
    expect(noRepository.status).toBe(2);
    expect(noRepository.stderr).toMatch(/pass --repo <path> or set KEIKO_LAB_REPO/u);
    const notTheLab = run("wb-trust.mjs", ["grant", "--repo", labCopy("keiko")]);
    expect(notTheLab.status).toBe(2);
    expect(notTheLab.stderr).toMatch(/is not a lab repository/u);
  });

  it("verify-latency.mjs applies the same rule", () => {
    const result = run("verify-latency.mjs", ["--repo", labCopy("keiko")]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/is not a lab repository/u);
  });
});

describe("a command that passed its checks stops at the launcher secret, before any network", () => {
  it("wb-run.mjs with a policy and a lab copy asks for the secret and names the README step", () => {
    const result = run("wb-run.mjs", [
      "--task-id",
      "T1",
      "--approve",
      "ask",
      "--repo",
      labCopy("ledger-lab"),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(
      /KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET must hold the launcher secret/u,
    );
    expect(result.stderr).toContain("scripts/testing/coding-workbench-lab/README.md, step 1");
  });

  it("chaos-suite.mjs refuses an unknown scenario before it looks for the proxy", () => {
    const result = run("chaos-suite.mjs", [
      "--approve",
      "none",
      "--repo",
      labCopy("ledger-lab"),
      "--scenarios",
      "S9",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown scenario "S9"/u);
  });
});

describe("the read-only tools", () => {
  it("print their usage with --help, driver usage naming the explicit policy", () => {
    for (const script of ["wb-run.mjs", "wb-ui.mjs", "chaos-suite.mjs"]) {
      const result = run(script, ["--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("--approve all|none|ask");
    }
    for (const script of ["turn-profile.mjs", "run-summary.mjs", "rawtl.mjs", "pair.mjs"]) {
      expect(run(script, ["--help"]).status).toBe(0);
    }
  });

  it("list the task catalog with T13 without touching a repository or a server", () => {
    const result = run("wb-run.mjs", ["--list-tasks"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^T13 +Ask for approval +head\+md +Per-turn cost of a 30 KiB/mu);
  });

  it("turn-profile.mjs reports a run with no events and refuses a run id that would match everything", () => {
    const empty = tempDirectory("keiko-lab-cli-logs-");
    const none = run("turn-profile.mjs", ["run-1234567890", "--log-dir", empty]);
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/no events for 1234567890 in /u);
    const tooShort = run("turn-profile.mjs", ["run-1", "--log-dir", empty]);
    expect(tooShort.status).toBe(2);
    expect(tooShort.stderr).toMatch(/at least 6 trailing digits/u);
  });

  it("run-summary.mjs --ledger-row refuses to draw a row without saying who drove the run", () => {
    const empty = tempDirectory("keiko-lab-cli-logs-");
    const result = run("run-summary.mjs", ["run-1234567890", "--log-dir", empty, "--ledger-row"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--ledger-row needs --driver wb-ui\|wb-run\|manual/u);
  });
});
