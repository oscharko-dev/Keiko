// Unit tests for the shared helpers of the Coding Workbench live-lab drivers
// (scripts/testing/coding-workbench-lab/lab-common.mjs): option parsing, the fail-closed approval
// policy and lab-repository rules, the loopback-only base URL, run-id handling and the task
// catalog. The drivers that call them are exercised end to end by `coding-workbench-lab-cli`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LAB_GUIDE,
  LAB_REPOSITORY_NAME,
  MODES,
  TERMINAL_STATES,
  UsageError,
  approvalPolicyLine,
  approvalPolicyText,
  assertCheckoutSelected,
  assertLabRepository,
  assertProjectRegistered,
  browserBaseUrl,
  checkoutRequest,
  describeRefusal,
  describeSnapshot,
  exitCodeForState,
  formatTaskList,
  labBaseUrl,
  labRepositoryPath,
  loadTasks,
  minutesToMs,
  normalizeRunSuffix,
  parseApprove,
  parseCli,
  registerProjectRequest,
  resolveMode,
  resolveTaskInput,
} from "../testing/coding-workbench-lab/lab-common.mjs";

const TEMP_DIRECTORIES = [];

function labCopy(name = LAB_REPOSITORY_NAME) {
  const root = mkdtempSync(join(tmpdir(), "keiko-lab-common-"));
  TEMP_DIRECTORIES.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "0.1.0" }));
  return root;
}

/** A repository directory with a given name whose package.json names `packageName`. */
function namedCopy(directoryName, packageName) {
  const parent = mkdtempSync(join(tmpdir(), "keiko-lab-named-"));
  TEMP_DIRECTORIES.push(parent);
  const root = join(parent, directoryName);
  mkdirSync(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: packageName }));
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (TEMP_DIRECTORIES.length > 0) {
    rmSync(TEMP_DIRECTORIES.pop(), { recursive: true, force: true });
  }
});

describe("parseCli", () => {
  const options = { task: { type: "string" }, flag: { type: "boolean" } };

  it("returns the values and the positionals", () => {
    const cli = parseCli({
      argv: ["--task", "T1", "--flag", "extra"],
      usage: "usage",
      options,
      positionals: true,
    });
    expect(cli.help).toBe(false);
    expect(cli.values).toEqual({ task: "T1", flag: true });
    expect(cli.positionals).toEqual(["extra"]);
  });

  it("refuses an unknown option as a usage error that carries the usage text", () => {
    expect(() => parseCli({ argv: ["--nope"], usage: "USAGE TEXT", options })).toThrow(UsageError);
    expect(() => parseCli({ argv: ["--nope"], usage: "USAGE TEXT", options })).toThrow(
      /USAGE TEXT$/u,
    );
  });

  it("refuses a positional where none is allowed and an option without its value", () => {
    expect(() => parseCli({ argv: ["stray"], usage: "u", options })).toThrow(UsageError);
    expect(() => parseCli({ argv: ["--task"], usage: "u", options })).toThrow(UsageError);
  });

  it("prints the usage for --help and reports it", () => {
    const print = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const cli = parseCli({ argv: ["--help"], usage: "USAGE TEXT", options });
    expect(cli.help).toBe(true);
    expect(print).toHaveBeenCalledWith("USAGE TEXT");
  });
});

describe("approval policy (fail closed)", () => {
  it("has no default: an absent --approve is a usage error that names the three policies", () => {
    expect(() => parseApprove(undefined)).toThrow(UsageError);
    expect(() => parseApprove(undefined)).toThrow(/--approve all\|none\|ask/u);
  });

  it("accepts exactly all, none and ask", () => {
    expect(["all", "none", "ask"].map(parseApprove)).toEqual(["all", "none", "ask"]);
  });

  it("refuses anything else, including names that exist on every object", () => {
    for (const value of ["", "ALL", "yes", "true", "__proto__", "toString", "constructor"]) {
      expect(() => parseApprove(value)).toThrow(UsageError);
    }
  });

  it("says in words who answers the asks, for the run record and the ledger row", () => {
    expect(approvalPolicyText("all")).toMatch(/driver approves every permission ask/u);
    expect(approvalPolicyText("none")).toMatch(/driver denies/u);
    expect(approvalPolicyText("ask")).toMatch(/a person decides/u);
    expect(approvalPolicyLine("wb-ui", "all")).toBe(
      `driver wb-ui: approvals all (${approvalPolicyText("all")})`,
    );
  });
});

describe("lab repository (fail closed)", () => {
  it("requires --repo or KEIKO_LAB_REPO and names the guide", () => {
    expect(() => labRepositoryPath(undefined, {})).toThrow(UsageError);
    expect(() => labRepositoryPath(undefined, {})).toThrow(new RegExp(LAB_GUIDE, "u"));
    expect(() => labRepositoryPath(undefined, { KEIKO_LAB_REPO: "" })).toThrow(UsageError);
  });

  it("accepts a copy of the fixture, from the flag or from the environment, as an absolute path", () => {
    const repo = labCopy();
    expect(labRepositoryPath(repo, {})).toBe(resolve(repo));
    expect(labRepositoryPath(undefined, { KEIKO_LAB_REPO: repo })).toBe(resolve(repo));
  });

  it("lets the flag win over the environment", () => {
    const flagged = labCopy();
    const other = labCopy("not-a-lab");
    expect(labRepositoryPath(flagged, { KEIKO_LAB_REPO: other })).toBe(resolve(flagged));
  });

  it("refuses a checkout whose package.json does not name the lab", () => {
    const real = labCopy("keiko");
    expect(() => labRepositoryPath(real, {})).toThrow(UsageError);
    expect(() => labRepositoryPath(real, {})).toThrow(/names "keiko"/u);
  });

  it("takes the marker from the package.json, never from the name of the directory", () => {
    // A copy of the fixture keeps its package name whatever its folder is called, and a folder that
    // is only called ledger-lab proves nothing: the drivers approve edits on what they accept.
    const impostor = namedCopy(LAB_REPOSITORY_NAME, "keiko");
    expect(() => labRepositoryPath(impostor, {})).toThrow(UsageError);
    expect(() => labRepositoryPath(impostor, {})).toThrow(/names "keiko"/u);
    expect(() => assertLabRepository(impostor)).toThrow(/is not a lab repository/u);
    const renamed = namedCopy("my-copy", LAB_REPOSITORY_NAME);
    expect(labRepositoryPath(renamed, {})).toBe(resolve(renamed));
  });

  it("refuses a directory with no package.json, an unreadable one and one without a name", () => {
    const empty = mkdtempSync(join(tmpdir(), "keiko-lab-empty-"));
    TEMP_DIRECTORIES.push(empty);
    expect(() => assertLabRepository(empty)).toThrow(/ENOENT/u);
    writeFileSync(join(empty, "package.json"), "{ not json");
    expect(() => assertLabRepository(empty)).toThrow(UsageError);
    writeFileSync(join(empty, "package.json"), JSON.stringify({ private: true }));
    expect(() => assertLabRepository(empty)).toThrow(/names null/u);
    writeFileSync(join(empty, "package.json"), "null");
    expect(() => assertLabRepository(empty)).toThrow(UsageError);
  });

  it("reads the marker through the injected reader", () => {
    const read = vi.fn(() => JSON.stringify({ name: LAB_REPOSITORY_NAME }));
    expect(() => assertLabRepository("/anywhere", read)).not.toThrow();
    expect(read).toHaveBeenCalledWith(join("/anywhere", "package.json"), "utf8");
  });

  it("never starts a run unless the dev server accepted the repository as its workspace", () => {
    expect(checkoutRequest("/repo", "main")).toEqual({
      root: "/repo",
      branch: "main",
      requestedBy: "studio-operator",
    });
    expect(() => assertCheckoutSelected(200)).not.toThrow();
    expect(() => assertCheckoutSelected(204)).not.toThrow();
    for (const status of [199, 300, 400, 409, 500]) {
      expect(() => assertCheckoutSelected(status)).toThrow(/not starting a run/u);
    }
  });

  it("registers the copy by its path alone: an explicit folder selection would also grant package-script trust", () => {
    expect(registerProjectRequest("/real/lab")).toEqual({ path: "/real/lab" });
    expect(Object.keys(registerProjectRequest("/real/lab"))).toEqual(["path"]);
  });

  it("refuses a registration the dev server did not accept, with its reason and the guide step", () => {
    expect(() => assertProjectRegistered(201)).not.toThrow();
    expect(() => assertProjectRegistered(200)).not.toThrow();
    const denied = { error: { code: "DENIED", message: "The project path is excluded." } };
    expect(() => assertProjectRegistered(403, denied)).toThrow(
      /did not register the lab repository as a project \(HTTP 403 DENIED: The project path is excluded\.\)/u,
    );
    expect(() => assertProjectRegistered(500)).toThrow(new RegExp(`${LAB_GUIDE}, step 5`, "u"));
  });
});

describe("describeRefusal", () => {
  it("names the status and, from the server's error envelope, its code and message", () => {
    const body = { error: { code: "LOCK_CONTENTION", message: "A coding run is still active." } };
    expect(describeRefusal(409, body)).toBe(
      "HTTP 409 LOCK_CONTENTION: A coding run is still active.",
    );
    expect(() => assertCheckoutSelected(409, body)).toThrow(
      /did not select the lab repository \(HTTP 409 LOCK_CONTENTION: A coding run is still active\.\); not starting a run/u,
    );
  });

  it("says what it has when the body has only a code, only a message or no envelope at all", () => {
    expect(describeRefusal(400, { error: { code: "INVALID_REQUEST" } })).toBe(
      "HTTP 400 INVALID_REQUEST",
    );
    expect(describeRefusal(400, { error: { message: "Bad." } })).toBe("HTTP 400: Bad.");
    for (const body of [undefined, null, {}, { raw: "<html>" }, { error: "text" }, { error: {} }]) {
      expect(describeRefusal(502, body)).toBe("HTTP 502");
    }
    expect(describeRefusal(400, { error: { code: 7, message: ["x"] } })).toBe("HTTP 400");
  });

  it("bounds the phrase and keeps control characters out of the terminal", () => {
    const body = { error: { code: "X", message: `${"a".repeat(500)}` } };
    expect(describeRefusal(400, body)).toHaveLength(200);
    const noisy = { error: { code: "X", message: "first\u001b[31m\nsecond\u0007" } };
    expect(describeRefusal(400, noisy)).toBe("HTTP 400 X: first [31m second");
  });
});

describe("labBaseUrl and browserBaseUrl", () => {
  it("defaults to the loopback dev server and takes the flag before the environment", () => {
    expect(labBaseUrl(undefined, {})).toBe("http://127.0.0.1:1983");
    expect(labBaseUrl(undefined, { KEIKO_LAB_BASE_URL: "http://localhost:2000" })).toBe(
      "http://localhost:2000",
    );
    expect(
      labBaseUrl("http://127.0.0.1:3000", { KEIKO_LAB_BASE_URL: "http://localhost:2000" }),
    ).toBe("http://127.0.0.1:3000");
    expect(labBaseUrl("http://[::1]:1983", {})).toBe("http://[::1]:1983");
  });

  it("refuses a URL that is not loopback http, because the drivers send a pairing attestation", () => {
    for (const url of [
      "https://127.0.0.1:1983",
      "http://example.com",
      "http://10.0.0.5:1983",
      "http://127.0.0.1.evil.test",
      "http://0.0.0.0:1983",
    ]) {
      expect(() => labBaseUrl(url, {})).toThrow(UsageError);
    }
    expect(() => labBaseUrl("not a url", {})).toThrow(/not a URL/u);
  });

  it("browses localhost where the dev server serves pages", () => {
    expect(browserBaseUrl("http://127.0.0.1:1983")).toBe("http://localhost:1983");
    expect(browserBaseUrl("http://localhost:1983")).toBe("http://localhost:1983");
  });
});

describe("numbers, modes and run ids", () => {
  it("converts positive minutes to milliseconds and refuses the rest", () => {
    expect(minutesToMs("30")).toBe(1_800_000);
    expect(minutesToMs("0.5")).toBe(30_000);
    for (const value of ["0", "-3", "abc", "", "Infinity"]) {
      expect(() => minutesToMs(value)).toThrow(/--timeout-min must be a positive number/u);
    }
    expect(() => minutesToMs("0", "--wait")).toThrow(/--wait/u);
  });

  it("resolves a mode by label or id, case-insensitively, and defaults to Supervised workspace", () => {
    expect(resolveMode().id).toBe("supervised-coding");
    for (const mode of MODES) {
      expect(resolveMode(mode.label)).toBe(mode);
      expect(resolveMode(mode.id.toUpperCase())).toBe(mode);
    }
    expect(() => resolveMode("Autopilot")).toThrow(/unknown mode "Autopilot"/u);
  });

  it("normalizes a run id and refuses a suffix that would match the whole log", () => {
    expect(normalizeRunSuffix("run-1234567890")).toBe("1234567890");
    expect(normalizeRunSuffix("123456")).toBe("123456");
    for (const input of [undefined, "", "run-", "12345", "run-123"]) {
      expect(() => normalizeRunSuffix(input)).toThrow(UsageError);
    }
  });

  it("maps a run state to the exit code of the drivers", () => {
    expect(exitCodeForState("succeeded")).toBe(0);
    for (const state of TERMINAL_STATES.filter((candidate) => candidate !== "succeeded")) {
      expect(exitCodeForState(state)).toBe(1);
    }
    expect(exitCodeForState("running")).toBe(3);
    expect(exitCodeForState(undefined)).toBe(3);
  });

  it("describes a run snapshot with the kind of a pending permission", () => {
    expect(describeSnapshot({ state: "running", revision: 4 })).toBe("running rev=4");
    expect(
      describeSnapshot({
        state: "awaiting-approval",
        revision: 5,
        pendingPermission: { kind: "command-execution" },
      }),
    ).toBe("awaiting-approval rev=5 pending=command-execution");
    expect(
      describeSnapshot({ state: "awaiting-approval", revision: 6, pendingPermission: {} }),
    ).toBe("awaiting-approval rev=6 pending=?");
  });
});

describe("the task catalog", () => {
  it("lists every task once, with the closed fields the drivers read", () => {
    const tasks = loadTasks();
    expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
    for (const task of tasks) {
      expect(Object.keys(task).toSorted()).toEqual(
        ["baseline", "expected", "id", "mode", "text", "textStatus", "title"].toSorted(),
      );
      expect(["recorded", "proposed"]).toContain(task.textStatus);
      expect(MODES.map((mode) => mode.label)).toContain(task.mode);
      expect(task.text.trim()).not.toBe("");
    }
  });

  it("lists the catalog with one line per task and an aligned baseline column", () => {
    const tasks = loadTasks();
    const lines = formatTaskList().split("\n");
    expect(lines).toHaveLength(tasks.length);
    const width = Math.max(...tasks.map((task) => task.baseline.length));
    const idColumn = 4 + 1 + 21 + 1;
    tasks.forEach((task, index) => {
      expect(lines[index]?.startsWith(task.id)).toBe(true);
      expect(lines[index]?.slice(idColumn, idColumn + width).trimEnd()).toBe(task.baseline);
      expect(lines[index]?.endsWith(task.title)).toBe(true);
    });
  });

  it("resolves a catalog task with its mode, and lets the flags override the text and the mode", () => {
    const catalog = loadTasks().find((task) => task.id === "T4");
    expect(resolveTaskInput({ "task-id": "T4" })).toEqual({
      text: catalog.text,
      mode: MODES.find((mode) => mode.label === catalog.mode),
      taskId: "T4",
    });
    const overridden = resolveTaskInput({
      "task-id": "T4",
      task: "Do something else",
      mode: "Full access",
    });
    expect(overridden.text).toBe("Do something else");
    expect(overridden.mode.label).toBe("Full access");
  });

  it("refuses an unknown id by printing the catalog, and a missing or blank task", () => {
    expect(() => resolveTaskInput({ "task-id": "T99" })).toThrow(/unknown task id "T99"/u);
    expect(() => resolveTaskInput({ "task-id": "T99" })).toThrow(/T13/u);
    expect(() => resolveTaskInput({})).toThrow(/--task-id/u);
    expect(() => resolveTaskInput({ task: "   " })).toThrow(UsageError);
  });

  it("runs an ad-hoc task text in the default mode", () => {
    const resolved = resolveTaskInput({ task: "List the files" });
    expect(resolved.taskId).toBeUndefined();
    expect(resolved.mode.id).toBe("supervised-coding");
  });
});

describe("a repository path that does not exist yet", () => {
  it("is refused as not a lab repository", () => {
    const parent = mkdtempSync(join(tmpdir(), "keiko-lab-missing-"));
    TEMP_DIRECTORIES.push(parent);
    expect(() => labRepositoryPath(join(parent, "nope"), {})).toThrow(/is not a lab repository/u);
  });
});
