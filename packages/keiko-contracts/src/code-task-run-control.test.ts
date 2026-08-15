import { describe, expect, it } from "vitest";

import { hasInheritedEnumerableProperty } from "./code-task-acceptance.js";
import { CODE_TASK_GOVERNANCE_SCHEMA_VERSION } from "./code-task-governance.js";
import { withPollutedPrototype } from "./code-task-pollution-test-support.js";
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
    void _actionKind;
    void _grantScope;
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
    void _operation;
    void _actionKind;
    void _grantScope;
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
    void _status;
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
