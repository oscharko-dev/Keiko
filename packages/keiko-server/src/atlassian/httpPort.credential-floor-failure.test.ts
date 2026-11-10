import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AtlassianHttpBodyPort,
  AtlassianHttpBodyRequest,
} from "@oscharko-dev/keiko-connectors";
import type * as Security from "@oscharko-dev/keiko-security";
import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import { defaultServerDiagnosticSink } from "../diagnostics-log.js";
import { createGatewayAtlassianHttpBodyPort } from "./httpPort.js";

const injected = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock("@oscharko-dev/keiko-security", async (original) => {
  const security = await original<typeof Security>();
  return {
    ...security,
    createSecretSpellingStreamRedactor: (
      ...args: Parameters<typeof security.createSecretSpellingStreamRedactor>
    ): Security.SecretSpellingStreamRedactor => {
      if (injected.error !== undefined) throw injected.error;
      return security.createSecretSpellingStreamRedactor(...args);
    },
  };
});
afterEach(() => {
  injected.error = undefined;
  vi.restoreAllMocks();
});

function fixture(apiToken = "synthetic-credential-floor"): {
  readonly log: ReturnType<typeof createBufferedServerLogSink>;
  readonly fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  readonly onResponse: ReturnType<typeof vi.fn<() => boolean>>;
  readonly http: AtlassianHttpBodyPort;
  readonly request: AtlassianHttpBodyRequest;
} {
  const log = createBufferedServerLogSink();
  const fetchImpl = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response('{"total":1}', { status: 200 })),
  );
  const onResponse = vi.fn(() => true);
  const http = createGatewayAtlassianHttpBodyPort({
    baseUrl: "https://jira.example.invalid",
    authRef: "synthetic-ref",
    credentials: { resolveForExecution: () => ({ scheme: "bearer-pat", apiToken }) },
    activityLog: log,
    correlationId: "credential-floor-error-proof",
    fetchImpl,
    onResponse,
    singleAttempt: true,
  });
  const request = {
    method: "GET" as const,
    url: "https://jira.example.invalid/rest/api/2/search",
    maxBodyBytes: 4096,
    timeoutMs: 1000,
  };
  return { log, fetchImpl, onResponse, http, request };
}

describe("credential floor error discrimination", () => {
  it("withholds an unsupported secret through its specific redactor exception", async () => {
    const diagnostic = vi
      .spyOn(defaultServerDiagnosticSink, "record")
      .mockImplementation(() => undefined);
    const f = fixture("caf\u00e9-credential");
    expect(await f.http(f.request)).toMatchObject({
      kind: "response",
      status: 200,
      bodyText: "",
      truncated: true,
    });
    expect(
      f.log.events.find((event) => event.op === "atlassian.http.credential-reflection")?.extra
        ?.reason,
    ).toBe("unsupported-secret");
    expect(diagnostic).not.toHaveBeenCalled();
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.onResponse).toHaveBeenCalledOnce();
  });

  it.each(["TypeError", "RangeError", "Error"])(
    "fails closed with frames and causeChain for an unrelated %s",
    async (kind) => {
      const cause = new RangeError("private-cause-body");
      const error =
        kind === "TypeError"
          ? new TypeError("private-bug-body", { cause })
          : kind === "RangeError"
            ? new RangeError("private-bug-body", { cause })
            : new Error("private-bug-body", { cause });
      injected.error = error;
      const diagnostic = vi
        .spyOn(defaultServerDiagnosticSink, "record")
        .mockImplementation(() => undefined);
      const f = fixture();
      expect(await f.http(f.request)).toEqual({ kind: "network-error" });
      expect(f.log.events.some((event) => event.extra?.reason === "unsupported-secret")).toBe(
        false,
      );
      expect(diagnostic).toHaveBeenCalledOnce();
      const record = diagnostic.mock.calls[0]?.[0];
      expect(record).toMatchObject({
        correlationId: "credential-floor-error-proof",
        operation: "atlassian.http.credential-reflection",
        source: "atlassian-http-credential-floor",
        errorClass: kind,
      });
      expect(
        record?.frames?.some((frame) =>
          frame.includes("httpPort.credential-floor-failure.test.ts"),
        ),
      ).toBe(true);
      expect(record?.causeChain).toContain("RangeError");
      expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
        /private-bug-body|private-cause-body|jira\.example|synthetic-credential/,
      );
      expect(f.fetchImpl).toHaveBeenCalledOnce();
      expect(f.onResponse).toHaveBeenCalledOnce();
    },
  );
});
