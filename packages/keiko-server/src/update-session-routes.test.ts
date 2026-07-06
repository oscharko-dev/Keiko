import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UPDATE_SESSION_SCHEMA_VERSION,
  type UpdateRemediationActionRequest,
  type UpdateRemediationStatusReport,
  type UpdateInstallMode,
  type UpdateSession,
  type UpdateSessionStartRequest,
  type UpdateSessionStatus,
} from "@oscharko-dev/keiko-contracts";
import { buildCspHeader } from "./csp.js";
import { buildRedactor, createInMemoryUiStore, type UiHandlerDeps } from "./index.js";
import { createRunRegistry } from "./runs.js";
import { createUiServer, UI_HOST } from "./server.js";
import {
  UpdateSessionError,
  type UpdateSessionManager,
  type UpdateSessionStartOutcome,
} from "./update-session.js";
import type { UpdateRemediationManager } from "./update-remediation.js";

const installMode: UpdateInstallMode = {
  schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
  status: "supported",
  packageName: "@oscharko-dev/keiko",
  packageManager: "npm",
  installRoot: "/usr/local/lib/node_modules/@oscharko-dev/keiko",
  commandPreview: {
    executable: "npm",
    args: ["install", "--global", "--ignore-scripts", "@oscharko-dev/keiko@<target-version>"],
    label: "npm install --global --ignore-scripts @oscharko-dev/keiko@<target-version>",
  },
};

function session(
  targetVersion = "0.2.12",
  phase: UpdateSession["phase"] = "preparing",
): UpdateSession {
  return {
    schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
    sessionId: "session-1",
    packageName: "@oscharko-dev/keiko",
    targetVersion,
    phase,
    failureReason: "none",
    packageManager: "npm",
    installRoot: "/usr/local/lib/node_modules/@oscharko-dev/keiko",
    commandPreview: {
      executable: "npm",
      args: ["install", "--global", "--ignore-scripts", `@oscharko-dev/keiko@${targetVersion}`],
      label: `npm install --global --ignore-scripts @oscharko-dev/keiko@${targetVersion}`,
    },
    startedAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    cancelable: phase === "preparing",
    retryable: false,
    restartRequired: phase === "restart-required",
    message: "test session",
  };
}

class FakeUpdateSessionManager implements UpdateSessionManager {
  public readonly starts: UpdateSessionStartRequest[] = [];
  public retryError: UpdateSessionError | undefined;
  public cancelError: UpdateSessionError | undefined;
  public verifyError: UpdateSessionError | undefined;

  public readonly getStatus = (): UpdateSessionStatus => ({
    schemaVersion: UPDATE_SESSION_SCHEMA_VERSION,
    installMode,
    policy: { enabled: true, source: "default" },
  });

  public readonly start = (input: UpdateSessionStartRequest): UpdateSessionStartOutcome => {
    this.starts.push(input);
    return { session: session(input.targetVersion), reused: false };
  };

  public readonly retry = (): UpdateSessionStartOutcome => {
    if (this.retryError !== undefined) throw this.retryError;
    return {
      session: session("0.2.12"),
      reused: false,
    };
  };

  public readonly cancel = (): UpdateSession => {
    if (this.cancelError !== undefined) throw this.cancelError;
    return session("0.2.12", "cancelled");
  };

  public readonly verifyRestart = (
    targetVersion?: string,
    canCompleteUpdate?: (session: UpdateSession) => boolean,
  ): UpdateSession => {
    if (this.verifyError !== undefined) throw this.verifyError;
    const verified = session(targetVersion ?? "0.2.12", "restart-required");
    return canCompleteUpdate?.(verified) === false
      ? { ...verified, restartRequired: false }
      : session(verified.targetVersion, "succeeded");
  };
}

class FakeUpdateRemediationManager implements UpdateRemediationManager {
  public readonly completedRestarts: string[] = [];

  public constructor(private readonly report: UpdateRemediationStatusReport) {}

  public readonly getStatus = (): UpdateRemediationStatusReport => this.report;

  public readonly runAction = (
    _request: UpdateRemediationActionRequest,
  ): Promise<UpdateRemediationStatusReport> => Promise.resolve(this.report);

  public readonly completeRestart = (targetVersion?: string): UpdateRemediationStatusReport => {
    this.completedRestarts.push(targetVersion ?? "");
    return this.report;
  };

  public readonly updateCanComplete = (): boolean => this.report.updateCanComplete;
}

function remediationReport(
  updateCanComplete: boolean,
  overallStatus: UpdateRemediationStatusReport["overallStatus"] = updateCanComplete
    ? "completed"
    : "pending",
): UpdateRemediationStatusReport {
  return {
    schemaVersion: 1,
    checkedAt: "2026-06-30T00:00:00.000Z",
    overallStatus,
    updateCanComplete,
    actions: [],
    affectedFeatures: [],
    warnings: [],
  };
}

let server: Server;
let staticRoot: string;
let port: number;
let updateSession: FakeUpdateSessionManager;

async function listen(srv: Server): Promise<number> {
  await new Promise<void>((resolve) => srv.listen(0, UI_HOST, resolve));
  return (srv.address() as AddressInfo).port;
}

async function closeServer(srv: Server = server): Promise<void> {
  await new Promise<void>((resolve) => {
    srv.close(() => {
      resolve();
    });
  });
}

function baseDeps(): UiHandlerDeps {
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: {
      put: (): string => "",
      list: (): readonly string[] => [],
      get: (): string | undefined => undefined,
      delete: (): void => undefined,
    },
    env: {},
    redactor: buildRedactor({}),
    registry: createRunRegistry(),
    modelPortFactory: (): undefined => undefined,
    store: createInMemoryUiStore(),
    updateSession,
  };
}

async function buildServer(handlerDeps: UiHandlerDeps): Promise<{ server: Server; port: number }> {
  const probe = createUiServer({ staticRoot, csp: buildCspHeader([]), port: 0, handlerDeps });
  const chosenPort = await listen(probe);
  await closeServer(probe);
  const next = createUiServer({
    staticRoot,
    csp: buildCspHeader([]),
    port: chosenPort,
    handlerDeps,
  });
  await new Promise<void>((resolve) => next.listen(chosenPort, UI_HOST, resolve));
  return { server: next, port: chosenPort };
}

async function rebuild(override: Partial<UiHandlerDeps> = {}): Promise<void> {
  await closeServer();
  const built = await buildServer({ ...baseDeps(), ...override });
  server = built.server;
  port = built.port;
}

function baseUrl(): string {
  return `http://${UI_HOST}:${String(port)}`;
}

function csrfHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "X-Keiko-CSRF": "1" };
}

beforeEach(async () => {
  staticRoot = await mkdtemp(join(tmpdir(), "keiko-update-session-routes-"));
  updateSession = new FakeUpdateSessionManager();
  const built = await buildServer(baseDeps());
  server = built.server;
  port = built.port;
});

afterEach(async () => {
  await closeServer();
  await rm(staticRoot, { recursive: true, force: true });
});

describe("update session routes", () => {
  it("returns install mode and policy status", async () => {
    const res = await fetch(`${baseUrl()}/api/update/session`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as UpdateSessionStatus;
    expect(body.installMode.status).toBe("supported");
    expect(body.policy.enabled).toBe(true);
  });

  it("returns 503 when the update session manager is not configured", async () => {
    await rebuild({ updateSession: undefined });

    const res = await fetch(`${baseUrl()}/api/update/session`);
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe("UPDATE_SESSION_UNAVAILABLE");
  });

  it("requires CSRF for state-changing update session routes", async () => {
    const res = await fetch(`${baseUrl()}/api/update/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: "0.2.12" }),
    });

    expect(res.status).toBe(403);
  });

  it("validates start request bodies and starts a session", async () => {
    const invalid = await fetch(`${baseUrl()}/api/update/session`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion: "0.2.12-beta.1" }),
    });
    const injected = await fetch(`${baseUrl()}/api/update/session`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion: "0.2.12;rm -rf /" }),
    });
    expect(invalid.status).toBe(400);
    expect(injected.status).toBe(400);

    const valid = await fetch(`${baseUrl()}/api/update/session`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion: "0.2.12", requestId: "req-1" }),
    });
    const body = (await valid.json()) as UpdateSession;

    expect(valid.status).toBe(202);
    expect(body.targetVersion).toBe("0.2.12");
    expect(updateSession.starts[0]).toEqual({ targetVersion: "0.2.12", requestId: "req-1" });
  });

  it("allows pending follow-up remediation when starting a session", async () => {
    await rebuild({
      updateRemediation: new FakeUpdateRemediationManager(remediationReport(false)),
    });

    const res = await fetch(`${baseUrl()}/api/update/session`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion: "0.2.12" }),
    });

    expect(res.status).toBe(202);
    expect(updateSession.starts).toEqual([{ targetVersion: "0.2.12" }]);
  });

  it("blocks session start while required remediation needs manual review", async () => {
    await rebuild({
      updateRemediation: new FakeUpdateRemediationManager(
        remediationReport(false, "manual-review-required"),
      ),
    });

    const res = await fetch(`${baseUrl()}/api/update/session`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion: "0.2.12" }),
    });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("UPDATE_REMEDIATION_REQUIRED");
    expect(updateSession.starts).toEqual([]);
  });

  it("rejects bad JSON and oversized update start bodies", async () => {
    const badJson = await fetch(`${baseUrl()}/api/update/session`, {
      method: "POST",
      headers: csrfHeaders(),
      body: "{",
    });
    const tooLarge = await fetch(`${baseUrl()}/api/update/session`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion: "0.2.12", padding: "x".repeat(20_000) }),
    });

    expect(badJson.status).toBe(400);
    expect(tooLarge.status).toBe(413);
  });

  it("supports retry, cancel, and restart verification routes", async () => {
    const retry = await fetch(`${baseUrl()}/api/update/session/retry`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({}),
    });
    const cancel = await fetch(`${baseUrl()}/api/update/session`, {
      method: "DELETE",
      headers: csrfHeaders(),
    });
    const verify = await fetch(`${baseUrl()}/api/update/session/verify-restart`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion: "0.2.12" }),
    });

    expect(retry.status).toBe(202);
    expect(cancel.status).toBe(200);
    expect(verify.status).toBe(200);
  });

  it("completes restart remediation before reporting restart verification success", async () => {
    const updateRemediation = new FakeUpdateRemediationManager(remediationReport(true));
    await rebuild({ updateRemediation });

    const res = await fetch(`${baseUrl()}/api/update/session/verify-restart`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion: "0.2.12" }),
    });
    const body = (await res.json()) as UpdateSession;

    expect(res.status).toBe(200);
    expect(body.phase).toBe("succeeded");
    expect(updateRemediation.completedRestarts).toEqual(["0.2.12"]);
  });

  it("keeps restart verification non-terminal while follow-up remediation remains", async () => {
    await rebuild({
      updateRemediation: new FakeUpdateRemediationManager(remediationReport(false)),
    });

    const res = await fetch(`${baseUrl()}/api/update/session/verify-restart`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion: "0.2.12" }),
    });
    const body = (await res.json()) as UpdateSession;

    expect(res.status).toBe(200);
    expect(body.phase).toBe("restart-required");
    expect(body.restartRequired).toBe(false);
  });

  it("maps retry, cancel, and restart verification manager errors", async () => {
    updateSession.retryError = new UpdateSessionError(
      "UPDATE_RETRY_UNAVAILABLE",
      "No retryable update session exists.",
      409,
    );
    updateSession.cancelError = new UpdateSessionError(
      "UPDATE_SESSION_NOT_FOUND",
      "No update session is active.",
      404,
    );
    updateSession.verifyError = new UpdateSessionError(
      "UPDATE_RESTART_NOT_PENDING",
      "No restart verification is pending.",
      409,
    );

    const retry = await fetch(`${baseUrl()}/api/update/session/retry`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({}),
    });
    const cancel = await fetch(`${baseUrl()}/api/update/session`, {
      method: "DELETE",
      headers: csrfHeaders(),
    });
    const verify = await fetch(`${baseUrl()}/api/update/session/verify-restart`, {
      method: "POST",
      headers: csrfHeaders(),
      body: JSON.stringify({ targetVersion: "0.2.12" }),
    });

    expect(retry.status).toBe(409);
    expect(cancel.status).toBe(404);
    expect(verify.status).toBe(409);
  });
});
