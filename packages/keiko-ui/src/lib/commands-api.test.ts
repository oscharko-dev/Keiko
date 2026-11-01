import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_RUNNER_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/command-runner";
import { cancelCommandRun, createCommandRun, fetchCommandCatalog } from "./commands-api";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";

const request = { projectId: "/fixture-private-project", taskId: "npm-script:test" };
const catalog = {
  schemaVersion: COMMAND_RUNNER_SCHEMA_VERSION,
  projectId: request.projectId,
  tasks: [],
};
const result = {
  schemaVersion: COMMAND_RUNNER_SCHEMA_VERSION,
  runId: "fixture-run",
  taskId: request.taskId,
  kind: "test",
  exitCode: 0,
  durationMs: 1,
  truncated: false,
  timedOut: false,
  failureReason: "none",
  stdout: "fixture-private-output",
  stderr: "",
};
const endpoints = [
  {
    name: "catalog",
    read: (): Promise<unknown> => fetchCommandCatalog(request.projectId),
    healthy: catalog,
  },
  { name: "run", read: (): Promise<unknown> => createCommandRun(request), healthy: result },
];

// Accessors exist only in this explicitly in-memory json() fixture, never in wire JSON.
function hostileJsonValue(): unknown {
  return Object.defineProperty({}, "schemaVersion", {
    get: (): never => {
      throw Object.defineProperty(new Error(), "name", { value: "fixture-private-error" });
    },
  });
}

function stubResponse(payload: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status,
    headers: new Headers({ "X-Keiko-Correlation-Id": "command-response-fixture" }),
    json: (): Promise<unknown> => Promise.resolve(payload),
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  resetClientDiagnosticWriter();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("actual command response admission (#3918)", () => {
  for (const endpoint of endpoints) {
    it(`${endpoint.name} preserves healthy identity without diagnostics`, async () => {
      const diagnostic = vi.fn();
      setClientDiagnosticWriter(diagnostic);
      const fetch = stubResponse(endpoint.healthy);
      await expect(endpoint.read()).resolves.toBe(endpoint.healthy);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(diagnostic).not.toHaveBeenCalled();
    });
    it(`${endpoint.name} retains request correlation when the network returns no response`, async () => {
      const diagnostic = vi.fn();
      setClientDiagnosticWriter(diagnostic);
      const failure = new TypeError("fixture-private-network");
      let requestCorrelation: string | undefined;
      const fetch = vi.fn((_path: RequestInfo | URL, init?: RequestInit): Promise<never> => {
        requestCorrelation = new Headers(init?.headers).get("X-Keiko-Correlation-Id") ?? undefined;
        return Promise.reject(failure);
      });
      vi.stubGlobal("fetch", fetch);
      await expect(endpoint.read()).rejects.toBe(failure);
      expect(requestCorrelation).toEqual(expect.any(String));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(diagnostic).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          kind: "other",
          correlationId: requestCorrelation,
          errorKind: "unavailable",
        }),
      );
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("fixture-private");
    });
    for (const shape of ["primitive", "null", "204", "hostile"]) {
      it(`${endpoint.name} rejects ${shape} with response correlation and no replay`, async () => {
        const diagnostic = vi.fn();
        setClientDiagnosticWriter(diagnostic);
        const payload =
          shape === "hostile"
            ? hostileJsonValue()
            : shape === "primitive"
              ? "fixture-private-body"
              : null;
        const fetch = stubResponse(payload, shape === "204" ? 204 : 200);
        await expect(endpoint.read()).rejects.toMatchObject({
          code: "CONTRACT_VALIDATION_FAILED",
          status: 502,
          correlationId: "command-response-fixture",
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(diagnostic).toHaveBeenCalledTimes(1);
        expect(diagnostic).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            kind: "other",
            correlationId: "command-response-fixture",
            errorKind: "validation-failed",
          }),
        );
        expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("fixture-private");
        if (endpoint.name === "run")
          expect(fetch).toHaveBeenCalledWith(
            "/api/commands/runs",
            expect.objectContaining({ method: "POST", body: JSON.stringify(request) }),
          );
      });
    }
  }
  it("retains HTTP refusal correlation and does not replay the run POST", async () => {
    setClientDiagnosticWriter(vi.fn());
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }), {
        status: 404,
        headers: { "X-Keiko-Correlation-Id": "command-http-refusal" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(createCommandRun(request)).rejects.toMatchObject({
      status: 404,
      correlationId: "command-http-refusal",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/commands/runs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Keiko-CSRF": "1" }),
      }),
    );
    const init: unknown = fetch.mock.calls[0]?.[1];
    expect(init).toMatchObject({ body: JSON.stringify(request) });
    if (
      typeof init !== "object" ||
      init === null ||
      !("headers" in init) ||
      typeof init.headers !== "object" ||
      init.headers === null ||
      !("X-Keiko-CSRF" in init.headers)
    )
      throw new TypeError("actual fetch headers required");
    expect(init.headers["X-Keiko-CSRF"]).toBe("1");
  });
  it("retains cancel DELETE and its healthy empty receipt", async () => {
    const fetch = stubResponse(undefined, 204);
    await expect(cancelCommandRun("run/one")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/commands/runs/run%2Fone",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
