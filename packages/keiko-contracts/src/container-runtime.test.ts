import {
  registerPhysicalTaskCatalogContract,
  type PhysicalTaskCatalogValidator,
} from "./__tests__/support/physical-task-catalog-contract.js";
import { observeIndexedMembers } from "./__tests__/support/observed-indexed-members.js";
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

  // Codex-sweep finding (same class as command-runner.ts's COMMAND_TASK_RULES, KEIKO-0139):
  // Object.freeze on the array only freezes the array's own indices, not the row objects it
  // holds — Object.isFrozen(CONTAINER_TASK_RULES) above was already true even before this fix,
  // since that only checks the OUTER container. A rule's own top-level field (e.g. `executable`)
  // was still writable, which could redirect an allowlisted rule's identity. Modules run in
  // strict mode, so a write to a genuinely frozen object throws.
  it("freezes each rule object itself, not just the array holding them", () => {
    const [docker] = CONTAINER_TASK_RULES;
    expect(docker).toBeDefined();
    expect(() => {
      (docker as { executable: string }).executable = "rm";
    }).toThrow(TypeError);
    expect(CONTAINER_TASK_RULES[0]?.executable).toBe("docker");
  });

  // KEIKO-0468: the matcher is an exact-token comparison, so `--user` alone denied nothing a caller
  // could not rewrite as `-u`/`-u=0`. `--entrypoint` (program substitution) was missing outright.
  // These are the highest-value escalation tokens in this file's own stated threat model.
  it.each(["-u", "--entrypoint", "--userns", "--group-add", "--device-cgroup-rule"])(
    "denies the escalation flag %s",
    (flag) => {
      for (const rule of CONTAINER_TASK_RULES) {
        expect(rule.denyFlags ?? []).toContain(flag);
      }
    },
  );

  it("keeps the alias-completeness rule: a denied long flag has its short alias denied too", () => {
    // The frozen argv's own `-v` is deliberately NOT denied (see the module comment), so the rule is
    // asserted for the aliases that are actually part of the deny set.
    for (const rule of CONTAINER_TASK_RULES) {
      const deny = rule.denyFlags ?? [];
      expect(deny.includes("--user")).toBe(deny.includes("-u"));
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

// #3918: canonical runtime vocabularies own the capability response's declared output.
import {
  RUNTIME_CAPABILITY_STATES,
  RUNTIME_CAPABILITY_UNAVAILABLE_REASONS,
} from "./runtime-capabilities.js";

describe("#3918 canonical container capability admission", () => {
  it("rejects a noncanonical engine state from capability validation", () => {
    const input = { ...baseCapability(), engines: [{ engine: "docker", state: "future-state" }] };
    expect(validateContainerCapabilityResponse(input)).toEqual({
      ok: false,
      errors: ["engines[0].state is invalid"],
    });
  });
  it("rejects a noncanonical optional engine-unavailable reason", () => {
    const input = {
      ...baseCapability(),
      engines: [{ engine: "docker", state: "missing", unavailableReason: "future-reason" }],
    };
    expect(validateContainerCapabilityResponse(input)).toEqual({
      ok: false,
      errors: ["engines[0].unavailableReason is invalid"],
    });
  });
  it.each(RUNTIME_CAPABILITY_STATES)(
    "accepts canonical state %s without a new relational restriction",
    (state) => {
      const input = { ...baseCapability(), engines: [{ engine: "docker", state }] };
      const result = validateContainerCapabilityResponse(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(input);
    },
  );
  it.each(RUNTIME_CAPABILITY_UNAVAILABLE_REASONS)(
    "accepts canonical reason %s",
    (unavailableReason) => {
      const input = {
        ...baseCapability(),
        engines: [{ engine: "docker", state: "missing", unavailableReason }],
      };
      const result = validateContainerCapabilityResponse(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(input);
    },
  );
  it("preserves absent and explicit undefined optionals and ordinary strings", () => {
    for (const optionals of [
      {},
      { version: undefined, unavailableReason: undefined, remediationHint: undefined },
      { version: "1.0", remediationHint: "Install the optional engine" },
    ]) {
      const input = {
        ...baseCapability(),
        engines: [{ engine: "docker", state: "missing", ...optionals }],
      };
      const result = validateContainerCapabilityResponse(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(input);
    }
  });
});

function observedExecutionFields(
  input: Record<string, unknown>,
  reads: string[],
): Record<string, unknown> {
  return Object.defineProperties(
    {},
    Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        {
          enumerable: true,
          get: (): unknown => {
            reads.push(key);
            return value;
          },
        },
      ]),
    ),
  );
}

describe("#3918 container checked-phase preservation", () => {
  it("preserves request identity and optional field observation order", () => {
    const reads: string[] = [];
    const input = observedExecutionFields(
      { ...baseRequest(), timeoutMs: 12, requestId: "request-1" },
      reads,
    );
    const result = parseContainerRunRequest(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(input);
    expect(reads).toEqual([
      "projectId",
      "taskId",
      "timeoutMs",
      "timeoutMs",
      "requestId",
      "requestId",
    ]);
  });
  it("preserves original catalog and nested task/argument identity", () => {
    const reads: string[] = [];
    const task = baseTask();
    const input = observedExecutionFields({ ...baseCatalog(), tasks: [task] }, reads);
    const result = validateContainerTaskCatalog(input);
    const admissionReads = [...reads];
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(input);
      expect(result.value.tasks[0]).toBe(task);
      expect(result.value.tasks[0]?.args).toBe(task.args);
    }
    expect(admissionReads).toEqual([
      "schemaVersion",
      "projectId",
      "engineAvailable",
      "tasks",
      "tasks",
    ]);
  });
  it("preserves result identity and eager common-field order", () => {
    const reads: string[] = [];
    const input = observedExecutionFields({ ...baseResult() }, reads);
    const result = validateContainerRunResult(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(input);
    expect(reads).toEqual([
      "schemaVersion",
      "runId",
      "taskId",
      "kind",
      "engine",
      "failureReason",
      "exitCode",
      "durationMs",
      "truncated",
      "timedOut",
      "stdout",
      "stderr",
    ]);
  });
});

describe("#3918 native array member admission", () => {
  it("rejects malformed tasks despite an own forEach that skips members", () => {
    const tasks = Object.defineProperty([{ ...baseTask(), image: 0 }], "forEach", {
      value: (): void => undefined,
    });
    expect(validateContainerTaskCatalog({ ...baseCatalog(), tasks })).toEqual({
      ok: false,
      errors: ["tasks[0].image must be a non-empty string"],
    });
  });
  it("rejects nonstring arguments despite an own every that claims success", () => {
    const args = Object.defineProperty([1], "every", { value: (): boolean => true });
    expect(
      validateContainerTaskCatalog({ ...baseCatalog(), tasks: [{ ...baseTask(), args }] }),
    ).toEqual({ ok: false, errors: ["tasks[0].args must be an array of strings"] });
  });
  it("rejects a task hole that cannot satisfy the member contract", () => {
    expect(
      validateContainerTaskCatalog({ ...baseCatalog(), tasks: new Array<unknown>(1) }),
    ).toEqual({ ok: false, errors: ["tasks[0] must be an object"] });
  });
  it("rejects an argument hole that cannot satisfy the string contract", () => {
    expect(
      validateContainerTaskCatalog({
        ...baseCatalog(),
        tasks: [{ ...baseTask(), args: new Array<unknown>(1) }],
      }),
    ).toEqual({ ok: false, errors: ["tasks[0].args must be an array of strings"] });
  });
  it("rejects a nonarray second task observation with the original two reads", () => {
    let reads = 0;
    const input = Object.defineProperty({ ...baseCatalog() }, "tasks", {
      get: (): unknown => (++reads === 1 ? [baseTask()] : { forEach: (): void => undefined }),
    });
    expect(validateContainerTaskCatalog(input)).toEqual({
      ok: false,
      errors: ["tasks must be an array"],
    });
    expect(reads).toBe(2);
  });
});

describe("#3918 native engine member admission", () => {
  it("rejects malformed engines despite an own forEach that skips members", () => {
    const engines = Object.defineProperty([{ engine: "other", state: "available" }], "forEach", {
      value: (): void => undefined,
    });
    expect(validateContainerCapabilityResponse({ ...baseCapability(), engines })).toEqual({
      ok: false,
      errors: ["engines[0].engine is invalid"],
    });
  });
  it("rejects an engine hole that cannot satisfy the member contract", () => {
    expect(
      validateContainerCapabilityResponse({ ...baseCapability(), engines: new Array<unknown>(1) }),
    ).toEqual({ ok: false, errors: ["engines[0] must be an object"] });
  });
  it("rejects a nonarray second engine observation with the original two reads", () => {
    let reads = 0;
    const input = Object.defineProperty({ ...baseCapability() }, "engines", {
      get: (): unknown =>
        ++reads === 1 ? baseCapability().engines : { forEach: (): void => undefined },
    });
    expect(validateContainerCapabilityResponse(input)).toEqual({
      ok: false,
      errors: ["engines must be an array"],
    });
    expect(reads).toBe(2);
  });
});

it("#3918 refuses a large sparse engines collection at its first missing member", () => {
  const result = validateContainerCapabilityResponse({
    ...baseCapability(),
    engines: new Array<unknown>(100000),
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBe("engines[0] must be an object");
  }
});

it("#3918 bounds sparse container task diagnostics", () => {
  const result = validateContainerTaskCatalog({
    ...baseCatalog(),
    tasks: new Array<unknown>(100000),
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBe("tasks[0] must be an object");
  }
});

it("#3918 retains inherited present container tasks and engines", () => {
  const tasks = new Array<unknown>(1);
  Object.setPrototypeOf(tasks, Object.defineProperty([], "0", { value: baseTask() }));
  const catalog = { ...baseCatalog(), tasks };
  const catalogResult = validateContainerTaskCatalog(catalog);
  expect(catalogResult.ok).toBe(true);
  if (catalogResult.ok) expect(catalogResult.value).toBe(catalog);
  const engines = new Array<unknown>(1);
  Object.setPrototypeOf(
    engines,
    Object.defineProperty([], "0", { value: { engine: "docker", state: "available" } }),
  );
  const capability = { ...baseCapability(), engines };
  const capabilityResult = validateContainerCapabilityResponse(capability);
  expect(capabilityResult.ok).toBe(true);
  if (capabilityResult.ok) expect(capabilityResult.value).toBe(capability);
});

it("#3918 preserves dense container task and engine error order", () => {
  expect(validateContainerTaskCatalog({ ...baseCatalog(), tasks: [null, null] })).toEqual({
    ok: false,
    errors: ["tasks[0] must be an object", "tasks[1] must be an object"],
  });
  expect(
    validateContainerCapabilityResponse({ ...baseCapability(), engines: [null, null] }),
  ).toEqual({
    ok: false,
    errors: ["engines[0] must be an object", "engines[1] must be an object"],
  });
});

// Characterization of the existing catalog walk on ORIGINAL and SAME, not a new admission rule.
async function catalogTraversalValidator(
  surface: "source" | "public",
): Promise<typeof validateContainerTaskCatalog> {
  return surface === "source"
    ? validateContainerTaskCatalog
    : (await import("@oscharko-dev/keiko-contracts/runtime/container-runtime"))
        .validateContainerTaskCatalog;
}

function assertContainerCatalogInspection(
  validate: PhysicalTaskCatalogValidator,
  input: unknown,
  failure: TypeError,
): void {
  let caught: unknown;
  try {
    validate(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
}

registerPhysicalTaskCatalogContract(
  "Container",
  baseTask,
  baseCatalog,
  catalogTraversalValidator,
  assertContainerCatalogInspection,
  observeIndexedMembers,
);
