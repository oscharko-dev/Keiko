import { describe, expect, it, vi } from "vitest";

import {
  auditEnvironment,
  isTransientAuditFailure,
  runAuditWithRetry,
  runNpmAudit,
} from "../run-npm-audit-with-retry.mjs";

const result = (status, output) => ({ output, status, stderr: output, stdout: "" });

describe("npm audit retry", () => {
  it.each([
    "npm warn audit 503 Service Unavailable",
    "npm error audit endpoint returned an error",
    "request failed with ECONNREFUSED",
    "request failed with ECONNRESET",
    "request failed with ENETUNREACH",
    "429 Too Many Requests",
  ])("recognizes a transient service failure: %s", (output) => {
    expect(isTransientAuditFailure(output)).toBe(true);
  });

  it("does not classify an advisory verdict as a transient service failure", () => {
    expect(isTransientAuditFailure("1 high severity vulnerability")).toBe(false);
  });

  it("retries a transient failure and preserves the eventual success", async () => {
    const runAudit = vi
      .fn()
      .mockReturnValueOnce(result(1, "503 Service Unavailable"))
      .mockReturnValueOnce(result(0, "found 0 vulnerabilities"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const status = await runAuditWithRetry(["--audit-level=high"], {
      runAudit,
      sleep,
      writeError: vi.fn(),
      writeOutput: vi.fn(),
    });

    expect(status).toBe(0);
    expect(runAudit).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(15_000);
  });

  it("redacts audit diagnostics without changing transient failure classification", async () => {
    const secret = "sk-test-audit-secret-1234567890";
    const runAudit = vi
      .fn()
      .mockReturnValueOnce({
        output: `503 Service Unavailable api_key=${secret}`,
        status: 1,
        stderr: `api_key=${secret}`,
        stdout: `503 Service Unavailable ${secret}`,
      })
      .mockReturnValueOnce(result(0, "found 0 vulnerabilities"));
    const writeError = vi.fn();
    const writeOutput = vi.fn();

    const status = await runAuditWithRetry(["--audit-level=high"], {
      runAudit,
      sleep: vi.fn().mockResolvedValue(undefined),
      writeError,
      writeOutput,
    });

    expect(status).toBe(0);
    expect(runAudit).toHaveBeenCalledTimes(2);
    const emitted = [...writeError.mock.calls, ...writeOutput.mock.calls].flat().join("\n");
    expect(emitted).not.toContain(secret);
    expect(emitted).toContain("[REDACTED]");
  });

  it("fails immediately for a genuine advisory verdict", async () => {
    const runAudit = vi.fn().mockReturnValue(result(1, "1 high severity vulnerability"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const status = await runAuditWithRetry(["--audit-level=high"], {
      runAudit,
      sleep,
      writeError: vi.fn(),
      writeOutput: vi.fn(),
    });

    expect(status).toBe(1);
    expect(runAudit).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails closed after the bounded retry budget is exhausted", async () => {
    const runAudit = vi.fn().mockReturnValue(result(1, "503 Service Unavailable"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const status = await runAuditWithRetry([], {
      runAudit,
      sleep,
      writeError: vi.fn(),
      writeOutput: vi.fn(),
    });

    expect(status).toBe(1);
    expect(runAudit).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[15_000], [30_000]]);
  });

  it("bounds npm's own network retries while forwarding audit arguments without a shell", () => {
    const spawn = vi.fn().mockReturnValue({ status: 0, stderr: "", stdout: "ok" });
    const environment = { KEIKO_TEST_MARKER: "present" };

    runNpmAudit(["--audit-level=moderate", "--omit=dev"], {
      cwd: "/workspace",
      environment,
      resolveNpm: () => "/trusted/npm",
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith(
      "/trusted/npm",
      ["audit", "--audit-level=moderate", "--omit=dev"],
      expect.objectContaining({
        cwd: "/workspace",
        env: expect.objectContaining({
          KEIKO_TEST_MARKER: "present",
          npm_config_fetch_retries: "1",
          npm_config_fetch_timeout: "60000",
        }),
      }),
    );
    expect(auditEnvironment(environment).npm_config_fetch_retry_maxtimeout).toBe("10000");
  });

  it("fails closed and reports a body-free diagnostic when npm is terminated by a signal", () => {
    const spawn = vi
      .fn()
      .mockReturnValue({ status: null, signal: "SIGKILL", stderr: "", stdout: "" });

    const audit = runNpmAudit([], { resolveNpm: () => "/trusted/npm", spawn });

    expect(audit.status).toBe(1);
    expect(audit.signal).toBe("SIGKILL");
    expect(audit.stderr).toBe("npm audit terminated by signal SIGKILL.\n");
    expect(audit.output).toBe(audit.stderr);
  });
});
