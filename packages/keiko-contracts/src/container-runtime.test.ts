import { describe, expect, it } from "vitest";
import {
  CONTAINER_ENGINE_IDS,
  CONTAINER_FAILURE_REASONS,
  CONTAINER_MOUNT_MODES,
  CONTAINER_NETWORK_MODES,
  CONTAINER_RUNNER_EVENT_KINDS,
  CONTAINER_RUNTIME_SCHEMA_VERSION,
  CONTAINER_TASK_KINDS,
  CONTAINER_TASK_RULES,
  parseContainerRunRequest,
  validateContainerCapabilityResponse,
  validateContainerRunResult,
  validateContainerTaskCatalog,
  type ContainerCapabilityResponse,
  type ContainerRunResult,
  type ContainerTask,
  type ContainerTaskCatalog,
} from "./container-runtime.js";

function baseRequest(): Record<string, unknown> {
  return { projectId: "/work/project", taskId: "diag:docker" };
}

function baseTask(): ContainerTask {
  return {
    id: "diag:docker",
    kind: "diagnostic",
    label: "Diagnostic probe",
    image: "ghcr.io/keiko/diag@sha256:abc",
    args: ["true"],
    engine: "docker",
  };
}

function baseCatalog(): ContainerTaskCatalog {
  return {
    schemaVersion: CONTAINER_RUNTIME_SCHEMA_VERSION,
    projectId: "/work/project",
    engineAvailable: true,
    tasks: [baseTask()],
  };
}

function baseCapability(): ContainerCapabilityResponse {
  return {
    schemaVersion: CONTAINER_RUNTIME_SCHEMA_VERSION,
    generatedAtMs: 1000,
    deadlineMs: 4000,
    engines: [{ engine: "docker", state: "available" }],
    anyAvailable: true,
  };
}

function baseResult(): ContainerRunResult {
  return {
    schemaVersion: CONTAINER_RUNTIME_SCHEMA_VERSION,
    runId: "run-1",
    taskId: "diag:docker",
    kind: "diagnostic",
    engine: "docker",
    exitCode: 0,
    durationMs: 12,
    truncated: false,
    timedOut: false,
    failureReason: "none",
    stdout: "ok",
    stderr: "",
  };
}

describe("container-runtime constants", () => {
  it("pins the schema version", () => {
    expect(CONTAINER_RUNTIME_SCHEMA_VERSION).toBe("1");
  });

  it("exposes the closed engine ids", () => {
    expect(CONTAINER_ENGINE_IDS).toEqual(["docker", "podman"]);
    expect(Object.isFrozen(CONTAINER_ENGINE_IDS)).toBe(true);
  });

  it("exposes the closed task kinds, mount and network modes", () => {
    expect(CONTAINER_TASK_KINDS).toEqual(["diagnostic", "verify"]);
    expect(CONTAINER_MOUNT_MODES).toEqual(["read-only"]);
    expect(CONTAINER_NETWORK_MODES).toEqual(["none"]);
    expect(Object.isFrozen(CONTAINER_TASK_KINDS)).toBe(true);
    expect(Object.isFrozen(CONTAINER_MOUNT_MODES)).toBe(true);
    expect(Object.isFrozen(CONTAINER_NETWORK_MODES)).toBe(true);
  });

  it("exposes all eleven failure reasons and the four event kinds", () => {
    expect(CONTAINER_FAILURE_REASONS).toEqual([
      "none",
      "non-zero-exit",
      "engine-unavailable",
      "image-missing",
      "pull-denied",
      "mount-failure",
      "timed-out",
      "cancelled",
      "denied",
      "spawn-error",
      "output-capped",
    ]);
    expect(CONTAINER_RUNNER_EVENT_KINDS).toEqual([
      "run-started",
      "run-completed",
      "run-failed",
      "run-cancelled",
    ]);
    expect(Object.isFrozen(CONTAINER_FAILURE_REASONS)).toBe(true);
    expect(Object.isFrozen(CONTAINER_RUNNER_EVENT_KINDS)).toBe(true);
  });
});

describe("CONTAINER_TASK_RULES", () => {
  it("covers docker and podman with the same allowed subcommands", () => {
    expect(CONTAINER_TASK_RULES).toHaveLength(2);
    expect(CONTAINER_TASK_RULES.map((rule) => rule.executable)).toEqual(["docker", "podman"]);
    for (const rule of CONTAINER_TASK_RULES) {
      expect(rule.allowedSubcommands).toEqual(["version", "info", "run"]);
    }
    expect(Object.isFrozen(CONTAINER_TASK_RULES)).toBe(true);
  });

  it("denies escalation flags the server never emits", () => {
    for (const rule of CONTAINER_TASK_RULES) {
      const deny = rule.denyFlags ?? [];
      expect(deny).toContain("--privileged");
      expect(deny).toContain("--volume");
      expect(deny).toContain("--mount");
      expect(deny).toContain("--device");
      expect(deny).toContain("--cap-add");
      expect(deny).toContain("--net");
      expect(deny).toContain("--pid");
      expect(deny).toContain("--ipc");
      expect(deny).toContain("--user");
      expect(deny).toContain("-c");
    }
  });

  it("never denies a flag the server's own frozen argv emits (no self-deny)", () => {
    for (const rule of CONTAINER_TASK_RULES) {
      const deny = rule.denyFlags ?? [];
      expect(deny).not.toContain("--network");
      expect(deny).not.toContain("--security-opt");
      expect(deny).not.toContain("--cap-drop");
      expect(deny).not.toContain("-v");
      expect(deny).not.toContain("--rm");
      expect(deny).not.toContain("--read-only");
      expect(deny).not.toContain("--pull");
      expect(deny).not.toContain("--pids-limit");
      expect(deny).not.toContain("--memory");
      expect(deny).not.toContain("--cpus");
    }
  });
});

describe("parseContainerRunRequest happy path", () => {
  it("accepts a minimal request", () => {
    const parsed = parseContainerRunRequest(baseRequest());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.projectId).toBe("/work/project");
      expect(parsed.value.taskId).toBe("diag:docker");
    }
  });

  it("retains optional timeout and requestId", () => {
    const parsed = parseContainerRunRequest({
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

describe("parseContainerRunRequest rejections", () => {
  it("rejects a non-object", () => {
    expect(parseContainerRunRequest("nope")).toEqual({
      ok: false,
      errors: ["request must be an object"],
    });
  });

  it("collects every field error in fixed order", () => {
    const parsed = parseContainerRunRequest({ timeoutMs: 0, requestId: 5 });
    expect(parsed).toEqual({
      ok: false,
      errors: [
        "projectId must be a non-empty string",
        "taskId must be a non-empty string",
        "timeoutMs must be a positive finite number",
        "requestId must be a string",
      ],
    });
  });

  it("rejects a non-positive timeout", () => {
    const parsed = parseContainerRunRequest({ ...baseRequest(), timeoutMs: -1 });
    expect(parsed).toEqual({ ok: false, errors: ["timeoutMs must be a positive finite number"] });
  });
});

describe("validateContainerCapabilityResponse", () => {
  it("accepts a well-formed response", () => {
    expect(validateContainerCapabilityResponse(baseCapability()).ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validateContainerCapabilityResponse(null)).toEqual({
      ok: false,
      errors: ["response must be an object"],
    });
  });

  it("collects scalar errors in fixed order", () => {
    const parsed = validateContainerCapabilityResponse({
      schemaVersion: "2",
      generatedAtMs: -1,
      deadlineMs: 0,
      anyAvailable: "yes",
      engines: [],
    });
    expect(parsed).toEqual({
      ok: false,
      errors: [
        "schemaVersion is invalid",
        "generatedAtMs must be a non-negative safe integer",
        "deadlineMs must be a positive safe integer",
        "anyAvailable must be a boolean",
      ],
    });
  });

  it("rejects a non-array engines field", () => {
    const parsed = validateContainerCapabilityResponse({ ...baseCapability(), engines: {} });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("engines must be an array");
    }
  });

  it("validates each engine entry in fixed order", () => {
    const parsed = validateContainerCapabilityResponse({
      ...baseCapability(),
      engines: [{ engine: "rkt", state: "", version: 1, unavailableReason: 2, remediationHint: 3 }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual([
        "engines[0].engine is invalid",
        "engines[0].state must be a non-empty string",
        "engines[0].version must be a string",
        "engines[0].unavailableReason must be a string",
        "engines[0].remediationHint must be a string",
      ]);
    }
  });

  it("rejects a non-object engine entry", () => {
    const parsed = validateContainerCapabilityResponse({ ...baseCapability(), engines: ["x"] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("engines[0] must be an object");
    }
  });
});

describe("validateContainerTaskCatalog", () => {
  it("accepts a well-formed catalog", () => {
    expect(validateContainerTaskCatalog(baseCatalog()).ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validateContainerTaskCatalog(null)).toEqual({
      ok: false,
      errors: ["catalog must be an object"],
    });
  });

  it("collects scalar errors in fixed order", () => {
    const parsed = validateContainerTaskCatalog({ schemaVersion: "9", tasks: [] });
    expect(parsed).toEqual({
      ok: false,
      errors: [
        "schemaVersion is invalid",
        "projectId must be a non-empty string",
        "engineAvailable must be a boolean",
      ],
    });
  });

  it("validates each task entry in fixed order", () => {
    const parsed = validateContainerTaskCatalog({
      schemaVersion: CONTAINER_RUNTIME_SCHEMA_VERSION,
      projectId: "/work/project",
      engineAvailable: true,
      tasks: [{ id: "", kind: "deploy", label: 3, image: "", engine: "rkt", args: "no" }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual([
        "tasks[0].id must be a non-empty string",
        "tasks[0].label must be a non-empty string",
        "tasks[0].image must be a non-empty string",
        "tasks[0].kind is invalid",
        "tasks[0].engine is invalid",
        "tasks[0].args must be an array",
      ]);
    }
  });

  it("rejects non-string args", () => {
    const parsed = validateContainerTaskCatalog({
      ...baseCatalog(),
      tasks: [{ ...baseTask(), args: ["true", 5] }],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("tasks[0].args must be an array of strings");
    }
  });

  it("rejects a non-array tasks field", () => {
    const parsed = validateContainerTaskCatalog({ ...baseCatalog(), tasks: {} });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("tasks must be an array");
    }
  });

  it("rejects a non-object task entry", () => {
    const parsed = validateContainerTaskCatalog({ ...baseCatalog(), tasks: ["x"] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain("tasks[0] must be an object");
    }
  });
});

describe("validateContainerRunResult", () => {
  it("accepts a well-formed result", () => {
    expect(validateContainerRunResult(baseResult()).ok).toBe(true);
  });

  it("accepts a null exit code (timed-out / cancelled run)", () => {
    const parsed = validateContainerRunResult({
      ...baseResult(),
      exitCode: null,
      timedOut: true,
      failureReason: "timed-out",
    });
    expect(parsed.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validateContainerRunResult(7)).toEqual({
      ok: false,
      errors: ["result must be an object"],
    });
  });

  it("collects scalar and runtime field errors in fixed order", () => {
    const parsed = validateContainerRunResult({
      schemaVersion: "2",
      runId: "",
      taskId: "",
      kind: "deploy",
      engine: "rkt",
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
      expect(parsed.errors).toEqual([
        "schemaVersion is invalid",
        "runId must be a non-empty string",
        "taskId must be a non-empty string",
        "kind is invalid",
        "engine is invalid",
        "failureReason is invalid",
        "exitCode must be an integer or null",
        "durationMs must be a non-negative finite number",
        "truncated must be a boolean",
        "timedOut must be a boolean",
        "stdout must be a string",
        "stderr must be a string",
      ]);
    }
  });
});
