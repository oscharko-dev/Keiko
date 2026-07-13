import { describe, expect, it } from "vitest";

import type { LanguageServiceOperation } from "./language-service.js";
import {
  DEFAULT_LSP_PROCESS_CONFIG,
  LSP_PROCESS_ERROR_CODES,
  LSP_PROCESS_SCHEMA_VERSION,
  LSP_PROCESS_STATUSES,
  type LspProcessStatus,
  isTerminalLspStatus,
  lspStatusToProviderDescriptor,
  parseLspFrameHeader,
} from "./lsp-process.js";

const ALL_STATUSES: readonly LspProcessStatus[] = [
  "STARTING",
  "INITIALIZING",
  "READY",
  "CRASHED",
  "RESTART_THROTTLED",
  "INITIALIZE_TIMEOUT",
  "SHUTDOWN",
  "DISPOSED",
  "EXECUTABLE_NOT_FOUND",
  "SPAWN_FAILED",
];

const TERMINAL_STATUSES: ReadonlySet<LspProcessStatus> = new Set<LspProcessStatus>([
  "DISPOSED",
  "EXECUTABLE_NOT_FOUND",
  "SPAWN_FAILED",
  "RESTART_THROTTLED",
]);

const LANGUAGES: readonly string[] = ["python"];
const OPERATIONS: readonly LanguageServiceOperation[] = ["diagnostics", "hover"];

describe("schema + frozen tables", () => {
  it("pins the schema version literal", () => {
    expect(LSP_PROCESS_SCHEMA_VERSION).toBe("1");
  });

  it("freezes the error-code table and rejects mutation", () => {
    expect(Object.isFrozen(LSP_PROCESS_ERROR_CODES)).toBe(true);
    expect(() => {
      (LSP_PROCESS_ERROR_CODES as string[]).push("INVALID");
    }).toThrow();
  });

  it("freezes the status table and rejects mutation", () => {
    expect(Object.isFrozen(LSP_PROCESS_STATUSES)).toBe(true);
    expect(() => {
      (LSP_PROCESS_STATUSES as string[]).push("INVALID");
    }).toThrow();
  });

  it("exposes exactly the governed error codes", () => {
    expect([...LSP_PROCESS_ERROR_CODES]).toStrictEqual([
      "EXECUTABLE_NOT_FOUND",
      "SPAWN_FAILED",
      "INITIALIZE_FAILED",
      "INITIALIZE_TIMEOUT",
      "REQUEST_TIMED_OUT",
      "RESPONSE_TOO_LARGE",
      "RESOURCE_BUDGET_EXCEEDED",
      "RUNTIME_STATE_CLEANUP_FAILED",
      "CRASHED",
      "RESTART_THROTTLED",
      "SHUTDOWN_TIMEOUT",
      "CANCELLED",
      "DISPOSED",
    ]);
  });

  it("status table matches the enumerated statuses under test", () => {
    expect([...LSP_PROCESS_STATUSES]).toStrictEqual([...ALL_STATUSES]);
  });
});

describe("DEFAULT_LSP_PROCESS_CONFIG", () => {
  it("has the specified bounds and posture", () => {
    expect(DEFAULT_LSP_PROCESS_CONFIG).toStrictEqual({
      initializeTimeoutMs: 10_000,
      requestTimeoutMs: 2_000,
      shutdownTimeoutMs: 5_000,
      maxFrameBytes: 4_194_304,
      restartWindowMs: 60_000,
      maxRestartsInWindow: 5,
      envAllowlist: ["PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL"],
      networkPolicy: "inherit",
    });
  });

  it("is deeply frozen including the env allowlist", () => {
    expect(Object.isFrozen(DEFAULT_LSP_PROCESS_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LSP_PROCESS_CONFIG.envAllowlist)).toBe(true);
    expect(() => {
      (DEFAULT_LSP_PROCESS_CONFIG.envAllowlist as string[]).push("SECRET");
    }).toThrow();
  });
});

describe("isTerminalLspStatus", () => {
  it.each(ALL_STATUSES)("classifies %s exhaustively", (status) => {
    expect(isTerminalLspStatus(status)).toBe(TERMINAL_STATUSES.has(status));
  });

  it("is fail-closed (non-terminal) for an unknown status", () => {
    expect(isTerminalLspStatus("WAT" as LspProcessStatus)).toBe(false);
  });
});

describe("lspStatusToProviderDescriptor", () => {
  it("maps READY to an available descriptor with no reason", () => {
    const descriptor = lspStatusToProviderDescriptor("mgr-1", LANGUAGES, OPERATIONS, "READY");
    expect(descriptor).toStrictEqual({
      id: "mgr-1",
      languages: LANGUAGES,
      operations: OPERATIONS,
      availability: "available",
    });
    expect(descriptor.unavailableReason).toBeUndefined();
  });

  it.each(ALL_STATUSES.filter((status) => status !== "READY"))(
    "maps %s to unavailable with the status as content-free reason",
    (status) => {
      const descriptor = lspStatusToProviderDescriptor("mgr-1", LANGUAGES, OPERATIONS, status);
      expect(descriptor).toStrictEqual({
        id: "mgr-1",
        languages: LANGUAGES,
        operations: OPERATIONS,
        availability: "unavailable",
        unavailableReason: status,
      });
    },
  );

  it("passes through languages and operations references unchanged", () => {
    const descriptor = lspStatusToProviderDescriptor("mgr-2", LANGUAGES, OPERATIONS, "CRASHED");
    expect(descriptor.languages).toBe(LANGUAGES);
    expect(descriptor.operations).toBe(OPERATIONS);
  });

  it("is deterministic: same input yields an equal descriptor", () => {
    const first = lspStatusToProviderDescriptor("mgr-3", LANGUAGES, OPERATIONS, "INITIALIZING");
    const second = lspStatusToProviderDescriptor("mgr-3", LANGUAGES, OPERATIONS, "INITIALIZING");
    expect(first).toStrictEqual(second);
  });

  it("uses only the status enum name as the reason (no source text or paths)", () => {
    for (const status of ALL_STATUSES) {
      const descriptor = lspStatusToProviderDescriptor("mgr-4", LANGUAGES, OPERATIONS, status);
      if (descriptor.availability === "unavailable") {
        expect(descriptor.unavailableReason).toBe(status);
      }
    }
  });
});

describe("parseLspFrameHeader", () => {
  it("parses a canonical header", () => {
    expect(parseLspFrameHeader("Content-Length: 42")).toStrictEqual({ contentLength: 42 });
  });

  it("accepts a zero-length frame", () => {
    expect(parseLspFrameHeader("Content-Length: 0")).toStrictEqual({ contentLength: 0 });
  });

  it("is case-insensitive on the header name", () => {
    expect(parseLspFrameHeader("content-length: 7")).toStrictEqual({ contentLength: 7 });
  });

  it("tolerates a trailing carriage return and surrounding whitespace", () => {
    expect(parseLspFrameHeader("Content-Length:   15  \r")).toStrictEqual({ contentLength: 15 });
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["wrong header", "Content-Type: application/json"],
    ["missing value", "Content-Length:"],
    ["non-numeric value", "Content-Length: abc"],
    ["negative value", "Content-Length: -1"],
    ["fractional value", "Content-Length: 1.5"],
    ["hex value", "Content-Length: 0x10"],
    ["trailing junk", "Content-Length: 10 bytes"],
  ])("rejects %s as null", (_label, line) => {
    expect(parseLspFrameHeader(line)).toBeNull();
  });

  it("rejects a value beyond the safe-integer range", () => {
    expect(parseLspFrameHeader("Content-Length: 99999999999999999999")).toBeNull();
  });

  it("is deterministic for repeated parses", () => {
    expect(parseLspFrameHeader("Content-Length: 9")).toStrictEqual(
      parseLspFrameHeader("Content-Length: 9"),
    );
  });
});
