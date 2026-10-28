import { describe, expect, expectTypeOf, it } from "vitest";
import type { CodingWorkbenchValidationResult } from "@oscharko-dev/keiko-contracts";
import {
  RUNTIME_GOVERNANCE_LIFECYCLE_KINDS as publicLifecycleKinds,
  RUNTIME_GOVERNANCE_OPERATIONS as publicOperations,
  validateRunControlSnapshotV1 as publicRunControlSnapshot,
  validateRuntimeGovernanceRequestV1 as publicGovernanceRequest,
  validateRuntimeGovernanceOutcomeV1 as publicGovernanceOutcome,
  type RunControlSnapshotV1 as PublicRunControlSnapshotV1,
  type RuntimeGovernanceRequestV1 as PublicRuntimeGovernanceRequestV1,
  type RuntimeGovernanceOutcomeV1 as PublicRuntimeGovernanceOutcomeV1,
} from "@oscharko-dev/keiko-contracts/runtime/code-task-run-control";

import { hasInheritedEnumerableProperty } from "./code-task-acceptance.js";
import {
  CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
  CODE_TASK_GRANT_SCOPES,
  GOVERNED_ACTION_DECISIONS,
} from "./code-task-governance.js";
import { withPollutedPrototype } from "./code-task-pollution-test-support.js";
import { expectCodeTaskRecordAdmission } from "./__tests__/support/code-task-record-admission.js";
import {
  validateRunControlSnapshotV1,
  validateRuntimeGovernanceOutcomeV1,
  validateRuntimeGovernanceRequestV1,
  type RunControlSnapshotV1,
  type RuntimeGovernanceOutcomeV1,
  type RuntimeGovernanceRequestV1,
} from "./code-task-run-control.js";

function snapshot(): RunControlSnapshotV1 {
  return {
    kind: "run-control-snapshot",
    schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
    taskId: "task-1" as RunControlSnapshotV1["taskId"],
    runId: "run-1" as RunControlSnapshotV1["runId"],
    runEpoch: 1,
    stateRevision: 2,
    idempotencyKey: "idem-1" as RunControlSnapshotV1["idempotencyKey"],
    grantRefs: [{ grantId: "grt-1" as never, grantScope: "task" }],
    recoveryRef: { outcome: "absent" },
    pendingQuestion: { outcome: "absent" },
  };
}

function decideRequest(): Extract<RuntimeGovernanceRequestV1, { operation: "decide" }> {
  return {
    operation: "decide",
    taskId: "task-1" as RuntimeGovernanceRequestV1["taskId"],
    runId: "run-1" as RuntimeGovernanceRequestV1["runId"],
    workspaceId: "ws-1" as RuntimeGovernanceRequestV1["workspaceId"],
    stateRevision: 2,
    idempotencyKey: "idem-1" as RuntimeGovernanceRequestV1["idempotencyKey"],
    actionKind: "vetted-command",
    requestedGrantScope: "once",
  };
}

describe("validateRunControlSnapshotV1", () => {
  it("accepts a snapshot with grants and explicit absent facts", () => {
    expect(validateRunControlSnapshotV1(snapshot())).toMatchObject({ ok: true });
  });

  it("accepts an explicit empty grant set", () => {
    expect(validateRunControlSnapshotV1({ ...snapshot(), grantRefs: [] })).toMatchObject({
      ok: true,
    });
  });

  it("rejects a negative epoch and a non-array grant set", () => {
    expect(validateRunControlSnapshotV1({ ...snapshot(), runEpoch: -1 }).ok).toBe(false);
    expect(validateRunControlSnapshotV1({ ...snapshot(), grantRefs: {} }).ok).toBe(false);
  });

  it("rejects a pending question fact that omits its tagged outcome", () => {
    expect(
      validateRunControlSnapshotV1({ ...snapshot(), pendingQuestion: { questionId: "que_1" } }).ok,
    ).toBe(false);
  });

  it("rejects a recovery ref value on an absent outcome", () => {
    expect(
      validateRunControlSnapshotV1({
        ...snapshot(),
        recoveryRef: { outcome: "absent", value: "handle" },
      }).ok,
    ).toBe(false);
  });
});

describe("validateRuntimeGovernanceRequestV1", () => {
  it("accepts a decide request with an action and grant scope", () => {
    expect(validateRuntimeGovernanceRequestV1(decideRequest())).toMatchObject({ ok: true });
  });

  it("accepts a lifecycle request without an action", () => {
    const { actionKind: _actionKind, requestedGrantScope: _grantScope, ...rest } = decideRequest();
    expect(validateRuntimeGovernanceRequestV1({ ...rest, operation: "pause" })).toMatchObject({
      ok: true,
    });
  });

  it("rejects an unknown operation", () => {
    expect(validateRuntimeGovernanceRequestV1({ ...decideRequest(), operation: "widen" }).ok).toBe(
      false,
    );
  });

  it("rejects a lifecycle request that smuggles an action field", () => {
    expect(validateRuntimeGovernanceRequestV1({ ...decideRequest(), operation: "stop" }).ok).toBe(
      false,
    );
  });

  it("rejects a decide request with an invalid action kind", () => {
    expect(
      validateRuntimeGovernanceRequestV1({ ...decideRequest(), actionKind: "mine-crypto" }).ok,
    ).toBe(false);
  });
});

describe("validateRuntimeGovernanceOutcomeV1", () => {
  it("accepts a decided outcome", () => {
    const outcome: RuntimeGovernanceOutcomeV1 = {
      kind: "runtime-governance-outcome",
      schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
      status: "decided",
      decision: "approval-required",
    };
    expect(validateRuntimeGovernanceOutcomeV1(outcome)).toMatchObject({ ok: true });
  });

  it("accepts a settled outcome with ordered lifecycle events", () => {
    const outcome: RuntimeGovernanceOutcomeV1 = {
      kind: "runtime-governance-outcome",
      schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
      status: "settled",
      events: [
        { sequence: 0, kind: "mutation-halted", stateRevision: 5 },
        { sequence: 1, kind: "paused", stateRevision: 6 },
      ],
    };
    expect(validateRuntimeGovernanceOutcomeV1(outcome)).toMatchObject({ ok: true });
  });

  it("treats a missing capability as unsupported with a bounded reason", () => {
    expect(
      validateRuntimeGovernanceOutcomeV1({
        kind: "runtime-governance-outcome",
        schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
        status: "unsupported",
        reasonCode: "no-pause-capability",
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects a decided outcome that carries lifecycle events", () => {
    expect(
      validateRuntimeGovernanceOutcomeV1({
        kind: "runtime-governance-outcome",
        schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
        status: "decided",
        events: [],
      }).ok,
    ).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(
      validateRuntimeGovernanceOutcomeV1({
        kind: "runtime-governance-outcome",
        schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
        status: "allowed",
      }).ok,
    ).toBe(false);
  });

  // KEIKO-0211: the check was a length bound only, so the "content-free reason code" rule this
  // message names was not the rule being enforced — "Denied: /Users/alice/secret" is 26 characters.
  // The package already owned the lower-kebab predicate; it just was not applied here.
  it.each([
    "Failed for user a@b.com",
    "Denied: /Users/alice/secret",
    "reason with spaces",
    "UPPERCASE",
    "-leading-hyphen",
    "trailing_underscore",
  ])("rejects a reasonCode carrying free text or a path (%s)", (reasonCode) => {
    expect(
      validateRuntimeGovernanceOutcomeV1({
        kind: "runtime-governance-outcome",
        schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
        status: "denied",
        reasonCode,
      }).ok,
    ).toBe(false);
  });

  it("still accepts a genuine lower-kebab reason code", () => {
    expect(
      validateRuntimeGovernanceOutcomeV1({
        kind: "runtime-governance-outcome",
        schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
        status: "denied",
        reasonCode: "grant-expired",
      }).ok,
    ).toBe(true);
  });
});

describe("run-control content-free references", () => {
  // recoveryRef is documented as a content-free handle but was bounded by length alone, so a
  // filesystem path rode straight through the same boundary.
  it.each(["/Users/alice/scratch", "C:\\temp\\run", "recovery ref with spaces"])(
    "rejects a recoveryRef known value of %s",
    (value) => {
      expect(
        validateRunControlSnapshotV1({ ...snapshot(), recoveryRef: { outcome: "known", value } })
          .ok,
      ).toBe(false);
    },
  );

  it("still accepts a content-free recovery handle", () => {
    expect(
      validateRunControlSnapshotV1({
        ...snapshot(),
        recoveryRef: { outcome: "known", value: "recovery-7f3a" },
      }).ok,
    ).toBe(true);
  });

  // KEIKO-0302 follow-on: boundedStringFactErrors/questionFactErrors checked `value` but never
  // the fact object's OWN keys, so a well-formed known fact padded with an extra field (e.g. free
  // text riding alongside a valid handle) validated and was returned verbatim.
  it("rejects a recoveryRef fact padded with an extra field", () => {
    expect(
      validateRunControlSnapshotV1({
        ...snapshot(),
        recoveryRef: { outcome: "known", value: "recovery-7f3a", promptText: "leak me" },
      }).ok,
    ).toBe(false);
    expect(
      validateRunControlSnapshotV1({
        ...snapshot(),
        recoveryRef: { outcome: "absent", promptText: "leak me" },
      }).ok,
    ).toBe(false);
  });

  it("rejects a pendingQuestion fact padded with an extra field", () => {
    expect(
      validateRunControlSnapshotV1({
        ...snapshot(),
        pendingQuestion: { outcome: "known", value: "que_1", promptText: "leak me" },
      }).ok,
    ).toBe(false);
    expect(
      validateRunControlSnapshotV1({
        ...snapshot(),
        pendingQuestion: { outcome: "absent", promptText: "leak me" },
      }).ok,
    ).toBe(false);
  });
});

// Codex P1 (thread 3789461971, filed against the sibling code-task-acceptance.ts pin but the same
// gap applies here): the two tests below whose fixture is Object.create({ value: "secret" }) do
// NOT exercise the restored "in" branch. That construction has a non-default prototype, so
// isRecord's own, already-present prototype-identity check rejects it before boundedStringFactErrors
// / questionFactErrors ever reach their "value" in value line -- confirmed by deleting both "in"
// branches and re-running: both tests still pass. They remain valid pins of the overall contract
// ("this attack shape is rejected"), relabeled honestly below; the mechanism test after them is
// what actually pins the "in" branch itself.
describe("prototype-based extra-field smuggling (KfQ / Codex P1 regression)", () => {
  it("rejects a recoveryRef fact shaped via Object.create (caught by isRecord's prototype check)", () => {
    const hostileFact = Object.create({ value: "secret" }) as Record<string, unknown>;
    hostileFact.outcome = "absent";
    expect(Object.keys(hostileFact)).toEqual(["outcome"]); // own-key view looks complete
    expect(Object.getOwnPropertyNames(hostileFact)).toEqual(["outcome"]);
    expect("value" in hostileFact).toBe(true);
    const result = validateRunControlSnapshotV1({ ...snapshot(), recoveryRef: hostileFact });
    expect(result.ok).toBe(false);
  });

  it("rejects a pendingQuestion fact shaped via Object.create (caught by isRecord's prototype check)", () => {
    const hostileFact = Object.create({ value: "secret" }) as Record<string, unknown>;
    hostileFact.outcome = "absent";
    const result = validateRunControlSnapshotV1({ ...snapshot(), pendingQuestion: hostileFact });
    expect(result.ok).toBe(false);
  });

  it("rejects a recoveryRef/pendingQuestion fact with a non-default prototype and nothing own", () => {
    const degenerate = Object.create({ outcome: "absent" }) as Record<string, unknown>;
    expect(validateRunControlSnapshotV1({ ...snapshot(), recoveryRef: degenerate }).ok).toBe(false);
    expect(validateRunControlSnapshotV1({ ...snapshot(), pendingQuestion: degenerate }).ok).toBe(
      false,
    );
  });

  it("still accepts an ordinary explicit-absent fact for both", () => {
    expect(validateRunControlSnapshotV1(snapshot())).toMatchObject({ ok: true });
  });
});

// Codex P1 (thread 3789635890, mirrors code-task-acceptance.ts's identical fix): checking one
// inherited key at a time never pins the guard either -- the tests above are rejected by isRecord
// before reaching it, and a prior "mechanism" test only demonstrated the for...in language feature
// in isolation, never calling this file's own code. hasInheritedEnumerableProperty is exported
// specifically so it can be exercised directly: these tests call the real production guard with a
// crafted object, bypassing isRecord on purpose (a test targeting this function does not have to
// satisfy isRecord's separate "is this a plain object" question first, unlike every real caller).
describe("hasInheritedEnumerableProperty (Codex P1 3789635890)", () => {
  it("detects an inherited value with only outcome as an own property", () => {
    const fact = Object.create({ value: "secret" }) as Record<string, unknown>;
    fact.outcome = "absent";
    expect(hasInheritedEnumerableProperty(fact)).toBe(true);
  });

  it("detects an inherited discriminator on an otherwise-empty object", () => {
    // The gap Codex actually found: pollute "outcome" itself rather than "value". An object with
    // ZERO own properties still answers fact.outcome === "absent" via inheritance, and
    // unknownKeys' Object.getOwnPropertyNames scan sees nothing at all to report.
    const fact = Object.create({ outcome: "absent" }) as Record<string, unknown>;
    expect(Object.keys(fact)).toEqual([]);
    expect(fact.outcome).toBe("absent");
    expect(hasInheritedEnumerableProperty(fact)).toBe(true);
  });

  it("detects an inherited, wholly undeclared field", () => {
    // Every validator here returns its input by reference (never a reconstructed copy), so an
    // inherited field that is not even part of the contract -- promptText is this audit's
    // recurring example of a smuggled free-text field -- still rides along on the object handed
    // onward, invisible to unknownKeys because it is not own.
    const fact = Object.create({ promptText: "leak me" }) as Record<string, unknown>;
    fact.outcome = "absent";
    expect(Object.keys(fact)).toEqual(["outcome"]);
    expect(hasInheritedEnumerableProperty(fact)).toBe(true);
  });

  it("does not flag an ordinary, fully-own object", () => {
    expect(hasInheritedEnumerableProperty({ outcome: "absent" })).toBe(false);
    expect(hasInheritedEnumerableProperty({ outcome: "known", value: "que_1" })).toBe(false);
  });
});

describe("recoveryRef/pendingQuestion: the null-prototype case (KfQ 3789542391, refuted again at 3789776138)", () => {
  // KfQ 3789542391 / 3789776138 (new thread, same claim): isRecord's
  // Object.getPrototypeOf(value) === Object.prototype check rejects a null-prototype object today,
  // and JSON.parse never produces one, so rejecting can never affect a legitimate wire-shaped
  // payload -- deliberate, already pinned here, reused for the new thread id.
  it("rejects a null-prototype recoveryRef and pendingQuestion", () => {
    const makeNullProto = (): Record<string, unknown> => {
      const fact: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      fact.outcome = "absent";
      return fact;
    };
    const recoveryRef = makeNullProto();
    expect(Object.getPrototypeOf(recoveryRef)).toBeNull();
    expect(validateRunControlSnapshotV1({ ...snapshot(), recoveryRef }).ok).toBe(false);
    expect(
      validateRunControlSnapshotV1({ ...snapshot(), pendingQuestion: makeNullProto() }).ok,
    ).toBe(false);
  });
});

// Codex P1 3789773829, the terminating fix (full reasoning at ownField's definition in
// code-task-acceptance.ts, imported here alongside hasInheritedEnumerableProperty rather than
// reimplemented). withPollutedPrototype (imported from code-task-pollution-test-support.ts, not
// reimplemented here: KfQ 3789982967 found a real bug in this helper when it was still copy-pasted
// per file) mirrors code-task-acceptance.test.ts's identical helper: calling vitest's expect()
// WHILE Object.prototype is polluted throws inside expect's own internals for at least the "value"
// key (confirmed empirically), so it captures only a plain result during the polluted window and
// restores deterministically in a finally BEFORE any assertion runs.

// Non-enumerable pollution isolates ownField's OWN contribution cleanly (see
// code-task-acceptance.test.ts's identical describe block for why enumerable pollution cannot: it
// trips hasInheritedEnumerableProperty on every OTHER nested object in the same payload too, via
// for...in walking the full chain, not only the field under test). Proved red-then-green against a
// temporary ownField sabotage (reverted to plain `record[key]`, matching the coordinator's literal
// acceptance criterion) in the commit this test shipped in.
describe("ownField makes an inherited field unreadable regardless of descriptor shape (Codex P1 3789773829)", () => {
  it("rejects a recoveryRef's inherited non-enumerable value on the known branch", () => {
    const payload = { ...snapshot(), recoveryRef: { outcome: "known" } }; // no own "value"
    const result = withPollutedPrototype(
      "value",
      { value: "recovery-7f3a", enumerable: false },
      () => validateRunControlSnapshotV1(payload),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a pendingQuestion's inherited non-enumerable outcome discriminator", () => {
    const payload = { ...snapshot(), pendingQuestion: {} }; // wholly empty
    const result = withPollutedPrototype("outcome", { value: "absent", enumerable: false }, () =>
      validateRunControlSnapshotV1(payload),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a runtime governance request's inherited non-enumerable operation discriminator", () => {
    // Strip actionKind/requestedGrantScope too, not just operation: left in, they are own keys
    // outside RUNTIME_GOVERNANCE_TARGET_KEYS on a non-decide request and get rejected by
    // unknownKeys regardless of the operation discriminator, confounding what this test measures
    // (caught empirically: this test passed even with ownField sabotaged, for the wrong reason).
    const {
      operation: _operation,
      actionKind: _actionKind,
      requestedGrantScope: _grantScope,
      ...target
    } = decideRequest();
    const result = withPollutedPrototype("operation", { value: "pause", enumerable: false }, () =>
      validateRuntimeGovernanceRequestV1(target),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a runtime governance outcome's inherited non-enumerable status discriminator", () => {
    const legitimate = {
      kind: "runtime-governance-outcome" as const,
      schemaVersion: CODE_TASK_GOVERNANCE_SCHEMA_VERSION,
      status: "unsupported" as const,
      reasonCode: "no-pause-capability",
    };
    const { status: _status, ...withoutStatus } = legitimate;
    const result = withPollutedPrototype(
      "status",
      { value: "unsupported", enumerable: false },
      () => validateRuntimeGovernanceOutcomeV1(withoutStatus),
    );
    expect(result.ok).toBe(false);
  });

  it("still accepts a legitimate snapshot once Object.prototype is restored", () => {
    // Sanity: withPollutedPrototype's finally actually cleans up.
    expect(validateRunControlSnapshotV1(snapshot())).toMatchObject({ ok: true });
  });
});

// Enumerable pollution -- Codex's original, simpler shapes -- is kept as belt-and-braces per the
// coordinator's explicit direction. These do NOT isolate ownField's marginal contribution (see the
// comment on the describe block above); they pin that the pipeline still rejects them end to end.
describe("hasInheritedEnumerableProperty still independently rejects the enumerable shapes Codex originally found", () => {
  it("rejects an inherited enumerable value on an otherwise-complete recoveryRef", () => {
    const payload = { ...snapshot(), recoveryRef: { outcome: "absent" } };
    const result = withPollutedPrototype(
      "value",
      { value: "recovery-7f3a", enumerable: true, writable: true },
      () => validateRunControlSnapshotV1(payload),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an inherited enumerable outcome on an entirely empty pendingQuestion", () => {
    const payload = { ...snapshot(), pendingQuestion: {} };
    const result = withPollutedPrototype(
      "outcome",
      { value: "absent", enumerable: true, writable: true },
      () => validateRunControlSnapshotV1(payload),
    );
    expect(result.ok).toBe(false);
  });
});

// KfQ 3789542365 (mirrors code-task-acceptance.ts:218): the same "return early on an own value
// field" shape existed in boundedStringFactErrors and questionFactErrors. A test asserting only
// ok === false cannot tell early-return from collect-both apart -- both fail for a fixture with just
// one problem. Only a fixture with TWO independent problems, and an assertion that BOTH specific
// messages appear, actually pins collect over early-return. Proved red-then-green against a
// temporary early-return sabotage (see the commit this test shipped in for the measurement).
describe("boundedStringFactErrors/questionFactErrors collect every violation (KfQ 3789542365)", () => {
  it("reports both the disallowed value and the unrelated extra key on recoveryRef", () => {
    const result = validateRunControlSnapshotV1({
      ...snapshot(),
      recoveryRef: { outcome: "absent", value: "recovery-7f3a", promptText: "leak me" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes("must not carry a value"))).toBe(true);
    expect(result.errors.some((error) => error.includes("promptText"))).toBe(true);
  });

  it("reports both the disallowed value and the unrelated extra key on pendingQuestion", () => {
    const result = validateRunControlSnapshotV1({
      ...snapshot(),
      pendingQuestion: { outcome: "absent", value: "que_1", promptText: "leak me" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes("must not carry a value"))).toBe(true);
    expect(result.errors.some((error) => error.includes("promptText"))).toBe(true);
  });

  // Not KfQ-filed (the finding named only the non-known branches above), but the same early-return
  // shape existed in both "known" branches too and was fixed the same way for consistency -- an
  // untested decision either way, so pinned here rather than left implicit.
  it("reports both the invalid value and the unrelated extra key on a known recoveryRef", () => {
    const result = validateRunControlSnapshotV1({
      ...snapshot(),
      recoveryRef: { outcome: "known", value: "/Users/alice/scratch", promptText: "leak me" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes("bounded content-free reference"))).toBe(
      true,
    );
    expect(result.errors.some((error) => error.includes("promptText"))).toBe(true);
  });

  it("reports both the invalid value and the unrelated extra key on a known pendingQuestion", () => {
    const result = validateRunControlSnapshotV1({
      ...snapshot(),
      pendingQuestion: { outcome: "known", value: "not-a-question-id", promptText: "leak me" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.includes("must be a question id"))).toBe(true);
    expect(result.errors.some((error) => error.includes("promptText"))).toBe(true);
  });
});

describe("C1A run-control member admission", () => {
  it.each(["source", "public"])("refuses skipped grant validation through %s", async (seam) => {
    const validate =
      seam === "source"
        ? validateRunControlSnapshotV1
        : (await import("@oscharko-dev/keiko-contracts/runtime/code-task-run-control"))
            .validateRunControlSnapshotV1;
    const grantRefs = [{ grantId: 0, grantScope: "task" }];
    Object.defineProperty(grantRefs, "forEach", { value: (): void => undefined });
    expect(validate({ ...snapshot(), grantRefs }).ok).toBe(false);
  });
  it.each(["source", "public"])("refuses skipped lifecycle validation through %s", async (seam) => {
    const validate =
      seam === "source"
        ? validateRuntimeGovernanceOutcomeV1
        : (await import("@oscharko-dev/keiko-contracts/runtime/code-task-run-control"))
            .validateRuntimeGovernanceOutcomeV1;
    const events = [{ sequence: 0, kind: "bogus", stateRevision: 2 }];
    Object.defineProperty(events, "forEach", { value: (): void => undefined });
    expect(
      validate({ kind: "runtime-governance-outcome", schemaVersion: 1, status: "settled", events })
        .ok,
    ).toBe(false);
  });
  it.each(["source", "public"])("refuses sparse grants through %s", async (seam) => {
    const validate =
      seam === "source"
        ? validateRunControlSnapshotV1
        : (await import("@oscharko-dev/keiko-contracts/runtime/code-task-run-control"))
            .validateRunControlSnapshotV1;
    expect(validate({ ...snapshot(), grantRefs: Array<unknown>(1) }).ok).toBe(false);
  });
  it.each(["source", "public"])("refuses sparse lifecycle events through %s", async (seam) => {
    const validate =
      seam === "source"
        ? validateRuntimeGovernanceOutcomeV1
        : (await import("@oscharko-dev/keiko-contracts/runtime/code-task-run-control"))
            .validateRuntimeGovernanceOutcomeV1;
    expect(
      validate({
        kind: "runtime-governance-outcome",
        schemaVersion: 1,
        status: "settled",
        events: Array<unknown>(1),
      }).ok,
    ).toBe(false);
  });
  it.each(["source", "public"])("bounds first-hole grant diagnostics through %s", async (seam) => {
    const validate =
      seam === "source"
        ? validateRunControlSnapshotV1
        : (await import("@oscharko-dev/keiko-contracts/runtime/code-task-run-control"))
            .validateRunControlSnapshotV1;
    expect(validate({ ...snapshot(), grantRefs: Array<unknown>(100_000) })).toEqual({
      ok: false,
      errors: ["grantRefs[0] must be an object"],
    });
  });
  it.each(["source", "public"])(
    "bounds first-hole lifecycle diagnostics through %s",
    async (seam) => {
      const validate =
        seam === "source"
          ? validateRuntimeGovernanceOutcomeV1
          : (await import("@oscharko-dev/keiko-contracts/runtime/code-task-run-control"))
              .validateRuntimeGovernanceOutcomeV1;
      expect(
        validate({
          kind: "runtime-governance-outcome",
          schemaVersion: 1,
          status: "settled",
          events: Array<unknown>(100_000),
        }),
      ).toEqual({ ok: false, errors: ["events[0] must be an object"] });
    },
  );
});

describe("C1A run-control preservation", () => {
  it.each(["source", "public"])(
    "retains three output identities and empty collections through %s",
    async (seam) => {
      const validators =
        seam === "source"
          ? {
              validateRunControlSnapshotV1,
              validateRuntimeGovernanceRequestV1,
              validateRuntimeGovernanceOutcomeV1,
            }
          : await import("@oscharko-dev/keiko-contracts/runtime/code-task-run-control");
      const input = { ...snapshot(), grantRefs: [] };
      const request = decideRequest();
      const outcome = {
        kind: "runtime-governance-outcome",
        schemaVersion: 1,
        status: "settled",
        events: [],
      };
      const first = validators.validateRunControlSnapshotV1(input);
      const second = validators.validateRuntimeGovernanceRequestV1(request);
      const third = validators.validateRuntimeGovernanceOutcomeV1(outcome);
      expect(first.ok && first.value === input && first.value.grantRefs === input.grantRefs).toBe(
        true,
      );
      expect(second.ok && second.value === request).toBe(true);
      expect(third.ok && third.value === outcome && third.value.events === outcome.events).toBe(
        true,
      );
    },
  );

  it.each(["source", "public"])("retains the observed task-id read through %s", async (seam) => {
    const validate =
      seam === "source"
        ? validateRunControlSnapshotV1
        : (await import("@oscharko-dev/keiko-contracts/runtime/code-task-run-control"))
            .validateRunControlSnapshotV1;
    const input = snapshot();
    const taskId = input.taskId;
    let reads = 0;
    Object.defineProperty(input, "taskId", {
      get: (): string => {
        reads += 1;
        return taskId;
      },
    });
    const result = validate(input);
    expect(result.ok && result.value === input).toBe(true);
    expect(reads).toBe(1);
  });
});

describe("C1A finite run-control discriminator observations", () => {
  it.each(["source", "public"])(
    "refuses an invalid observed operation through %s",
    async (seam) => {
      const validate =
        seam === "source"
          ? validateRuntimeGovernanceRequestV1
          : (await import("@oscharko-dev/keiko-contracts/runtime/code-task-run-control"))
              .validateRuntimeGovernanceRequestV1;
      const { actionKind: _actionKind, requestedGrantScope: _scope, ...target } = decideRequest();
      const input = { ...target, operation: "pause" };
      let reads = 0;
      Object.defineProperty(input, "operation", {
        get: (): string => {
          reads += 1;
          return reads === 1 ? "pause" : "invalid";
        },
      });
      expect(validate(input).ok).toBe(false);
      expect(reads).toBe(2);
    },
  );

  it.each(["source", "public"])(
    "refuses an invalid observed outcome branch through %s",
    async (seam) => {
      const validate =
        seam === "source"
          ? validateRuntimeGovernanceOutcomeV1
          : (await import("@oscharko-dev/keiko-contracts/runtime/code-task-run-control"))
              .validateRuntimeGovernanceOutcomeV1;
      const input = {
        kind: "runtime-governance-outcome",
        schemaVersion: 1,
        status: "unsupported",
        reasonCode: "no-capability",
      };
      let reads = 0;
      Object.defineProperty(input, "status", {
        get: (): string => {
          reads += 1;
          return reads === 1 ? "unsupported" : "invalid";
        },
      });
      expect(validate(input).ok).toBe(false);
      expect(reads).toBe(2);
    },
  );

  it.each(["source", "public"])(
    "preserves valid changing run-control fallback observations through %s",
    async (seam) => {
      const validators =
        seam === "source"
          ? { validateRuntimeGovernanceRequestV1, validateRuntimeGovernanceOutcomeV1 }
          : await import("@oscharko-dev/keiko-contracts/runtime/code-task-run-control");
      const { actionKind: _actionKind, requestedGrantScope: _scope, ...target } = decideRequest();
      const request = { ...target, operation: "pause" };
      let operationReads = 0;
      Object.defineProperty(request, "operation", {
        get: (): string => {
          operationReads += 1;
          return operationReads === 1 ? "pause" : "stop";
        },
      });
      expect(validators.validateRuntimeGovernanceRequestV1(request).ok).toBe(true);
      expect(operationReads).toBe(2);
      const outcome = {
        kind: "runtime-governance-outcome",
        schemaVersion: 1,
        status: "unsupported",
        reasonCode: "no-capability",
      };
      let statusReads = 0;
      Object.defineProperty(outcome, "status", {
        get: (): string => {
          statusReads += 1;
          return statusReads === 1 ? "unsupported" : "denied";
        },
      });
      expect(validators.validateRuntimeGovernanceOutcomeV1(outcome).ok).toBe(true);
      expect(statusReads).toBe(2);
    },
  );
});

type SourceRunControlSnapshotParse = CodingWorkbenchValidationResult<RunControlSnapshotV1>;
type SourceGovernanceRequestParse = CodingWorkbenchValidationResult<RuntimeGovernanceRequestV1>;
type SourceGovernanceOutcomeParse = CodingWorkbenchValidationResult<RuntimeGovernanceOutcomeV1>;
type PublicRunControlSnapshotParse = CodingWorkbenchValidationResult<PublicRunControlSnapshotV1>;
type PublicGovernanceRequestParse =
  CodingWorkbenchValidationResult<PublicRuntimeGovernanceRequestV1>;
type PublicGovernanceOutcomeParse =
  CodingWorkbenchValidationResult<PublicRuntimeGovernanceOutcomeV1>;

export function parsePublicRunControlSnapshot(
  input: unknown,
): CodingWorkbenchValidationResult<PublicRunControlSnapshotV1> {
  const result = publicRunControlSnapshot(input);
  return result;
}

export function parsePublicGovernanceRequest(
  input: unknown,
): CodingWorkbenchValidationResult<PublicRuntimeGovernanceRequestV1> {
  const result = publicGovernanceRequest(input);
  return result;
}

export function parsePublicGovernanceOutcome(
  input: unknown,
): CodingWorkbenchValidationResult<PublicRuntimeGovernanceOutcomeV1> {
  const result = publicGovernanceOutcome(input);
  return result;
}

describe("run control snapshot public parser (#3918)", () => {
  it("retains original grants and nested fact identities", () => {
    const input = {
      ...snapshot(),
      grantRefs: CODE_TASK_GRANT_SCOPES.map((grantScope) => ({ grantId: "grt-1", grantScope })),
    };
    const result = parsePublicRunControlSnapshot(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new TypeError("healthy run control snapshot refused");
    expect(result.value).toBe(input);
    expect(result.value.grantRefs).toBe(input.grantRefs);
    for (const [index, ref] of input.grantRefs.entries())
      expect(result.value.grantRefs[index]).toBe(ref);
    expect(result.value.recoveryRef).toBe(input.recoveryRef);
    expect(result.value.pendingQuestion).toBe(input.pendingQuestion);
  });

  it("retains all tagged fact outcomes empty grants and omitted fact values", () => {
    for (const outcome of ["absent", "unavailable", "unknown"]) {
      const input = {
        ...snapshot(),
        grantRefs: [],
        recoveryRef: { outcome },
        pendingQuestion: { outcome },
      };
      const result = parsePublicRunControlSnapshot(input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new TypeError("healthy non-known run control facts refused");
      expect(result.value).toBe(input);
      expect(result.value.grantRefs).toBe(input.grantRefs);
      expect(Object.hasOwn(result.value.recoveryRef, "value")).toBe(false);
      expect(Object.hasOwn(result.value.pendingQuestion, "value")).toBe(false);
      expect(
        parsePublicRunControlSnapshot({ ...input, recoveryRef: { outcome, value: undefined } }).ok,
      ).toBe(false);
      expect(
        parsePublicRunControlSnapshot({ ...input, pendingQuestion: { outcome, value: undefined } })
          .ok,
      ).toBe(false);
    }
    const input = {
      ...snapshot(),
      recoveryRef: { outcome: "known", value: "checkpoint-1" },
      pendingQuestion: { outcome: "known", value: "que_1" },
    };
    const result = parsePublicRunControlSnapshot(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new TypeError("healthy known run control facts refused");
    expect(result.value.recoveryRef).toBe(input.recoveryRef);
    expect(result.value.pendingQuestion).toBe(input.pendingQuestion);
  });

  it("refuses malformed snapshots with exact eager ordered diagnostics", () => {
    expect(parsePublicRunControlSnapshot(null)).toEqual({
      ok: false,
      errors: ["run-control snapshot must be an object"],
    });
    expect(
      parsePublicRunControlSnapshot({
        ...snapshot(),
        runEpoch: -1,
        stateRevision: -1,
        grantRefs: {},
      }),
    ).toEqual({
      ok: false,
      errors: [
        "runEpoch must be a non-negative integer",
        "stateRevision must be a non-negative integer",
        "grantRefs must be an array",
      ],
    });
  });

  it("retains the single observed task id read", () => {
    const input = snapshot();
    const taskId = input.taskId;
    let reads = 0;
    Object.defineProperty(input, "taskId", {
      get: (): string => {
        reads += 1;
        return taskId;
      },
    });
    const result = parsePublicRunControlSnapshot(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new TypeError("healthy observed run control snapshot refused");
    expect(result.value).toBe(input);
    expect(reads).toBe(1);
  });

  it("pins source public and forwarding checked return types", () => {
    expectTypeOf(
      validateRunControlSnapshotV1,
    ).returns.toEqualTypeOf<SourceRunControlSnapshotParse>();
    expectTypeOf(publicRunControlSnapshot).returns.toEqualTypeOf<PublicRunControlSnapshotParse>();
    expectTypeOf(
      parsePublicRunControlSnapshot,
    ).returns.toEqualTypeOf<PublicRunControlSnapshotParse>();
    const result = parsePublicRunControlSnapshot(snapshot());
    if (!result.ok) throw new TypeError("healthy public snapshot types refused");
    expectTypeOf(result.value.taskId).toEqualTypeOf<PublicRunControlSnapshotV1["taskId"]>();
    expectTypeOf(result.value.grantRefs).toEqualTypeOf<PublicRunControlSnapshotV1["grantRefs"]>();
    type Failure = Extract<ReturnType<typeof publicRunControlSnapshot>, { readonly ok: false }>;
    expectTypeOf<Failure["errors"]>().toEqualTypeOf<readonly string[]>();
  });
});

describe("runtime governance request public parser (#3918)", () => {
  it("retains every operation identity and closed branch fields", () => {
    const { actionKind, requestedGrantScope, ...target } = decideRequest();
    for (const operation of publicOperations) {
      const input =
        operation === "decide"
          ? { ...target, operation, actionKind, requestedGrantScope }
          : { ...target, operation };
      const result = parsePublicGovernanceRequest(input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new TypeError("healthy public governance operation refused");
      expect(result.value).toBe(input);
      expect(Object.hasOwn(result.value, "actionKind")).toBe(operation === "decide");
      expect(Object.hasOwn(result.value, "requestedGrantScope")).toBe(operation === "decide");
      if (operation !== "decide")
        expect(
          parsePublicGovernanceRequest({
            ...input,
            actionKind: undefined,
            requestedGrantScope: undefined,
          }).ok,
        ).toBe(false);
    }
  });

  it("retains both admitted decide grant scopes", () => {
    for (const requestedGrantScope of CODE_TASK_GRANT_SCOPES) {
      const input = { ...decideRequest(), requestedGrantScope };
      const result = parsePublicGovernanceRequest(input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new TypeError("healthy decide grant scope refused");
      expect(result.value).toBe(input);
    }
  });

  it("refuses malformed requests with exact eager ordered diagnostics", () => {
    expect(parsePublicGovernanceRequest(null)).toEqual({
      ok: false,
      errors: ["runtime governance request must be an object"],
    });
    expect(
      parsePublicGovernanceRequest({
        ...decideRequest(),
        actionKind: "bogus",
        requestedGrantScope: "forever",
        taskId: 0,
        stateRevision: -1,
      }),
    ).toEqual({
      ok: false,
      errors: [
        "actionKind is invalid",
        "requestedGrantScope is invalid",
        "taskId is invalid",
        "stateRevision must be a non-negative integer",
      ],
    });
  });

  it("retains the second observed operation refusal", () => {
    const { actionKind: _actionKind, requestedGrantScope: _scope, ...target } = decideRequest();
    const input = { ...target, operation: "pause" };
    let reads = 0;
    Object.defineProperty(input, "operation", {
      get: (): string => {
        reads += 1;
        return reads === 1 ? "pause" : "invalid";
      },
    });
    expect(parsePublicGovernanceRequest(input)).toEqual({
      ok: false,
      errors: ["operation is invalid"],
    });
    expect(reads).toBe(2);
  });

  it("pins source public and forwarding checked return types", () => {
    expectTypeOf(
      validateRuntimeGovernanceRequestV1,
    ).returns.toEqualTypeOf<SourceGovernanceRequestParse>();
    expectTypeOf(publicGovernanceRequest).returns.toEqualTypeOf<PublicGovernanceRequestParse>();
    expectTypeOf(
      parsePublicGovernanceRequest,
    ).returns.toEqualTypeOf<PublicGovernanceRequestParse>();
    const result = parsePublicGovernanceRequest(decideRequest());
    if (!result.ok) throw new TypeError("healthy public governance request types refused");
    expectTypeOf(result.value.runId).toEqualTypeOf<PublicRuntimeGovernanceRequestV1["runId"]>();
    if (result.value.operation === "decide")
      expectTypeOf(result.value.requestedGrantScope).toEqualTypeOf<"once" | "task">();
    type Failure = Extract<ReturnType<typeof publicGovernanceRequest>, { readonly ok: false }>;
    expectTypeOf<Failure["errors"]>().toEqualTypeOf<readonly string[]>();
  });
});

describe("runtime governance outcome public parser (#3918)", () => {
  it("retains all outcome identities and ordered lifecycle references", () => {
    const base = { kind: "runtime-governance-outcome", schemaVersion: 1 };
    const events = publicLifecycleKinds.map((kind, sequence) => ({
      sequence,
      kind,
      stateRevision: sequence,
    }));
    const settled = { ...base, status: "settled", events };
    for (const input of [
      ...GOVERNED_ACTION_DECISIONS.map((decision) => ({ ...base, status: "decided", decision })),
      settled,
      { ...base, status: "unsupported", reasonCode: "no-capability" },
      { ...base, status: "denied", reasonCode: "policy-denied" },
    ]) {
      const result = parsePublicGovernanceOutcome(input);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new TypeError("healthy public governance outcome refused");
      expect(result.value).toBe(input);
      if (result.value.status === "settled") {
        expect(result.value.events).toBe(events);
        for (const [index, event] of events.entries())
          expect(result.value.events[index]).toBe(event);
      }
    }
    const empty = { ...base, status: "settled", events: [] };
    const result = parsePublicGovernanceOutcome(empty);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new TypeError("healthy empty public lifecycle refused");
    expect(result.value).toBe(empty);
  });

  it("refuses fields from foreign outcome arms including own undefined", () => {
    const base = { kind: "runtime-governance-outcome", schemaVersion: 1 };
    for (const input of [
      { ...base, status: "decided", decision: "allowed", events: undefined },
      { ...base, status: "settled", events: [], decision: undefined },
      { ...base, status: "unsupported", reasonCode: "no-capability", events: undefined },
      { ...base, status: "denied", reasonCode: "policy-denied", decision: undefined },
    ]) {
      expect(parsePublicGovernanceOutcome(input).ok).toBe(false);
    }
  });

  it("refuses malformed outcomes with exact eager ordered diagnostics", () => {
    const healthy = {
      kind: "runtime-governance-outcome",
      schemaVersion: 1,
      status: "settled",
      events: [],
    };
    expect(validateRuntimeGovernanceOutcomeV1(healthy)).toEqual({ ok: true, value: healthy });
    expect(parsePublicGovernanceOutcome(healthy)).toEqual({ ok: true, value: healthy });
    expect(parsePublicGovernanceOutcome(null)).toEqual({
      ok: false,
      errors: ["runtime governance outcome must be an object"],
    });
    expect(
      parsePublicGovernanceOutcome({
        kind: "wrong",
        schemaVersion: 2,
        status: "settled",
        events: [{ sequence: -1, stateRevision: -1, kind: "bogus" }],
      }),
    ).toEqual({
      ok: false,
      errors: [
        "kind is invalid",
        "schemaVersion must be the literal 1",
        "events[0].sequence must be a non-negative integer",
        "events[0].stateRevision must be a non-negative integer",
        "events[0].kind is invalid",
      ],
    });
  });

  it("retains the second observed status refusal", () => {
    const input = {
      kind: "runtime-governance-outcome",
      schemaVersion: 1,
      status: "unsupported",
      reasonCode: "no-capability",
    };
    let reads = 0;
    Object.defineProperty(input, "status", {
      get: (): string => {
        reads += 1;
        return reads === 1 ? "unsupported" : "invalid";
      },
    });
    expect(parsePublicGovernanceOutcome(input)).toEqual({
      ok: false,
      errors: ["status is invalid"],
    });
    expect(reads).toBe(2);
  });

  it("pins source public and forwarding checked return types", () => {
    expectTypeOf(
      validateRuntimeGovernanceOutcomeV1,
    ).returns.toEqualTypeOf<SourceGovernanceOutcomeParse>();
    expectTypeOf(publicGovernanceOutcome).returns.toEqualTypeOf<PublicGovernanceOutcomeParse>();
    expectTypeOf(
      parsePublicGovernanceOutcome,
    ).returns.toEqualTypeOf<PublicGovernanceOutcomeParse>();
    const result = parsePublicGovernanceOutcome({
      kind: "runtime-governance-outcome",
      schemaVersion: 1,
      status: "settled",
      events: [],
    });
    if (!result.ok) throw new TypeError("healthy public governance outcome types refused");
    if (result.value.status === "settled")
      expectTypeOf(result.value.events).toEqualTypeOf<
        Extract<PublicRuntimeGovernanceOutcomeV1, { status: "settled" }>["events"]
      >();
    type Failure = Extract<ReturnType<typeof publicGovernanceOutcome>, { readonly ok: false }>;
    expectTypeOf<Failure["errors"]>().toEqualTypeOf<readonly string[]>();
  });
});

it.each(["source", "public"])(
  "preserves strict record and own-key admission through %s",
  async (surface) => {
    const validate =
      surface === "source"
        ? validateRunControlSnapshotV1
        : (await import("@oscharko-dev/keiko-contracts/runtime/code-task-run-control"))
            .validateRunControlSnapshotV1;
    expectCodeTaskRecordAdmission(
      validate,
      snapshot,
      (input): object => input,
      "runControlSnapshot must not carry symbol-keyed properties",
      (): readonly [string, string] => [
        "runControlSnapshot.fixtureExtra is not allowed",
        "runControlSnapshot must not carry symbol-keyed properties",
      ],
    );
  },
);

it("public CodeTask ID consumer refuses an invalid idempotency key", () => {
  for (const validate of [validateRunControlSnapshotV1, publicRunControlSnapshot]) {
    const input = snapshot();
    const accepted = validate(input);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.value).toBe(input);
    expect(validate({ ...input, idempotencyKey: "" })).toEqual({
      ok: false,
      errors: ["idempotencyKey is invalid"],
    });
  }
});

const SNAPSHOT_IDENTITY_HEADER_FIELDS = [
  "kind",
  "schemaVersion",
  "taskId",
  "runId",
  "idempotencyKey",
  "runEpoch",
  "stateRevision",
] as const;

describe.each([
  ["source", validateRunControlSnapshotV1],
  ["public", publicRunControlSnapshot],
] as const)("%s identity-header observations", (_surface, validate): void => {
  it("reads the healthy header and local suffix once in order with original receivers", (): void => {
    const input = snapshot();
    const trace: string[] = [];
    const receivers: unknown[] = [];
    for (const field of SNAPSHOT_IDENTITY_HEADER_FIELDS) {
      const original = input[field];
      Object.defineProperty(input, field, {
        get(this: unknown): unknown {
          trace.push(field);
          receivers.push(this);
          return original;
        },
      });
    }
    const result = validate(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(input);
    expect(trace).toEqual([
      "kind",
      "schemaVersion",
      "taskId",
      "runId",
      "idempotencyKey",
      "runEpoch",
      "stateRevision",
    ]);
    expect(receivers).toHaveLength(7);
    for (const receiver of receivers) expect(receiver).toBe(input);
  });

  it("retains earlier own-key errors and eagerly checks every refused prefix and local suffix", (): void => {
    const input = {
      ...snapshot(),
      kind: "foreign",
      schemaVersion: 2,
      taskId: 0,
      runId: "",
      idempotencyKey: false,
      runEpoch: -1,
      stateRevision: -1,
      fixtureExtra: true,
    };
    const trace: string[] = [];
    for (const field of SNAPSHOT_IDENTITY_HEADER_FIELDS) {
      const original = input[field];
      Object.defineProperty(input, field, {
        get(): unknown {
          trace.push(field);
          return original;
        },
      });
    }
    expect(validate(input)).toEqual({
      ok: false,
      errors: [
        "runControlSnapshot.fixtureExtra is not allowed",
        "kind must be run-control-snapshot",
        "schemaVersion must be the literal 1",
        "taskId is invalid",
        "runId is invalid",
        "idempotencyKey is invalid",
        "runEpoch must be a non-negative integer",
        "stateRevision must be a non-negative integer",
      ],
    });
    expect(trace).toEqual([
      "kind",
      "schemaVersion",
      "taskId",
      "runId",
      "idempotencyKey",
      "runEpoch",
      "stateRevision",
    ]);
  });

  it("propagates each opaque header getter refusal without later observations", (): void => {
    for (const [fault, expected] of [
      ["kind", ["kind"]],
      ["schemaVersion", ["kind", "schemaVersion"]],
      ["taskId", ["kind", "schemaVersion", "taskId"]],
      ["runId", ["kind", "schemaVersion", "taskId", "runId"]],
    ] as const) {
      const input = snapshot();
      const trace: string[] = [];
      const failure: Error = Object.freeze(new TypeError("synthetic identity-header refusal"));
      for (const field of SNAPSHOT_IDENTITY_HEADER_FIELDS) {
        const original = input[field];
        Object.defineProperty(input, field, {
          get(): unknown {
            trace.push(field);
            if (field === fault) throw failure;
            return original;
          },
        });
      }
      let observed: unknown;
      try {
        validate(input);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBe(failure);
      expect(trace).toEqual(expected);
    }
  });
});
