import { describe, expect, it } from "vitest";
import {
  DEBUG_LIFECYCLE_EVENT_KINDS,
  DEBUG_LIFECYCLE_REASONS,
  DEBUG_SESSION_STATES,
  EVIDENCE_KEYS,
  LEGAL_STATES_BY_EVENT,
  isDebugLifecycleEvent,
  isDebugLifecycleEvidence,
} from "./debug-lifecycle.js";

const valid = {
  schemaVersion: "1",
  eventKind: "start",
  sessionId: "opaque-session",
  state: "starting",
  reason: "requested",
  targetKind: "file",
  backend: "oci",
  network: "none",
  filesystem: "executionRoot",
  provisioningDigest: "a".repeat(64),
  timestampMs: 1,
  activationRevision: 2,
  outputAcceptedBytes: 0,
  outputTruncatedEvents: 0,
};

describe("debug lifecycle evidence", () => {
  it("accepts the closed content-free shape", () => {
    expect(isDebugLifecycleEvidence(valid)).toBe(true);
  });

  it.each(["path", "argv", "env", "output", "expression", "error"])(
    "does not make %s part of the accepted schema",
    (field) => {
      expect(isDebugLifecycleEvidence({ ...valid, [field]: "secret" })).toBe(false);
    },
  );

  it("rejects prototype-backed, non-enumerable, and symbol-keyed evidence shapes", () => {
    const nonEnumerable = { ...valid };
    Object.defineProperty(nonEnumerable, "argv", { value: ["secret"], enumerable: false });
    const nonEnumerableRequired = { ...valid };
    Object.defineProperty(nonEnumerableRequired, "schemaVersion", {
      value: "1",
      enumerable: false,
    });
    const symbolKeyed = { ...valid, [Symbol("secret")]: "value" };

    expect(isDebugLifecycleEvidence(Object.create(valid))).toBe(false);
    expect(isDebugLifecycleEvidence(nonEnumerable)).toBe(false);
    expect(isDebugLifecycleEvidence(nonEnumerableRequired)).toBe(false);
    expect(isDebugLifecycleEvidence(symbolKeyed)).toBe(false);
  });

  it("rejects invalid provisioning digests without throwing", () => {
    expect(() =>
      isDebugLifecycleEvidence({ ...valid, provisioningDigest: "secret" }),
    ).not.toThrow();
    expect(isDebugLifecycleEvidence({ ...valid, provisioningDigest: "secret" })).toBe(false);
  });

  it.each([
    ["unknown event", { eventKind: "other" }],
    ["unknown state", { state: "other" }],
    ["unknown reason", { reason: "other" }],
    ["overlong id", { sessionId: "a".repeat(129) }],
    ["negative revision", { activationRevision: -1 }],
    ["negative count", { outputAcceptedBytes: -1 }],
    ["NaN timestamp", { timestampMs: Number.NaN }],
    ["fractional count", { outputTruncatedEvents: 1.5 }],
  ])("rejects %s", (_label, replacement) => {
    expect(isDebugLifecycleEvidence({ ...valid, ...replacement })).toBe(false);
  });

  it("accepts a 128-character sessionId (SESSION_ID's documented max)", () => {
    expect(isDebugLifecycleEvidence({ ...valid, sessionId: "a".repeat(128) })).toBe(true);
  });

  it("accepts restart-throttled failure evidence as a closed terminal vocabulary", () => {
    expect(
      isDebugLifecycleEvidence({
        ...valid,
        eventKind: "failure",
        state: "restartThrottled",
        reason: "restartThrottled",
      }),
    ).toBe(true);
  });

  // Derived from the production lookups (KEIKO-0377) rather than restated here — the third
  // hand-maintained copy of each vocabulary this finding flags — so a member added to the union AND
  // its Record<Union, true> table is automatically exercised here too, with nothing left to forget.
  //
  // eventKind and state are no longer independently-membership-checked (KEIKO-0890): a member of
  // each closed vocabulary can still form a semantically illegal pairing (e.g. "start" + "running"),
  // so every (eventKind, state) combination is exercised against LEGAL_STATES_BY_EVENT instead of
  // crossing DEBUG_LIFECYCLE_EVENT_KINDS with DEBUG_SESSION_STATES independently. Because
  // LEGAL_STATES_BY_EVENT is a complete Record<DebugLifecycleEventKind, …>, every event kind still
  // gets an entry with nothing left to forget; the table's own values are what say which states are
  // legal for it.
  //
  // This in-package check only proves "accepted iff in the table" — it cannot catch a
  // DebugSessionState the table omits from every legal set (that state's asserted rejection stays
  // green here regardless of whether the real producer emits it). The compensating control for that
  // gap lives outside this package: debugSessionRegistry.test.ts drives the real producer
  // (packages/keiko-server/src/editor/dap/debugSessionRegistry.ts) through every terminal path and
  // fails if it ever emits an (eventKind, state) pairing this table does not recognize.
  it.each(
    DEBUG_LIFECYCLE_EVENT_KINDS.flatMap((eventKind) =>
      DEBUG_SESSION_STATES.map((state) => [eventKind, state] as const),
    ),
  )(
    "(eventKind: %s, state: %s) is accepted iff it is in LEGAL_STATES_BY_EVENT",
    (eventKind, state) => {
      expect(isDebugLifecycleEvidence({ ...valid, eventKind, state })).toBe(
        LEGAL_STATES_BY_EVENT[eventKind].has(state),
      );
    },
  );

  it.each(DEBUG_LIFECYCLE_REASONS)("accepts closed reason %s", (reason) => {
    expect(isDebugLifecycleEvidence({ ...valid, reason })).toBe(true);
  });

  it.each(["catalog", "file"])("accepts target kind %s", (targetKind) => {
    expect(isDebugLifecycleEvidence({ ...valid, targetKind })).toBe(true);
  });

  it.each(["oci", "linuxNamespace", "windowsContainer"])("accepts backend %s", (backend) => {
    expect(isDebugLifecycleEvidence({ ...valid, backend })).toBe(true);
  });

  it.each([
    ["schemaVersion", "2"],
    ["sessionId", "!opaque"],
    ["sessionId", "opaque!"],
    ["sessionId", ""],
    ["provisioningDigest", "A".repeat(64)],
    ["targetKind", "other"],
    ["backend", "other"],
    ["network", "host"],
    ["filesystem", "host"],
  ])("rejects hostile %s independently", (field, value) => {
    expect(isDebugLifecycleEvidence({ ...valid, [field]: value })).toBe(false);
  });

  // All ten string-typed DebugLifecycleEvidence fields (KEIKO-0882) — the other four
  // (timestampMs, activationRevision, outputAcceptedBytes, outputTruncatedEvents) are numeric and
  // covered separately below.
  it.each([
    "schemaVersion",
    "eventKind",
    "sessionId",
    "state",
    "reason",
    "targetKind",
    "backend",
    "network",
    "filesystem",
    "provisioningDigest",
  ])("rejects a non-string %s", (field) => {
    for (const value of [123, null, {}, []]) {
      expect(isDebugLifecycleEvidence({ ...valid, [field]: value })).toBe(false);
    }
  });

  it.each(["timestampMs", "activationRevision", "outputAcceptedBytes", "outputTruncatedEvents"])(
    "requires a nonnegative safe integer for %s",
    (field) => {
      for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "1"]) {
        expect(isDebugLifecycleEvidence({ ...valid, [field]: value })).toBe(false);
      }
    },
  );

  it.each(Object.keys(valid))("requires exact key %s", (field) => {
    const candidate = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field));
    expect(isDebugLifecycleEvidence(candidate)).toBe(false);
  });

  it.each([null, [], "value", 1, true])("rejects non-record evidence", (value) => {
    expect(isDebugLifecycleEvidence(value)).toBe(false);
  });

  it("rejects arrays even when hostile properties mimic every evidence field", () => {
    expect(isDebugLifecycleEvidence(Object.assign([], valid))).toBe(false);
  });

  // KEIKO-0890 red proof: eventKind "start" and state "running" are each independently members of
  // their closed vocabularies, so the pre-fix three-independent-checks hasClosedVocabulary accepted
  // this pairing even though no producer ever emits a "start" event carrying a "running" state (that
  // pairing is "active"/"running" — see debugSessionRegistry.ts). This must fail against the
  // unmodified code and pass once hasClosedVocabulary also consults LEGAL_STATES_BY_EVENT.
  it("rejects a syntactically valid but semantically illegal (eventKind, state) pairing", () => {
    expect(isDebugLifecycleEvidence({ ...valid, eventKind: "start", state: "running" })).toBe(
      false,
    );
  });

  it("does not coerce an object-shaped provisioning digest", () => {
    const provisioningDigest = { toString: (): string => "a".repeat(64) };
    expect(isDebugLifecycleEvidence({ ...valid, provisioningDigest })).toBe(false);
  });

  it("rejects callable values even when hostile properties mimic evidence", () => {
    const callable = Object.assign((): void => undefined, valid);
    expect(isDebugLifecycleEvidence(callable)).toBe(false);
  });

  it("rejects evidence inherited entirely through the prototype chain", () => {
    const inherited = Object.create(valid) as unknown;
    expect(Object.keys(inherited as object)).toEqual([]);
    expect(isDebugLifecycleEvidence(inherited)).toBe(false);
  });
});

// KEIKO-0383 — DebugLifecycleEvent is statically a DebugLifecycleEvidence, but the evidence guard
// scans for an EXACT key set and so rejects the extra `sequence` field. Every consumer therefore
// hand-rolled its own check, and the one in keiko-server bounded `sequence` only as "> 0" without
// stating the domain anywhere the type could be read from.
describe("isDebugLifecycleEvent", () => {
  it("accepts a valid evidence record carrying a 1-based sequence", () => {
    expect(isDebugLifecycleEvent({ ...valid, sequence: 1 })).toBe(true);
    expect(isDebugLifecycleEvent({ ...valid, sequence: 42 })).toBe(true);
  });

  it("rejects an evidence record with no sequence at all", () => {
    expect(isDebugLifecycleEvent(valid)).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null])(
    "rejects the out-of-domain sequence %p",
    (sequence) => {
      expect(isDebugLifecycleEvent({ ...valid, sequence })).toBe(false);
    },
  );

  it("rejects an unknown extra key alongside a valid sequence", () => {
    expect(isDebugLifecycleEvent({ ...valid, sequence: 1, extra: "x" })).toBe(false);
  });

  it("stays disjoint from the evidence guard in both directions", () => {
    expect(isDebugLifecycleEvidence({ ...valid, sequence: 1 })).toBe(false);
    expect(isDebugLifecycleEvent(valid)).toBe(false);
    expect(isDebugLifecycleEvidence(valid)).toBe(true);
  });
});

// KEIKO-0377: the closed vocabularies are now Record<Union, true> tables so a member missing from a
// table is a compile error (proven by the manual mutation check in the finding's own
// mustFailBeforeFix, not repeatable here as a permanent test without breaking the build). These
// tests pin the exported derivations' exact sizes as a second, independent guard, and prove the
// `Object.hasOwn`-based membership check does not fall back to prototype-chain lookups.
describe("debug lifecycle closed-vocabulary derivation (KEIKO-0377)", () => {
  it("exports exactly the ten documented session states", () => {
    expect(DEBUG_SESSION_STATES).toHaveLength(10);
    expect(new Set(DEBUG_SESSION_STATES).size).toBe(10);
  });

  it("exports exactly the six documented event kinds", () => {
    expect(DEBUG_LIFECYCLE_EVENT_KINDS).toHaveLength(6);
    expect(new Set(DEBUG_LIFECYCLE_EVENT_KINDS).size).toBe(6);
  });

  it("exports exactly the fifteen documented reasons", () => {
    expect(DEBUG_LIFECYCLE_REASONS).toHaveLength(15);
    expect(new Set(DEBUG_LIFECYCLE_REASONS).size).toBe(15);
  });

  it("exports EVIDENCE_KEYS with exactly the fourteen documented evidence fields", () => {
    const keys = Object.keys(EVIDENCE_KEYS);
    expect(keys).toHaveLength(14);
    expect(keys.sort()).toEqual(Object.keys(valid).sort());
  });

  // A naive `key in TABLE` membership check (rather than `Object.hasOwn`) would answer `true` for
  // any of these — they exist on Object.prototype, not as an own property of any specific table —
  // so a hostile record could smuggle a prototype method name past hasClosedVocabulary/hasExactKeys
  // as though it were a legitimate vocabulary member.
  it.each(["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"])(
    "rejects the prototype-chain name %s standing in for eventKind/state/reason",
    (name) => {
      expect(isDebugLifecycleEvidence({ ...valid, eventKind: name })).toBe(false);
      expect(isDebugLifecycleEvidence({ ...valid, state: name })).toBe(false);
      expect(isDebugLifecycleEvidence({ ...valid, reason: name })).toBe(false);
    },
  );

  it("rejects the prototype-chain name constructor standing in for a required evidence key", () => {
    const candidate = Object.fromEntries(
      Object.entries(valid).filter(([key]) => key !== "schemaVersion"),
    ) as Record<string, unknown>;
    // `Object.defineProperty` rather than `candidate.constructor = ...`: direct assignment to
    // `.constructor` type-checks against Object.prototype's `constructor: Function`, not the index
    // signature, for a reason unrelated to what this test is exercising.
    Object.defineProperty(candidate, "constructor", { value: "1", enumerable: true });
    expect(isDebugLifecycleEvidence(candidate)).toBe(false);
  });
});
