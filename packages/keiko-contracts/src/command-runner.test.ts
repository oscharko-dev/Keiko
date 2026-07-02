import { describe, expect, it } from "vitest";
import {
  COMMAND_FAILURE_REASONS,
  COMMAND_RUNNER_EVENT_KINDS,
  COMMAND_RUNNER_SCHEMA_VERSION,
  COMMAND_TASK_KINDS,
  COMMAND_TASK_RULES,
  COMMAND_TASK_SOURCES,
  COMMAND_TASK_TRUST_REASONS,
  COMMAND_TASK_TRUST_STATES,
  parseCommandTaskRunRequest,
  validateCommandTaskCatalog,
  validateCommandTaskRunResult,
  type CommandTask,
  type CommandTaskCatalog,
  type CommandTaskRunResult,
} from "./command-runner.js";

function baseRequest(): Record<string, unknown> {
  return { projectId: "/work/project", taskId: "npm-script:test" };
}

function baseTask(): CommandTask {
  return {
    id: "npm-script:test",
    kind: "test",
    label: "npm run test",
    executable: "npm",
    args: ["run", "test"],
    source: "package-json-script",
    trustState: "trusted",
    trustReason: "repository-authored-script",
  };
}

function baseCatalog(): CommandTaskCatalog {
  return {
    schemaVersion: COMMAND_RUNNER_SCHEMA_VERSION,
    projectId: "/work/project",
    tasks: [baseTask()],
  };
}

function baseResult(): CommandTaskRunResult {
  return {
    schemaVersion: COMMAND_RUNNER_SCHEMA_VERSION,
    runId: "run-1",
    taskId: "npm-script:test",
    kind: "test",
    exitCode: 0,
    durationMs: 12,
    truncated: false,
    timedOut: false,
    failureReason: "none",
    stdout: "ok",
    stderr: "",
  };
}

describe("command-runner constants", () => {
  it("pins the schema version", () => {
    expect(COMMAND_RUNNER_SCHEMA_VERSION).toBe("1");
  });

  it("exposes the three governed task kinds", () => {
    expect(COMMAND_TASK_KINDS).toEqual(["test", "build", "run"]);
    expect(Object.isFrozen(COMMAND_TASK_KINDS)).toBe(true);
  });

  it("exposes the closed failure-reason and event vocabularies", () => {
    expect(COMMAND_FAILURE_REASONS).toContain("denied");
    expect(COMMAND_FAILURE_REASONS).toContain("timed-out");
    expect(COMMAND_RUNNER_EVENT_KINDS).toEqual([
      "run-started",
      "run-completed",
      "run-failed",
      "run-cancelled",
    ]);
    expect(COMMAND_TASK_SOURCES).toEqual(["package-json-script"]);
    expect(COMMAND_TASK_TRUST_STATES).toEqual(["trusted", "approval-required"]);
    expect(COMMAND_TASK_TRUST_REASONS).toEqual(["repository-authored-script"]);
  });

  it("keeps the executor allowlist narrow and separate from read-only rules", () => {
    expect(COMMAND_TASK_RULES).toHaveLength(1);
    const [npm] = COMMAND_TASK_RULES;
    expect(npm?.executable).toBe("npm");
    expect(npm?.allowedSubcommands).toEqual(["run", "test"]);
    // Shell-spawning / scope-shifting flags are denied even though discovery emits a frozen argv.
    expect(npm?.denyFlags).toContain("--call");
    expect(npm?.denyFlags).toContain("--prefix");
    expect(npm?.denyFlags).toContain("--workspace");
    expect(Object.isFrozen(COMMAND_TASK_RULES)).toBe(true);
  });
});

describe("parseCommandTaskRunRequest happy path", () => {
  it("accepts a minimal request", () => {
    const parsed = parseCommandTaskRunRequest(baseRequest());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.projectId).toBe("/work/project");
      expect(parsed.value.taskId).toBe("npm-script:test");
    }
  });

  it("retains optional timeout and requestId", () => {
    const parsed = parseCommandTaskRunRequest({
      ...baseRequest(),
      timeoutMs: 5000,
      requestId: "req-7",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.timeoutMs).toBe(5000);
      expect(parsed.value.requestId).toBe("req-7");
    }
  });
});

describe("parseCommandTaskRunRequest rejections", () => {
  it("rejects a non-object", () => {
    const parsed = parseCommandTaskRunRequest("nope");
    expect(parsed).toEqual({ ok: false, errors: ["request must be an object"] });
  });

  it("collects every field error", () => {
    const parsed = parseCommandTaskRunRequest({ timeoutMs: 0, requestId: 5 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual(
        expect.arrayContaining([
          "projectId must be a non-empty string",
          "taskId must be a non-empty string of up to 256 characters",
          "timeoutMs must be a positive finite number",
          "requestId must be a token of 1-128 characters",
        ]),
      );
    }
  });

  it("rejects a non-positive timeout", () => {
    const parsed = parseCommandTaskRunRequest({ ...baseRequest(), timeoutMs: -1 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual(["timeoutMs must be a positive finite number"]);
    }
  });

  it("rejects an oversized taskId", () => {
    const parsed = parseCommandTaskRunRequest({ ...baseRequest(), taskId: "x".repeat(257) });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual(["taskId must be a non-empty string of up to 256 characters"]);
    }
  });

  it("rejects a requestId with illegal characters or excessive length", () => {
    for (const bad of ["has space", "semi;colon", "x".repeat(129)]) {
      const parsed = parseCommandTaskRunRequest({ ...baseRequest(), requestId: bad });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors).toEqual(["requestId must be a token of 1-128 characters"]);
      }
    }
  });
});

describe("validateCommandTaskCatalog", () => {
  it("accepts a well-formed catalog", () => {
    const parsed = validateCommandTaskCatalog(baseCatalog());
    expect(parsed.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validateCommandTaskCatalog(null)).toEqual({
      ok: false,
      errors: ["catalog must be an object"],
    });
  });

  it("rejects a bad schema version and missing projectId", () => {
    const parsed = validateCommandTaskCatalog({ schemaVersion: "9", tasks: [] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual(
        expect.arrayContaining([
          "schemaVersion is invalid",
          "projectId must be a non-empty string",
        ]),
      );
    }
  });

  it("validates each task entry", () => {
    const parsed = validateCommandTaskCatalog({
      schemaVersion: COMMAND_RUNNER_SCHEMA_VERSION,
      projectId: "/work/project",
      tasks: [
        {
          id: "",
          kind: "deploy",
          label: 3,
          executable: "",
          source: "x",
          trustState: "x",
          trustReason: "x",
          args: "no",
        },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual(
        expect.arrayContaining([
          "tasks[0].id must be a non-empty string",
          "tasks[0].label must be a non-empty string",
          "tasks[0].executable must be a non-empty string",
          "tasks[0].kind is invalid",
          "tasks[0].source is invalid",
          "tasks[0].trustState is invalid",
          "tasks[0].trustReason is invalid",
          "tasks[0].args must be an array",
        ]),
      );
    }
  });

  it("rejects non-string args", () => {
    const parsed = validateCommandTaskCatalog({
      schemaVersion: COMMAND_RUNNER_SCHEMA_VERSION,
      projectId: "/work/project",
      tasks: [{ ...baseTask(), args: ["run", 5] }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("tasks[0].args must be an array of strings");
    }
  });

  it("rejects a non-array tasks field", () => {
    const parsed = validateCommandTaskCatalog({
      schemaVersion: COMMAND_RUNNER_SCHEMA_VERSION,
      projectId: "/work/project",
      tasks: {},
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("tasks must be an array");
    }
  });
});

describe("validateCommandTaskRunResult", () => {
  it("accepts a well-formed result", () => {
    expect(validateCommandTaskRunResult(baseResult()).ok).toBe(true);
  });

  it("accepts a null exit code (timed-out / cancelled run)", () => {
    const parsed = validateCommandTaskRunResult({
      ...baseResult(),
      exitCode: null,
      timedOut: true,
      failureReason: "timed-out",
    });
    expect(parsed.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validateCommandTaskRunResult(7)).toEqual({
      ok: false,
      errors: ["result must be an object"],
    });
  });

  it("collects scalar and runtime field errors", () => {
    const parsed = validateCommandTaskRunResult({
      schemaVersion: "2",
      runId: "",
      taskId: "",
      kind: "deploy",
      failureReason: "exploded",
      exitCode: 1.5,
      durationMs: -2,
      truncated: "no",
      timedOut: 1,
      stdout: 0,
      stderr: null,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual(
        expect.arrayContaining([
          "schemaVersion is invalid",
          "runId must be a non-empty string",
          "taskId must be a non-empty string",
          "kind is invalid",
          "failureReason is invalid",
          "exitCode must be an integer or null",
          "durationMs must be a non-negative finite number",
          "truncated must be a boolean",
          "timedOut must be a boolean",
          "stdout must be a string",
          "stderr must be a string",
        ]),
      );
    }
  });
});
