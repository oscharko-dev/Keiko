import { describe, expect, expectTypeOf, it } from "vitest";
import {
  validateRuntimeCapabilitiesResponse,
  type RuntimeCapabilitiesParse,
} from "@oscharko-dev/keiko-contracts/runtime/runtime-capabilities";

import {
  RUNTIME_CAPABILITY_SCHEMA_VERSION,
  RUNTIME_CAPABILITY_STATES,
  validateRuntimeCapabilitiesResponse as validateSourceRuntimeCapabilitiesResponse,
  type RuntimeCapabilitiesResponse,
} from "./runtime-capabilities.js";
import { WORKSPACE_PORTABLE_PATH_MAX_BYTES } from "./workspace-contract-primitives.js";

export function consumeRuntimeCapabilities(input: unknown): RuntimeCapabilitiesParse {
  const result = validateRuntimeCapabilitiesResponse(input);
  return result;
}

describe("runtime capability contracts", () => {
  it("validates a serializable content-free response", () => {
    const response: RuntimeCapabilitiesResponse = {
      schemaVersion: RUNTIME_CAPABILITY_SCHEMA_VERSION,
      generatedAtMs: 1_234,
      deadlineMs: 250,
      capabilities: [
        {
          id: "git",
          kind: "git",
          label: "Git",
          state: "available",
        },
        {
          id: "docker",
          kind: "container-engine",
          label: "Docker",
          state: "policy-blocked",
          unavailableReason: "unsafe-path",
          remediationHint: "Install Docker or make docker available on PATH.",
        },
        {
          id: "command-source:package.json:test",
          kind: "command-source",
          label: "Test command source",
          state: "available",
          source: {
            type: "package-json-script",
            path: "package.json",
            commandKind: "test",
            scriptName: "test",
            packageManager: "npm",
          },
        },
      ],
    };

    expect(validateSourceRuntimeCapabilitiesResponse(response)).toEqual({
      ok: true,
      value: response,
    });
    expect(JSON.stringify(response)).not.toContain("/repo");
  });

  // KEIKO-0239: source.path was validated as a non-empty string only, so an absolute path — which
  // would reveal the operator's home directory, repository location, or container layout in a
  // UI-facing, evidence-adjacent response — was accepted. The one test that claimed to prove
  // "content-free" output asserted `not.toContain("/repo")` against a hand-written "package.json"
  // literal, so it could never have failed.
  it.each([
    ["a POSIX absolute path", "/Users/alice/repo/package.json"],
    ["a Windows drive path", "C:\\repo\\package.json"],
    ["a UNC path", "\\\\host\\share\\package.json"],
    ["a backslash separator", "sub\\package.json"],
    ["a traversal segment", "../../etc/package.json"],
    // KEIKO-0239-follow-on: this validator had drifted into a second, looser copy of
    // isPortableWorkspaceRelativePath (workspace-contract-primitives.ts) — it checked "." and
    // ".." segments but not an EMPTY segment (a bare double slash), did not reject a
    // tilde-prefixed home-relative path, and had no length bound at all.
    ["a double-slash producing an empty segment", "foo//bar/package.json"],
    ["a tilde-prefixed home-relative path", "~/secrets/package.json"],
    [
      "a path over the portable byte bound",
      `${"a".repeat(WORKSPACE_PORTABLE_PATH_MAX_BYTES)}/package.json`,
    ],
    ["a NUL byte", "package.json\u0000"],
  ])("rejects a command source whose path is %s", (_label, path) => {
    const response: RuntimeCapabilitiesResponse = {
      schemaVersion: RUNTIME_CAPABILITY_SCHEMA_VERSION,
      generatedAtMs: 1_234,
      deadlineMs: 250,
      capabilities: [
        {
          id: "command-source:package.json:test",
          kind: "command-source",
          label: "Test command source",
          state: "available",
          source: { type: "package-json-script", path, commandKind: "test" },
        },
      ],
    };
    expect(validateSourceRuntimeCapabilitiesResponse(response).ok).toBe(false);
    expect(consumeRuntimeCapabilities(response).ok).toBe(false);
  });

  it("rejects malformed capability states and source shapes without throwing", () => {
    const result = validateSourceRuntimeCapabilitiesResponse({
      schemaVersion: "1",
      generatedAtMs: 0,
      deadlineMs: 250,
      capabilities: [
        {
          id: "x",
          kind: "git",
          label: "Git",
          state: "blocked",
          source: { type: "package-json-script", path: "", commandKind: "deploy" },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("capabilities[0].state is invalid");
      expect(result.errors).toContain("capabilities[0].source.path must be a non-empty string");
      expect(result.errors).toContain("capabilities[0].source.commandKind is invalid");
    }
  });

  it("pins the required state vocabulary for degraded host tools", () => {
    expect(RUNTIME_CAPABILITY_STATES).toEqual([
      "available",
      "missing",
      "unsupported",
      "permission-denied",
      "not-running",
      "policy-blocked",
    ]);
  });
});

function healthyResponse(): RuntimeCapabilitiesResponse {
  return {
    schemaVersion: "1",
    generatedAtMs: 0,
    deadlineMs: 1,
    capabilities: [{ id: "git", label: "Git", kind: "git", state: "available" }],
  };
}

describe("shipped runtime capability parser", () => {
  it("accepts a healthy dense public response with the original references", () => {
    const response = healthyResponse();
    const result = consumeRuntimeCapabilities(response);
    expect(result).toEqual({ ok: true, value: response });
    if (result.ok) {
      expect(result.value).toBe(response);
      expect(result.value.capabilities).toBe(response.capabilities);
      expect(result.value.capabilities[0]).toBe(response.capabilities[0]);
    }
  });

  it("rejects a sparse public capabilities array", () => {
    const response = { ...healthyResponse(), capabilities: new Array<unknown>(1) };
    expect(consumeRuntimeCapabilities(response)).toEqual({
      ok: false,
      errors: ["capabilities[0] must be an object"],
    });
  });
});

function responseWithSource(): RuntimeCapabilitiesResponse {
  return {
    ...healthyResponse(),
    capabilities: [
      {
        id: "test",
        label: "Test",
        kind: "command-source",
        state: "available",
        version: "",
        unavailableReason: "probe-failed",
        remediationHint: "",
        source: {
          type: "package-json-script",
          path: "package.json",
          commandKind: "test",
          scriptName: "",
          packageManager: "",
        },
      },
    ],
  };
}

function observeReads<T extends object>(value: T, label: string, reads: string[]): T {
  return new Proxy(value, {
    get(target, key, receiver): unknown {
      reads.push(`${label}.${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  });
}

function pinPublicPrimitiveTypes(result: RuntimeCapabilitiesParse): void {
  expectTypeOf(result.ok).toEqualTypeOf<boolean>();
  if (!result.ok) {
    expectTypeOf(result.errors).toEqualTypeOf<readonly string[]>();
    return;
  }
  expectTypeOf(result.value.schemaVersion).toEqualTypeOf<"1">();
  expectTypeOf(result.value.generatedAtMs).toEqualTypeOf<number>();
  expectTypeOf(result.value.deadlineMs).toEqualTypeOf<number>();
  const capability = result.value.capabilities[0];
  if (!capability) throw new TypeError("healthy control needs a capability");
  expectTypeOf(capability.id).toEqualTypeOf<string>();
  expectTypeOf(capability.label).toEqualTypeOf<string>();
  expectTypeOf(capability.version).toEqualTypeOf<string | undefined>();
  expectTypeOf(capability.remediationHint).toEqualTypeOf<string | undefined>();
  expectTypeOf(capability.kind).toEqualTypeOf<
    | "git"
    | "node"
    | "package-manager"
    | "language-toolchain"
    | "container-engine"
    | "command-source"
  >();
  expectTypeOf(capability.state).toEqualTypeOf<
    "available" | "missing" | "unsupported" | "permission-denied" | "not-running" | "policy-blocked"
  >();
  expectTypeOf(capability.unavailableReason).toEqualTypeOf<
    | "executable-not-found"
    | "executable-not-runnable"
    | "unsupported-version"
    | "daemon-not-running"
    | "policy-blocked"
    | "unsafe-path"
    | "manifest-not-found"
    | "script-not-defined"
    | "probe-timed-out"
    | "probe-failed"
    | undefined
  >();
  const source = capability.source;
  if (!source) throw new TypeError("healthy control needs a source");
  expectTypeOf(source.type).toEqualTypeOf<
    "package-json-script" | "ecosystem-manifest" | "lockfile"
  >();
  expectTypeOf(source.path).toEqualTypeOf<string>();
  expectTypeOf(source.scriptName).toEqualTypeOf<string | undefined>();
  expectTypeOf(source.packageManager).toEqualTypeOf<string | undefined>();
  expectTypeOf(source.commandKind).toEqualTypeOf<
    "test" | "build" | "lint" | "typecheck" | undefined
  >();
}

describe.each([
  ["source", validateSourceRuntimeCapabilitiesResponse],
  ["public", consumeRuntimeCapabilities],
])("%s runtime capability boundary preservation", (_owner, parse) => {
  it("accepts empty arrays and safe integer bounds", () => {
    const response = {
      ...healthyResponse(),
      generatedAtMs: Number.MAX_SAFE_INTEGER,
      deadlineMs: Number.MAX_SAFE_INTEGER,
      capabilities: [],
    };
    expect(parse(response)).toEqual({ ok: true, value: response });
  });

  it.each([null, [], 1, "source"])("rejects a non-record nested source %s", (source) => {
    const response = {
      ...healthyResponse(),
      capabilities: [{ id: "git", label: "Git", kind: "git", state: "available", source }],
    };
    expect(parse(response)).toEqual({
      ok: false,
      errors: ["capabilities[0].source must be an object"],
    });
  });

  it("pins public primitive and vocabulary declarations independently", () => {
    pinPublicPrimitiveTypes(parse(responseWithSource()));
    pinPublicPrimitiveTypes(parse(null));
  });

  it("retains eager exact diagnostics across scalar, entry and nested failures", () => {
    const response = {
      schemaVersion: 1,
      generatedAtMs: -1,
      deadlineMs: 0,
      capabilities: [
        {
          id: "",
          label: null,
          kind: "bad",
          state: "bad",
          version: 1,
          unavailableReason: "bad",
          remediationHint: 1,
          source: { type: "bad", path: "", commandKind: "bad", scriptName: 1, packageManager: 1 },
        },
        null,
      ],
    };
    expect(parse(response)).toEqual({
      ok: false,
      errors: [
        "schemaVersion is invalid",
        "generatedAtMs must be a non-negative safe integer",
        "deadlineMs must be a positive safe integer",
        "id must be a non-empty string",
        "label must be a non-empty string",
        "capabilities[0].kind is invalid",
        "capabilities[0].state is invalid",
        "capabilities[0].version must be a string",
        "capabilities[0].unavailableReason is invalid",
        "capabilities[0].remediationHint must be a string",
        "capabilities[0].source.type is invalid",
        "capabilities[0].source.path must be a non-empty string",
        "capabilities[0].source.path must be workspace-relative",
        "capabilities[0].source.commandKind is invalid",
        "capabilities[0].source.scriptName must be a string",
        "capabilities[0].source.packageManager must be a string",
        "capabilities[1] must be an object",
      ],
    });
  });

  it.each([null, [], 1, "response", undefined])("rejects a non-record response %s", (input) => {
    expect(parse(input)).toEqual({
      ok: false,
      errors: ["response must be an object"],
    });
  });

  it.each([null, {}, "array", undefined])(
    "rejects a non-array capability field %s",
    (capabilities) => {
      expect(parse({ ...healthyResponse(), capabilities })).toEqual({
        ok: false,
        errors: ["capabilities must be an array"],
      });
    },
  );

  it.each([NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])(
    "rejects unsafe numeric scalars %s",
    (number) => {
      expect(
        parse({
          ...healthyResponse(),
          generatedAtMs: number,
          deadlineMs: number,
        }),
      ).toEqual({
        ok: false,
        errors: [
          "generatedAtMs must be a non-negative safe integer",
          "deadlineMs must be a positive safe integer",
        ],
      });
    },
  );

  it("preserves omitted, own undefined and extra properties without rebuilding nested values", () => {
    const source = {
      type: "lockfile",
      path: "package-lock.json",
      commandKind: undefined,
      scriptName: undefined,
      packageManager: undefined,
      extra: "retained",
    };
    const capability = {
      id: "lock",
      label: "Lock",
      kind: "command-source",
      state: "available",
      version: undefined,
      unavailableReason: undefined,
      remediationHint: undefined,
      source,
      extra: 1,
    };
    const response = { ...healthyResponse(), capabilities: [capability], extra: true };
    const result = parse(response);
    expect(result).toEqual({ ok: true, value: response });
    if (!result.ok) throw new TypeError("healthy optional control refused");
    expect(result.value).toBe(response);
    expect(result.value.capabilities[0]).toBe(capability);
    expect(result.value.capabilities[0]?.source).toBe(source);
    expect(Object.hasOwn(capability, "version")).toBe(true);
    expect(Object.hasOwn(source, "scriptName")).toBe(true);
    const omitted = healthyResponse();
    expect(parse(omitted)).toEqual({ ok: true, value: omitted });
    expect(Object.hasOwn(omitted.capabilities[0] ?? {}, "version")).toBe(false);
  });

  it("revalidates nested mutation rather than treating prior success as write authority", () => {
    const source = { type: "lockfile", path: "package-lock.json" };
    const response = {
      ...healthyResponse(),
      capabilities: [
        { id: "lock", label: "Lock", kind: "command-source", state: "available", source },
      ],
    };
    expect(parse(response).ok).toBe(true);
    source.path = "../secret";
    expect(parse(response)).toEqual({
      ok: false,
      errors: ["capabilities[0].source.path must be workspace-relative"],
    });
  });

  it("accepts inherited array entries through indexed getters", () => {
    const entries = new Array<unknown>(1);
    let reads = 0;
    const entry = healthyResponse().capabilities[0];
    const prototype = {
      get 0(): unknown {
        reads++;
        return entry;
      },
    };
    Object.setPrototypeOf(prototype, Array.prototype);
    Object.setPrototypeOf(entries, prototype);
    const response = { ...healthyResponse(), capabilities: entries };
    expect(parse(response)).toEqual({ ok: true, value: response });
    expect(reads).toBe(1);
    expect(Object.hasOwn(entries, "0")).toBe(false);
  });

  it.each(["no-op", "throw"])(
    "does not delegate entry checks to caller %s methods or iterators",
    (behavior) => {
      const entries = [null];
      Object.defineProperty(entries, "forEach", {
        value(): void {
          if (behavior === "throw") throw new Error("caller traversal");
        },
      });
      Object.defineProperty(entries, Symbol.iterator, {
        value(): void {
          throw new Error("caller iterator");
        },
      });
      expect(parse({ ...healthyResponse(), capabilities: entries })).toEqual({
        ok: false,
        errors: ["capabilities[0] must be an object"],
      });
    },
  );

  it("captures array extent before an index getter grows it", () => {
    const entries: unknown[] = [healthyResponse().capabilities[0]];
    let reads = 0;
    const entry = entries[0];
    Object.defineProperty(entries, "0", {
      get(): unknown {
        reads++;
        entries.push(null);
        return entry;
      },
    });
    const response = { ...healthyResponse(), capabilities: entries };
    expect(parse(response).ok).toBe(true);
    expect(reads).toBe(1);
    expect(entries).toHaveLength(2);
  });

  it("rejects an entry deleted during the captured traversal", () => {
    const entries: unknown[] = [
      healthyResponse().capabilities[0],
      healthyResponse().capabilities[0],
    ];
    const entry = entries[0];
    Object.defineProperty(entries, "0", {
      get(): unknown {
        Reflect.deleteProperty(entries, "1");
        return entry;
      },
    });
    expect(parse({ ...healthyResponse(), capabilities: entries })).toEqual({
      ok: false,
      errors: ["capabilities[1] must be an object"],
    });
  });

  it("does not let a proxy has trap hide a required position", () => {
    const entries = new Proxy([null], {
      has(): boolean {
        return false;
      },
    });
    expect(parse({ ...healthyResponse(), capabilities: entries })).toEqual({
      ok: false,
      errors: ["capabilities[0] must be an object"],
    });
  });

  it("rejects capabilities that become non-array on the second getter read", () => {
    let reads = 0;
    const input = {
      ...healthyResponse(),
      get capabilities(): unknown {
        reads++;
        return reads === 1 ? [] : undefined;
      },
    };
    expect(parse(input)).toEqual({
      ok: false,
      errors: ["capabilities must be an array"],
    });
    expect(reads).toBe(2);
  });

  it("retains field observation order without a second getter validation pass", () => {
    const reads: string[] = [];
    const response = responseWithSource();
    const capability = response.capabilities[0];
    if (!capability?.source) throw new TypeError("healthy control needs source");
    const source = observeReads(capability.source, "source", reads);
    const entry = observeReads({ ...capability, source }, "entry", reads);
    const entries = observeReads([entry], "array", reads);
    const input = observeReads({ ...response, capabilities: entries }, "response", reads);
    expect(parse(input).ok).toBe(true);
    expect(reads).toEqual([
      "response.schemaVersion",
      "response.generatedAtMs",
      "response.deadlineMs",
      "response.capabilities",
      "response.capabilities",
      "array.length",
      "array.0",
      "entry.id",
      "entry.label",
      "entry.kind",
      "entry.state",
      "entry.version",
      "entry.version",
      "entry.unavailableReason",
      "entry.unavailableReason",
      "entry.remediationHint",
      "entry.remediationHint",
      "entry.source",
      "entry.source",
      "source.type",
      "source.path",
      "source.path",
      "source.path",
      "source.commandKind",
      "source.commandKind",
      "source.scriptName",
      "source.scriptName",
      "source.packageManager",
      "source.packageManager",
    ]);
  });

  it("propagates thrown getters and proxies instead of swallowing observation failures", () => {
    const error = new Error("observation refused");
    const input = new Proxy(healthyResponse(), {
      get(): never {
        throw error;
      },
    });
    expect(() => parse(input)).toThrow(error);
    const source = {
      type: "lockfile",
      get path(): never {
        throw error;
      },
    };
    const response = {
      ...healthyResponse(),
      capabilities: [
        { id: "lock", label: "Lock", kind: "command-source", state: "available", source },
      ],
    };
    expect(() => parse(response)).toThrow(error);
  });
});
