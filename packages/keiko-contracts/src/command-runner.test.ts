import { describe, expect, expectTypeOf, it } from "vitest";
import {
  MAX_PROJECT_ID_LENGTH,
  MAX_TASK_ID_LENGTH,
  MAX_REQUEST_ID_LENGTH,
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
import { validateRunResultCore } from "./run-result-validation.js";

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

  // KEIKO-0302: every peer validator in this territory enforces a closed key set precisely so an
  // unexpected field on a documented content-free contract cannot ride through into evidence. These
  // did not, and the accepted object is passed on as `value`.
  it("rejects an unknown top-level key on a run request", () => {
    const parsed = parseCommandTaskRunRequest({ ...baseRequest(), promptText: "leak me" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.some((error) => error.includes("promptText"))).toBe(true);
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

  // KEIKO-0456. This boundary's own comment promises that "an oversized or non-token value cannot
  // reach the manager, the audit ledger, or the SSE fan-out", but only requestId was both bounded
  // and patterned: projectId had no bound at all and taskId no pattern. A newline or control
  // character in an identifier that is later interpolated into a log line or an SSE `data:` field is
  // a log-injection / frame-splitting primitive, which is exactly what this boundary exists to stop.
  it("bounds projectId, which is a filesystem path and so cannot take a token pattern", () => {
    expect(parseCommandTaskRunRequest({ ...baseRequest(), projectId: "x".repeat(4_097) }).ok).toBe(
      false,
    );
    expect(parseCommandTaskRunRequest({ ...baseRequest(), projectId: "/work/a b/proj" }).ok).toBe(
      true,
    );
  });

  it.each([
    ["newline", "/work/proj\ninjected"],
    ["carriage return", "/work/proj\rinjected"],
    ["NUL", "/work/proj\u0000"],
    ["escape", "/work/proj\u001b[31m"],
  ])("rejects a projectId containing a %s control character", (_label, projectId) => {
    expect(parseCommandTaskRunRequest({ ...baseRequest(), projectId }).ok).toBe(false);
  });

  it.each([
    ["space", "npm-script:my test"],
    ["newline", "npm-script:test\ndata: injected"],
    ["traversal", "../../etc/passwd"],
    ["quote", 'npm-script:"test"'],
    ["leading punctuation", "-npm-script:test"],
  ])("rejects a taskId that is not the discovered-script token shape (%s)", (_label, taskId) => {
    expect(parseCommandTaskRunRequest({ ...baseRequest(), taskId }).ok).toBe(false);
  });

  it("keeps accepting the real discovered-script token shape", () => {
    for (const taskId of ["npm-script:test", "a", "A1._:-", "npm-script:build.prod"]) {
      expect(parseCommandTaskRunRequest({ ...baseRequest(), taskId }).ok).toBe(true);
    }
  });

  it.each([
    ["fractional", 1.5],
    ["beyond the safe integer range", 1e300],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects a timeoutMs that is %s", (_label, timeoutMs) => {
    expect(parseCommandTaskRunRequest({ ...baseRequest(), timeoutMs }).ok).toBe(false);
  });
});

describe("validateCommandTaskCatalog", () => {
  it("accepts a well-formed catalog", () => {
    const parsed = validateCommandTaskCatalog(baseCatalog());
    expect(parsed.ok).toBe(true);
  });

  // KEIKO-0302: every peer validator in this territory enforces a closed key set precisely so an
  // unexpected field on a documented content-free contract cannot ride through into evidence — the
  // accepted object is handed on as `value`.
  it("rejects an unknown key on the catalog and on a task", () => {
    expect(validateCommandTaskCatalog({ ...baseCatalog(), promptText: "leak me" }).ok).toBe(false);
    const catalog = baseCatalog();
    const firstTask = catalog.tasks[0];
    expect(firstTask).toBeDefined();
    if (firstTask === undefined) return;
    expect(
      validateCommandTaskCatalog({
        ...catalog,
        tasks: [{ ...firstTask, promptText: "leak me" }],
      }).ok,
    ).toBe(false);
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

  it("rejects an unknown key on a run result (KEIKO-0302)", () => {
    expect(validateCommandTaskRunResult({ ...baseResult(), promptText: "leak me" }).ok).toBe(false);
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

// KEIKO-0601: command-runner.ts's and container-runtime.ts's run-result validators now both call
// this single shared, parameterized core (run-result-validation.ts) instead of each independently
// re-declaring the field-by-field checks. This test exercises the shared core directly, with a
// synthetic vocabulary that is neither executor's real one, proving the module (a) exists and
// (b) is genuinely parameterized rather than hard-coded to one executor's kinds/failure reasons.
describe("validateRunResultCore (shared with container-runtime.ts, KEIKO-0601)", () => {
  it("collects the full common field set in fixed order for an arbitrary vocabulary", () => {
    const errors: string[] = [];
    validateRunResultCore(
      {
        schemaVersion: "wrong",
        runId: "",
        taskId: "",
        kind: "not-a-real-kind",
        failureReason: "not-a-real-reason",
        exitCode: 1.5,
        durationMs: -2,
        truncated: "no",
        timedOut: 1,
        stdout: 0,
        stderr: null,
      },
      { schemaVersion: "synthetic-v1", kinds: ["alpha", "beta"], failureReasons: ["ok", "boom"] },
      errors,
    );
    expect(errors).toEqual([
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
    ]);
  });

  it("accepts a well-formed value against its own vocabulary and pushes no errors", () => {
    const errors: string[] = [];
    validateRunResultCore(
      {
        schemaVersion: "synthetic-v1",
        runId: "run-1",
        taskId: "task-1",
        kind: "alpha",
        failureReason: "ok",
        exitCode: 0,
        durationMs: 1,
        truncated: false,
        timedOut: false,
        stdout: "",
        stderr: "",
      },
      { schemaVersion: "synthetic-v1", kinds: ["alpha", "beta"], failureReasons: ["ok", "boom"] },
      errors,
    );
    expect(errors).toEqual([]);
  });

  it("splices an executor's own afterKind field validator between kind and failureReason", () => {
    // This is the exact mechanism container-runtime.ts uses to validate `engine` at the position
    // container-runtime.test.ts's fixed-order test pins: immediately after `kind`, before
    // `failureReason`. A regression here (e.g. running afterKind before kind, or after
    // failureReason) would silently reorder container-runtime's error output.
    const errors: string[] = [];
    validateRunResultCore(
      {
        schemaVersion: "synthetic-v1",
        runId: "run-1",
        taskId: "task-1",
        kind: "alpha",
        failureReason: "not-a-real-reason",
        exitCode: 0,
        durationMs: 1,
        truncated: false,
        timedOut: false,
        stdout: "",
        stderr: "",
      },
      { schemaVersion: "synthetic-v1", kinds: ["alpha", "beta"], failureReasons: ["ok", "boom"] },
      errors,
      (_value, pushErrors) => {
        pushErrors.push("engine is invalid");
      },
    );
    expect(errors).toEqual(["engine is invalid", "failureReason is invalid"]);
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

describe("#3918 command checked-phase preservation", () => {
  it("preserves request identity and optional field observation order", () => {
    const reads: string[] = [];
    const input = observedExecutionFields(
      { ...baseRequest(), timeoutMs: 12, requestId: "request-1" },
      reads,
    );
    const result = parseCommandTaskRunRequest(input);
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
    const result = validateCommandTaskCatalog(input);
    const admissionReads = [...reads];
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(input);
      expect(result.value.tasks[0]).toBe(task);
      expect(result.value.tasks[0]?.args).toBe(task.args);
    }
    expect(admissionReads).toEqual(["schemaVersion", "projectId", "tasks", "tasks"]);
  });
  it("preserves result identity and eager common-field order", () => {
    const reads: string[] = [];
    const input = observedExecutionFields({ ...baseResult() }, reads);
    const result = validateCommandTaskRunResult(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(input);
    expect(reads).toEqual([
      "schemaVersion",
      "runId",
      "taskId",
      "kind",
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
    const tasks = Object.defineProperty([{ ...baseTask(), id: 0 }], "forEach", {
      value: (): void => undefined,
    });
    expect(validateCommandTaskCatalog({ ...baseCatalog(), tasks })).toEqual({
      ok: false,
      errors: ["tasks[0].id must be a non-empty string"],
    });
  });
  it("rejects nonstring arguments despite an own every that claims success", () => {
    const args = Object.defineProperty([1], "every", { value: (): boolean => true });
    expect(
      validateCommandTaskCatalog({ ...baseCatalog(), tasks: [{ ...baseTask(), args }] }),
    ).toEqual({ ok: false, errors: ["tasks[0].args must be an array of strings"] });
  });
  it("rejects a task hole that cannot satisfy the member contract", () => {
    expect(validateCommandTaskCatalog({ ...baseCatalog(), tasks: new Array<unknown>(1) })).toEqual({
      ok: false,
      errors: ["tasks[0] must be an object"],
    });
  });
  it("rejects an argument hole that cannot satisfy the string contract", () => {
    expect(
      validateCommandTaskCatalog({
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
    expect(validateCommandTaskCatalog(input)).toEqual({
      ok: false,
      errors: ["tasks must be an array"],
    });
    expect(reads).toBe(2);
  });
});

it("#3918 refuses a large sparse tasks collection at its first missing member", () => {
  const result = validateCommandTaskCatalog({
    ...baseCatalog(),
    tasks: new Array<unknown>(100000),
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBe("tasks[0] must be an object");
  }
});

it("#3918 retains inherited present tasks and their original references", () => {
  const tasks = new Array<unknown>(1);
  Object.setPrototypeOf(tasks, Object.defineProperty([], "0", { value: baseTask() }));
  const input = { ...baseCatalog(), tasks };
  const result = validateCommandTaskCatalog(input);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toBe(input);
});

it("#3918 preserves dense task error order", () => {
  expect(validateCommandTaskCatalog({ ...baseCatalog(), tasks: [null, null] })).toEqual({
    ok: false,
    errors: ["tasks[0] must be an object", "tasks[1] must be an object"],
  });
});

import {
  parseCommandTaskRunRequest as publicCommandRequest,
  validateCommandTaskCatalog as publicCommandCatalog,
  validateCommandTaskRunResult as publicCommandResult,
  type CommandTaskRunRequestParse as PublicCommandRequestParse,
  type CommandTaskCatalogParse as PublicCommandCatalogParse,
  type CommandTaskRunResultParse as PublicCommandResultParse,
} from "@oscharko-dev/keiko-contracts/runtime/command-runner";

export function parsePublicCommandRequest(input: unknown): PublicCommandRequestParse {
  const result = publicCommandRequest(input);
  return result;
}
export function parsePublicCommandCatalog(input: unknown): PublicCommandCatalogParse {
  const result = publicCommandCatalog(input);
  return result;
}
export function parsePublicCommandResult(input: unknown): PublicCommandResultParse {
  const result = publicCommandResult(input);
  return result;
}

function throwingCommandField(field: string, thrown: unknown): unknown {
  return Object.defineProperty({}, field, {
    enumerable: true,
    get: (): never => {
      throw thrown;
    },
  });
}
function commandInspectionInputs(field: string): readonly unknown[] {
  const error = Object.defineProperty(new Error("fixture-private-message"), "name", {
    value: "fixture-private-name",
  });
  const privateAccess = Object.defineProperties(new Error(), {
    name: {
      get: (): never => {
        throw new Error("private name inspected");
      },
    },
    message: {
      get: (): never => {
        throw new Error("private message inspected");
      },
    },
    stack: {
      get: (): never => {
        throw new Error("private stack inspected");
      },
    },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  return [
    throwingCommandField(field, error),
    throwingCommandField(field, undefined),
    throwingCommandField(field, null),
    throwingCommandField(field, "fixture-private-thrown-string"),
    throwingCommandField(field, privateAccess),
    new Proxy(
      {},
      {
        ownKeys: (): never => {
          throw error;
        },
      },
    ),
    revoked.proxy,
  ];
}

describe("Command request public parser (#3918)", () => {
  it("pins source public and forwarding unknown inputs and checked results", () => {
    expectTypeOf(parseCommandTaskRunRequest).parameter(0).toBeUnknown();
    expectTypeOf(publicCommandRequest).parameter(0).toBeUnknown();
    expectTypeOf(parsePublicCommandRequest).parameter(0).toBeUnknown();
    expectTypeOf(parseCommandTaskRunRequest).parameter(0).not.toBeAny();
    expectTypeOf(publicCommandRequest).parameter(0).not.toBeAny();
    expectTypeOf(parsePublicCommandRequest).parameter(0).not.toBeAny();
    expectTypeOf(publicCommandRequest).toEqualTypeOf<typeof parseCommandTaskRunRequest>();
    expectTypeOf(publicCommandRequest).returns.toEqualTypeOf<PublicCommandRequestParse>();
    expectTypeOf(parsePublicCommandRequest).returns.toEqualTypeOf<PublicCommandRequestParse>();
    expectTypeOf(publicCommandRequest).returns.not.toBeAny();
    expectTypeOf(parsePublicCommandRequest).returns.not.toBeAny();
  });
  it("preserves request identity optionals and owning field observation order", () => {
    const reads: string[] = [];
    const input = observedExecutionFields(
      { ...baseRequest(), timeoutMs: 12, requestId: "request-1" },
      reads,
    );
    const parsed = parsePublicCommandRequest(input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toBe(input);
    expect(reads).toEqual([
      "projectId",
      "taskId",
      "timeoutMs",
      "timeoutMs",
      "requestId",
      "requestId",
    ]);
    const absent = baseRequest();
    const explicit = { ...baseRequest(), timeoutMs: undefined, requestId: undefined };
    for (const input of [absent, explicit])
      expect(parsePublicCommandRequest(input)).toEqual({ ok: true, value: input });
  });
  it("enforces producer owned identifier bounds and timer safety", () => {
    expect(
      parsePublicCommandRequest({
        projectId: "x".repeat(MAX_PROJECT_ID_LENGTH),
        taskId: "x".repeat(MAX_TASK_ID_LENGTH),
        requestId: "x".repeat(MAX_REQUEST_ID_LENGTH),
      }).ok,
    ).toBe(true);
    for (const input of [
      { ...baseRequest(), projectId: "x".repeat(MAX_PROJECT_ID_LENGTH + 1) },
      { ...baseRequest(), taskId: "x".repeat(MAX_TASK_ID_LENGTH + 1) },
      { ...baseRequest(), requestId: "x".repeat(MAX_REQUEST_ID_LENGTH + 1) },
      { ...baseRequest(), taskId: "private-task\ncontrol" },
      { ...baseRequest(), timeoutMs: 0.5 },
      { ...baseRequest(), timeoutMs: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(parsePublicCommandRequest(input).ok).toBe(false);
  });
  it("preserves ordered closed field refusals and rejects extra data", () => {
    const healthy = baseRequest();
    expect(parseCommandTaskRunRequest(healthy)).toEqual({ ok: true, value: healthy });
    expect(parsePublicCommandRequest(healthy)).toEqual({ ok: true, value: healthy });
    for (const parse of [parseCommandTaskRunRequest, parsePublicCommandRequest]) {
      expect(parse({ taskId: "npm-script:test" })).toEqual({
        ok: false,
        errors: ["projectId must be a non-empty string"],
      });
      expect(parse({ ...baseRequest(), projectId: 42 })).toEqual({
        ok: false,
        errors: ["projectId must be a non-empty string"],
      });
    }
    expect(
      parsePublicCommandRequest({
        extra: "fixture-private-body",
        projectId: "",
        taskId: "",
        timeoutMs: 0,
        requestId: 2,
      }),
    ).toEqual({
      ok: false,
      errors: [
        "request.extra is not allowed",
        "projectId must be a non-empty string",
        `taskId must be a non-empty string of up to ${String(MAX_TASK_ID_LENGTH)} characters`,
        "timeoutMs must be a positive finite number",
        `requestId must be a token of 1-${String(MAX_REQUEST_ID_LENGTH)} characters`,
      ],
    });
    for (const input of [null, [], 7])
      expect(parsePublicCommandRequest(input)).toEqual({
        ok: false,
        errors: ["request must be an object"],
      });
  });
  it("closes hostile getters undefined throws and revoked proxies without private error inspection", () => {
    for (const input of commandInspectionInputs("projectId")) {
      const expected = { ok: false, errors: ["payload could not be inspected"] };
      expect(parseCommandTaskRunRequest(input)).toEqual(expected);
      expect(parsePublicCommandRequest(input)).toEqual(expected);
    }
  });
});

describe("Command catalog public parser (#3918)", () => {
  it("pins source public and forwarding unknown inputs and checked results", () => {
    expectTypeOf(validateCommandTaskCatalog).parameter(0).toBeUnknown();
    expectTypeOf(publicCommandCatalog).parameter(0).toBeUnknown();
    expectTypeOf(parsePublicCommandCatalog).parameter(0).toBeUnknown();
    expectTypeOf(validateCommandTaskCatalog).parameter(0).not.toBeAny();
    expectTypeOf(publicCommandCatalog).parameter(0).not.toBeAny();
    expectTypeOf(parsePublicCommandCatalog).parameter(0).not.toBeAny();
    expectTypeOf(publicCommandCatalog).toEqualTypeOf<typeof validateCommandTaskCatalog>();
    expectTypeOf(publicCommandCatalog).returns.toEqualTypeOf<PublicCommandCatalogParse>();
    expectTypeOf(parsePublicCommandCatalog).returns.toEqualTypeOf<PublicCommandCatalogParse>();
    expectTypeOf(publicCommandCatalog).returns.not.toBeAny();
    expectTypeOf(parsePublicCommandCatalog).returns.not.toBeAny();
  });
  it("preserves original catalog task argument identity and admission reads", () => {
    const reads: string[] = [];
    const task = baseTask();
    const input = observedExecutionFields({ ...baseCatalog(), tasks: [task] }, reads);
    const parsed = parsePublicCommandCatalog(input);
    const admissionReads = [...reads];
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toBe(input);
      expect(parsed.value.tasks[0]).toBe(task);
      expect(parsed.value.tasks[0]?.args).toBe(task.args);
    }
    expect(admissionReads).toEqual(["schemaVersion", "projectId", "tasks", "tasks"]);
  });
  it("refuses unknown and malformed catalog task fields", () => {
    const healthy = baseCatalog();
    expect(validateCommandTaskCatalog(healthy)).toEqual({ ok: true, value: healthy });
    expect(parsePublicCommandCatalog(healthy)).toEqual({ ok: true, value: healthy });
    for (const input of [
      null,
      3,
      { ...baseCatalog(), schemaVersion: "unsupported" },
      { ...baseCatalog(), projectId: "" },
      { ...baseCatalog(), tasks: "fixture-private-body" },
      { ...baseCatalog(), extra: "fixture-private-body" },
      { ...baseCatalog(), tasks: [{ ...baseTask(), extra: "fixture-private-body" }] },
      { ...baseCatalog(), tasks: [{ ...baseTask(), executable: 4 }] },
      { ...baseCatalog(), tasks: [{ ...baseTask(), trustState: "unknown-state" }] },
    ])
      expect(parsePublicCommandCatalog(input).ok).toBe(false);
  });
  it("validates physical task and argument members despite replaced callbacks", () => {
    const tasks = Object.defineProperty([{ ...baseTask(), id: 0 }], "forEach", {
      value: (): void => undefined,
    });
    expect(parsePublicCommandCatalog({ ...baseCatalog(), tasks })).toEqual({
      ok: false,
      errors: ["tasks[0].id must be a non-empty string"],
    });
    const args = Object.defineProperty([1], "every", { value: (): boolean => true });
    expect(
      parsePublicCommandCatalog({ ...baseCatalog(), tasks: [{ ...baseTask(), args }] }),
    ).toEqual({ ok: false, errors: ["tasks[0].args must be an array of strings"] });
    expect(
      parsePublicCommandCatalog({
        ...baseCatalog(),
        tasks: [{ ...baseTask(), args: new Array<unknown>(1) }],
      }).ok,
    ).toBe(false);
  });
  it("preserves inherited tasks sparse first hole and changing second observation", () => {
    const tasks = new Array<unknown>(1);
    Object.setPrototypeOf(tasks, Object.defineProperty([], "0", { value: baseTask() }));
    const input = { ...baseCatalog(), tasks };
    const parsed = parsePublicCommandCatalog(input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toBe(input);
    const sparse = parsePublicCommandCatalog({
      ...baseCatalog(),
      tasks: new Array<unknown>(100000),
    });
    expect(sparse).toEqual({ ok: false, errors: ["tasks[0] must be an object"] });
    let reads = 0;
    const changing = Object.defineProperty({ ...baseCatalog() }, "tasks", {
      get: (): unknown => (++reads === 1 ? [baseTask()] : { forEach: (): void => undefined }),
    });
    expect(parsePublicCommandCatalog(changing)).toEqual({
      ok: false,
      errors: ["tasks must be an array"],
    });
    expect(reads).toBe(2);
  });
  it("closes hostile getters undefined throws and revoked proxies without private error inspection", () => {
    for (const input of commandInspectionInputs("schemaVersion")) {
      const expected = { ok: false, errors: ["payload could not be inspected"] };
      expect(validateCommandTaskCatalog(input)).toEqual(expected);
      expect(parsePublicCommandCatalog(input)).toEqual(expected);
    }
  });
});

describe("Command result public parser (#3918)", () => {
  it("pins source public and forwarding unknown inputs and checked results", () => {
    expectTypeOf(validateCommandTaskRunResult).parameter(0).toBeUnknown();
    expectTypeOf(publicCommandResult).parameter(0).toBeUnknown();
    expectTypeOf(parsePublicCommandResult).parameter(0).toBeUnknown();
    expectTypeOf(validateCommandTaskRunResult).parameter(0).not.toBeAny();
    expectTypeOf(publicCommandResult).parameter(0).not.toBeAny();
    expectTypeOf(parsePublicCommandResult).parameter(0).not.toBeAny();
    expectTypeOf(publicCommandResult).toEqualTypeOf<typeof validateCommandTaskRunResult>();
    expectTypeOf(publicCommandResult).returns.toEqualTypeOf<PublicCommandResultParse>();
    expectTypeOf(parsePublicCommandResult).returns.toEqualTypeOf<PublicCommandResultParse>();
    expectTypeOf(publicCommandResult).returns.not.toBeAny();
    expectTypeOf(parsePublicCommandResult).returns.not.toBeAny();
  });
  it("preserves result identity nullable exits and eager common field order", () => {
    const reads: string[] = [];
    const input = observedExecutionFields({ ...baseResult() }, reads);
    const parsed = parsePublicCommandResult(input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toBe(input);
    expect(reads).toEqual([
      "schemaVersion",
      "runId",
      "taskId",
      "kind",
      "failureReason",
      "exitCode",
      "durationMs",
      "truncated",
      "timedOut",
      "stdout",
      "stderr",
    ]);
    expect(parsePublicCommandResult({ ...baseResult(), exitCode: null }).ok).toBe(true);
  });
  it("refuses malformed result scalars vocabulary and extra fields", () => {
    for (const input of [
      null,
      1,
      { ...baseResult(), schemaVersion: "unsupported" },
      { ...baseResult(), runId: "" },
      { ...baseResult(), kind: "arbitrary" },
      { ...baseResult(), failureReason: "arbitrary" },
      { ...baseResult(), exitCode: "0" },
      { ...baseResult(), durationMs: -1 },
      { ...baseResult(), stdout: 1 },
      { ...baseResult(), truncated: "false" },
      { ...baseResult(), timedOut: "false" },
      { ...baseResult(), extra: "fixture-private-body" },
    ])
      expect(parsePublicCommandResult(input).ok).toBe(false);
  });
  it("closes hostile getters undefined throws and revoked proxies without private error inspection", () => {
    for (const input of commandInspectionInputs("schemaVersion")) {
      const expected = { ok: false, errors: ["payload could not be inspected"] };
      expect(validateCommandTaskRunResult(input)).toEqual(expected);
      expect(parsePublicCommandResult(input)).toEqual(expected);
    }
  });
});
