import { describe, expect, it } from "vitest";
import { EDITOR_AGENT_SESSION_ID_MAX_BYTES } from "../../packages/keiko-contracts/src/editor-agent.js";
import type { EditorCompletionContextSelectors } from "../../packages/keiko-contracts/src/editor-completion.js";

// Shared observable contract of the real request parsers; no parser results are synthesized.
interface RequestValue {
  readonly root: string;
  readonly editorSessionId?: string;
  readonly context?: EditorCompletionContextSelectors;
}

type Parser<Value extends RequestValue> = (
  input: unknown,
) =>
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly errors: readonly string[] };
type Surfaces<Value extends RequestValue> = readonly (readonly [string, Parser<Value>])[];
interface ParserCase<Value extends RequestValue> {
  readonly parse: Parser<Value>;
  readonly makeRequest: () => Record<string, unknown>;
}
interface PayloadParserCase<Value extends RequestValue> extends ParserCase<Value> {
  readonly payloadKey: Extract<keyof Value, "document" | "target">;
}
interface DocumentValue extends RequestValue {
  readonly document: unknown;
  readonly position: unknown;
}
interface PrefixParserCase<Value extends DocumentValue> extends ParserCase<Value> {
  readonly triggerDiagnostic: string;
  readonly eagerReads: readonly string[];
}

export function registerCapturedRootAdmission<Value extends RequestValue>(
  surfaces: Surfaces<Value>,
  makeRequest: () => Record<string, unknown>,
): void {
  it.each(surfaces)("%s refuses a malformed second root", (_surface, parse): void => {
    const input = makeRequest();
    let reads = 0;
    Object.defineProperty(input, "root", {
      get: (): string | undefined => (++reads === 1 ? "/repo" : undefined),
    });
    expect(parse(input)).toEqual({ ok: false, errors: ["root must be a non-empty string"] });
    expect(reads).toBe(2);
  });
  it.each(surfaces)("%s keeps a valid changed second root", (_surface, parse): void => {
    const input = makeRequest();
    let reads = 0;
    Object.defineProperty(input, "root", {
      get: (): string => (++reads === 1 ? "/repo" : "/other"),
    });
    const parsed = parse(input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.root).toBe("/other");
    expect(reads).toBe(2);
  });
}

export function registerTriggerMembership<
  Value extends RequestValue & { readonly triggerKind: string },
>(
  surfaces: Surfaces<Value>,
  makeRequest: () => Record<string, unknown>,
  accepted: readonly string[],
  rejected: string,
  diagnostic: string,
): void {
  it.each(surfaces)("%s preserves trigger boundaries without coercion", (_surface, parse): void => {
    for (const triggerKind of accepted) {
      const parsed = parse({ ...makeRequest(), triggerKind });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.triggerKind).toBe(triggerKind);
    }
    let coercions = 0;
    const coercible = {
      [Symbol.toPrimitive](): string {
        coercions += 1;
        throw new TypeError("trigger coercion must not occur");
      },
    };
    for (const triggerKind of [rejected, undefined, null, 7, Symbol("trigger"), coercible]) {
      expect(parse({ ...makeRequest(), triggerKind })).toEqual({ ok: false, errors: [diagnostic] });
    }
    expect(coercions).toBe(0);
  });
}

export function registerDocumentRequestPrefix<Value extends DocumentValue>(
  parse: Parser<Value>,
  makeRequest: () => Record<string, unknown>,
  triggerDiagnostic: string,
  eagerReads: readonly string[],
): void {
  const subject = { parse, makeRequest, triggerDiagnostic, eagerReads };
  it("preserves ordered prefix diagnostics before local request diagnostics", (): void => {
    prefixDiagnostics(subject);
  });
  it("continues eager prefix observations after root refusal and retains healthy references", (): void => {
    prefixEager(subject);
  });
  it("propagates the same inherited document getter failure before position and local fields", (): void => {
    prefixFailure(subject);
  });
}

export function registerCapturedRequestIdentity<Value extends RequestValue>(
  parse: Parser<Value>,
  makeRequest: () => Record<string, unknown>,
  payloadKey: Extract<keyof Value, "document" | "target">,
): void {
  const subject = { parse, makeRequest, payloadKey };
  it("keeps changing inherited session reads, capture order and nested references", (): void => {
    identityChanging(subject);
  });
  it("distinguishes absent, guard-refused and captured own undefined sessions", (): void => {
    identityUndefined(subject);
  });
  it("refuses a malformed third session observation through the existing final predicate", (): void => {
    identityMalformed(subject);
  });
  it("preserves opaque capture faults and continues capture after an invalid second root", (): void => {
    identityFaults(subject);
  });
}

export function registerRequestContextProjection<Value extends RequestValue>(
  parse: Parser<Value>,
  makeRequest: () => Record<string, unknown>,
  payloadKey: Extract<keyof Value, "document" | "target">,
): void {
  const subject = { parse, makeRequest, payloadKey };
  it("projects the third context read after collection and preserves captured references", (): void => {
    contextThird(subject);
  });
  it("omits context after a refused projection guard or an empty projection", (): void => {
    contextOmission(subject);
  });
  it("propagates a projection getter failure before capture with exact identity", (): void => {
    contextFailure(subject);
  });
  it("retains an own undefined selector copied after a successful selector guard", (): void => {
    contextUndefined(subject);
  });
}

function prefixDiagnostics<Value extends DocumentValue>(subject: PrefixParserCase<Value>): void {
  expect(
    subject.parse({
      ...subject.makeRequest(),
      root: "",
      editorSessionId: "",
      document: null,
      position: null,
      triggerKind: "foreign",
      contextBudgetBytes: -1,
      maxCostClass: "unknown",
      context: 7,
    }),
  ).toEqual({
    ok: false,
    errors: [
      "root must be a non-empty string",
      `editorSessionId must be a non-empty string of at most ${EDITOR_AGENT_SESSION_ID_MAX_BYTES.toString()} UTF-8 bytes when provided`,
      "document must be { path, languageId, text }",
      "position must be { line, character }",
      subject.triggerDiagnostic,
      "contextBudgetBytes must be a non-negative integer",
      "maxCostClass must be one of: low, medium, high",
      "context must be an object when provided",
    ],
  });
}

function prefixEager<Value extends DocumentValue>(subject: PrefixParserCase<Value>): void {
  const reads: string[] = [];
  const input = new Proxy(
    { ...subject.makeRequest(), root: "", editorSessionId: "session" },
    {
      get(target, key, receiver): unknown {
        if (typeof key === "string") reads.push(key);
        const member: unknown = Reflect.get(target, key, receiver);
        return member;
      },
    },
  );
  expect(subject.parse(input)).toEqual({ ok: false, errors: ["root must be a non-empty string"] });
  expect(reads).toEqual(subject.eagerReads);
  const healthy = subject.makeRequest();
  const parsed = subject.parse(healthy);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value.document).toBe(healthy.document);
    expect(parsed.value.position).toBe(healthy.position);
  }
}

function prefixFailure<Value extends DocumentValue>(subject: PrefixParserCase<Value>): void {
  const failure = new TypeError("opaque document-prefix inspection");
  const reads: string[] = [];
  const values: Record<string, unknown> = {
    ...subject.makeRequest(),
    root: "",
    editorSessionId: "session",
  };
  delete values.document;
  Object.setPrototypeOf(values, {
    get document(): never {
      throw failure;
    },
  });
  const input = new Proxy(values, {
    get(target, key, receiver): unknown {
      if (typeof key === "string") reads.push(key);
      const member: unknown = Reflect.get(target, key, receiver);
      return member;
    },
  });
  let observed: unknown;
  try {
    subject.parse(input);
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(failure);
  expect(reads).toEqual(["root", "editorSessionId", "document"]);
}

function identityChanging<Value extends RequestValue>(subject: PayloadParserCase<Value>): void {
  const input = subject.makeRequest();
  const body = input[subject.payloadKey];
  const reads: string[] = [];
  installChangingSessionGetters(input, subject.payloadKey, body, reads);
  const parsed = subject.parse(input);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.value.root).toBe("/repo");
    expect(parsed.value.editorSessionId).toBe("captured-session");
    expect(parsed.value[subject.payloadKey]).toBe(body);
    expect(Object.keys(parsed.value).slice(0, 4)).toEqual([
      "schemaVersion",
      "root",
      "editorSessionId",
      subject.payloadKey,
    ]);
  }
  expect(reads).toEqual([
    "root",
    "session:1",
    subject.payloadKey,
    "root",
    "session:2",
    "session:3",
    subject.payloadKey,
  ]);
}

function identityUndefined<Value extends RequestValue>(subject: PayloadParserCase<Value>): void {
  const absent = subject.makeRequest();
  let absentReads = 0;
  Object.defineProperty(absent, "editorSessionId", {
    get(): undefined {
      absentReads += 1;
      return undefined;
    },
  });
  const omitted = subject.parse(absent);
  expect(omitted.ok).toBe(true);
  if (omitted.ok) expect(Object.hasOwn(omitted.value, "editorSessionId")).toBe(false);
  expect(absentReads).toBe(2);
  for (const mode of ["guard-refused", "captured-undefined"] as const) {
    const input = subject.makeRequest();
    let reads = 0;
    Object.defineProperty(input, "editorSessionId", {
      get(): unknown {
        reads += 1;
        if (reads === 1) return "initial-session";
        if (reads === 2) return mode === "guard-refused" ? "" : "checked-session";
        return undefined;
      },
    });
    const parsed = subject.parse(input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.hasOwn(parsed.value, "editorSessionId")).toBe(mode === "captured-undefined");
      expect(parsed.value.editorSessionId).toBeUndefined();
    }
    expect(reads).toBe(mode === "guard-refused" ? 2 : 3);
  }
}

function identityMalformed<Value extends RequestValue>(subject: PayloadParserCase<Value>): void {
  const input = subject.makeRequest();
  let reads = 0;
  Object.defineProperty(input, "editorSessionId", {
    get(): unknown {
      reads += 1;
      return reads === 3 ? 17 : "checked-session";
    },
  });
  expect(subject.parse(input)).toEqual({
    ok: false,
    errors: [
      `editorSessionId must be a non-empty string of at most ${EDITOR_AGENT_SESSION_ID_MAX_BYTES.toString()} UTF-8 bytes when provided`,
    ],
  });
  expect(reads).toBe(3);
}

function identityFaults<Value extends RequestValue>(subject: PayloadParserCase<Value>): void {
  for (const fault of ["root-second", "session-third"] as const) {
    const input = subject.makeRequest();
    const body = input[subject.payloadKey];
    const failure = new TypeError("opaque identity capture");
    const reads: string[] = [];
    let roots = 0;
    let sessions = 0;
    Object.defineProperty(input, "root", {
      get(): unknown {
        roots += 1;
        reads.push(`root:${roots.toString()}`);
        if (roots === 1) return "/repo";
        if (fault === "root-second") throw failure;
        return undefined;
      },
    });
    Object.defineProperty(input, "editorSessionId", {
      get(): string {
        sessions += 1;
        reads.push(`session:${sessions.toString()}`);
        if (sessions === 3) throw failure;
        return "checked-session";
      },
    });
    Object.defineProperty(input, subject.payloadKey, {
      get(): unknown {
        reads.push(subject.payloadKey);
        return body;
      },
    });
    let observed: unknown;
    try {
      subject.parse(input);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(failure);
    expect(reads).toEqual(identityFaultReads(fault, subject.payloadKey));
  }
}

function contextThird<Value extends RequestValue>(subject: PayloadParserCase<Value>): void {
  const input = subject.makeRequest();
  const body = input[subject.payloadKey];
  const trace: string[] = [];
  const receivers: unknown[] = [];
  const changedFiles = ["src/a.ts"];
  const guardOnly = {
    get queryText(): never {
      throw new TypeError("guard-only context must not be projected");
    },
  };
  let reads = 0;
  Object.defineProperty(input, subject.payloadKey, {
    get(): unknown {
      trace.push("body");
      return body;
    },
  });
  Object.defineProperty(input, "context", {
    get(this: unknown): unknown {
      receivers.push(this);
      reads += 1;
      trace.push(`context:${String(reads)}`);
      if (reads === 1) return { queryText: "collection" };
      if (reads === 2) return guardOnly;
      return { queryText: "third-projection", changedFiles };
    },
  });
  const parsed = subject.parse(input);
  expect(trace).toEqual(["body", "context:1", "context:2", "context:3", "body"]);
  expect(receivers).toHaveLength(3);
  for (const receiver of receivers) expect(receiver).toBe(input);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value[subject.payloadKey]).toBe(body);
  expect(parsed.value.context?.queryText).toBe("third-projection");
  expect(parsed.value.context?.changedFiles).toBe(changedFiles);
  expect(Object.keys(parsed.value.context ?? {})).toEqual(["queryText", "changedFiles"]);
}

function contextOmission<Value extends RequestValue>(subject: PayloadParserCase<Value>): void {
  for (const mode of ["refused", "empty"] as const) {
    const input = subject.makeRequest();
    let reads = 0;
    Object.defineProperty(input, "context", {
      get(): unknown {
        reads += 1;
        return mode === "refused" && reads === 2 ? undefined : {};
      },
    });
    const parsed = subject.parse(input);
    expect(reads).toBe(mode === "refused" ? 2 : 3);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) continue;
    expect(Object.hasOwn(parsed.value, "context")).toBe(false);
  }
}

function contextFailure<Value extends RequestValue>(subject: PayloadParserCase<Value>): void {
  const input = subject.makeRequest();
  const body = input[subject.payloadKey];
  const trace: string[] = [];
  const failure: Error = Object.freeze(new TypeError("synthetic context projection refusal"));
  let reads = 0;
  Object.defineProperty(input, subject.payloadKey, {
    get(): unknown {
      trace.push("body");
      return body;
    },
  });
  Object.defineProperty(input, "context", {
    get(): unknown {
      reads += 1;
      trace.push(`context:${String(reads)}`);
      if (reads === 3) throw failure;
      return {};
    },
  });
  let observed: unknown;
  try {
    subject.parse(input);
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(failure);
  expect(trace).toEqual(["body", "context:1", "context:2", "context:3"]);
}

function contextUndefined<Value extends RequestValue>(subject: PayloadParserCase<Value>): void {
  const input = subject.makeRequest();
  let reads = 0;
  input.context = {
    get queryText(): unknown {
      reads += 1;
      return reads === 4 ? undefined : "selector";
    },
  };
  const parsed = subject.parse(input);
  expect(reads).toBe(4);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(Object.hasOwn(parsed.value, "context")).toBe(true);
  expect(Object.hasOwn(parsed.value.context ?? {}, "queryText")).toBe(true);
  expect(parsed.value.context?.queryText).toBeUndefined();
}

function installChangingSessionGetters(
  input: Record<string, unknown>,
  payloadKey: "document" | "target",
  body: unknown,
  reads: string[],
): void {
  let sessions = 0;
  Object.defineProperty(input, "root", {
    get(): string {
      reads.push("root");
      return "/repo";
    },
  });
  Object.defineProperty(input, payloadKey, {
    get(): unknown {
      reads.push(payloadKey);
      return body;
    },
  });
  const inherited = {};
  Object.defineProperty(inherited, "editorSessionId", {
    get(this: object): string {
      expect(this).toBe(input);
      sessions += 1;
      reads.push(`session:${sessions.toString()}`);
      return sessions === 3 ? "captured-session" : "checked-session";
    },
  });
  Object.setPrototypeOf(input, inherited);
}

function identityFaultReads(
  fault: "root-second" | "session-third",
  payloadKey: "document" | "target",
): readonly string[] {
  return fault === "root-second"
    ? ["root:1", "session:1", payloadKey, "root:2"]
    : ["root:1", "session:1", payloadKey, "root:2", "session:2", "session:3"];
}

/** Declares the captured-identity and context-projection suites over each parser surface. */
export function describeRequestParserSurfaces<Value extends RequestValue>(
  surfaces: Surfaces<Value>,
  makeRequest: () => Record<string, unknown>,
  payloadKey: Extract<keyof Value, "document" | "target">,
): void {
  describe.each(surfaces)("#3918 captured request identity through %s", (_surface, parse) => {
    registerCapturedRequestIdentity(parse, makeRequest, payloadKey);
  });
  describe.each(surfaces)("%s parser admission and context projection", (_surface, parse): void => {
    registerRequestContextProjection(parse, makeRequest, payloadKey);
  });
}
