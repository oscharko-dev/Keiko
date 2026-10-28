import { expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labRequest } from "../testing/jira-chat-lab/lab-client.mjs";
import {
  createOwnedToken,
  delayedVerification,
  validateOwnedToken,
  validateServices,
  verifyInvalidation,
  withStoppedService,
  waitForLicensedRecovery,
} from "../testing/jira-chat-lab/verification.mjs";

function actions(group) {
  const order = [];
  const record = (name) =>
    vi.fn(async () => {
      order.push(name);
    });
  return {
    order,
    save: vi.fn(() => {
      order.push(group.phase);
    }),
    stop: record("stop"),
    start: record("start"),
    healthy: record("healthy"),
    preflight: record("preflight"),
    verify: record("verify"),
  };
}

it("restores the same stopped service and requalifies it even when the verification fails", async () => {
  const group = {};
  const a = actions(group);
  a.verify.mockRejectedValueOnce(new TypeError("Synthetic verification failure"));
  await expect(withStoppedService(group, a)).rejects.toThrow("Synthetic verification failure");
  expect(a.order).toEqual([
    "jira-stop-may-have-started",
    "stop",
    "jira-restart-required",
    "start",
    "healthy",
    "preflight",
    "jira-recovered",
  ]);
  expect(a.start).toHaveBeenCalledOnce();
});

it("still restarts and requalifies after a recovery-intent persistence failure", async () => {
  const group = {};
  const a = actions(group);
  a.save.mockImplementation(() => {
    if (group.phase === "jira-restart-required") throw new TypeError("Synthetic disk failure");
  });
  await expect(withStoppedService(group, a)).rejects.toThrow("Synthetic disk failure");
  expect(a.start).toHaveBeenCalledOnce();
  expect(a.healthy).toHaveBeenCalledOnce();
  expect(a.preflight).toHaveBeenCalledOnce();
});

it("does not claim recovery after restart failure", async () => {
  const group = {};
  const a = actions(group);
  a.start.mockRejectedValueOnce(new TypeError("Synthetic restart failure"));
  await expect(withStoppedService(group, a)).rejects.toThrow("Synthetic restart failure");
  expect(group.phase).toBe("jira-restart-required");
  expect(a.preflight).not.toHaveBeenCalled();
});

it.each([
  { id: 7, name: "owned", rawToken: "new" },
  { id: 8, name: "foreign", rawToken: "new" },
  { id: 8, name: "owned", rawToken: "shared-pat" },
  { id: 8, name: "owned", rawToken: " " },
  { id: "8", name: "owned", rawToken: "new" },
])("refuses a non-owned or unusable token before revocation: %j", (token) => {
  expect(() =>
    validateOwnedToken(token, { tokenName: "owned", priorTokenIds: [7] }, ["shared-pat"]),
  ).toThrow();
});

it("accepts only the uniquely created token outside the protected identities", () => {
  const token = { id: 8, name: "owned", rawToken: "new" };
  expect(
    validateOwnedToken(token, { tokenName: "owned", priorTokenIds: [7] }, ["shared-pat"]),
  ).toBe(token);
});

it("holds exactly one matching real success and forwards its bytes unchanged", async () => {
  const delay = delayedVerification();
  const original = { kind: "response", status: 200, bodyText: '{"name":"synthetic"}' };
  const factory = vi.fn(() => vi.fn(async () => original));
  delay.arm("owned");
  const request = { method: "GET", url: "https://jira.invalid/rest/api/2/myself" };
  expect(await delay.decorate(factory)({ authRef: "other" })(request)).toBe(original);
  const pending = delay.decorate(factory)({ authRef: "owned" })(request);
  await delay.ready;
  expect(delay.count()).toBe(1);
  expect(await delay.decorate(factory)({ authRef: "owned" })(request)).toBe(original);
  delay.release();
  expect(await pending).toBe(original);
});

it.each([401, 403, 503])("never holds a native failure %i as stale success", async (status) => {
  const delay = delayedVerification();
  delay.arm("owned");
  const original = { kind: "response", status, bodyText: "{}" };
  const port = delay.decorate(() => async () => original)({ authRef: "owned" });
  expect(await port({ method: "GET", url: "https://jira.invalid/rest/api/2/myself" })).toBe(
    original,
  );
  expect(delay.count()).toBe(0);
});

it("requires both generation advancement and failed readiness on the same Pod", () => {
  const before = {
    authRef: "owned",
    generation: 1,
    livePod: { podId: "pod", authenticationGeneration: 1, verificationStatus: "ok" },
  };
  const after = {
    authRef: "owned",
    generation: 2,
    livePod: { podId: "pod", authenticationGeneration: 2, verificationStatus: "auth-failed" },
  };
  verifyInvalidation(before, after, "auth-failed");
  expect(() => verifyInvalidation(before, { ...after, generation: 1 }, "auth-failed")).toThrow();
  expect(() =>
    verifyInvalidation(
      before,
      { ...after, livePod: { ...after.livePod, verificationStatus: "ok" } },
      "auth-failed",
    ),
  ).toThrow();
});

function containers() {
  return ["jira", "tls", "database"].map((service, index) => ({
    Id: String(index + 1).repeat(64),
    State: { Running: true },
    Config: {
      Image:
        service === "jira"
          ? "atlassian/jira-software:10.3.26@sha256:ddcddc61ee43067fa274538b888d36408c47bc6a4ec14e41113dc304b8529168"
          : service,
      Labels: {
        "com.docker.compose.project": "keiko-jira-4081-test",
        "com.docker.compose.service": service,
      },
    },
    NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18084" }] } },
  }));
}

it("selects only the exact synthetic Jira service and its existing running peers", () => {
  const records = containers();
  expect(
    validateServices({ project: "keiko-jira-4081-test", httpPort: 18084 }, records).jira.Id,
  ).toBe(records[0].Id);
  expect(() => validateServices({ project: "other", httpPort: 18084 }, records)).toThrow();
  records[0].NetworkSettings.Ports["8080/tcp"][0].HostPort = "18085";
  expect(() =>
    validateServices({ project: "keiko-jira-4081-test", httpPort: 18084 }, records),
  ).toThrow();
});

it("refuses an unowned peer or image before any service stop", () => {
  const records = containers();
  records[1].Config.Labels["com.docker.compose.project"] = "keiko-jira-4081-foreign";
  expect(() =>
    validateServices({ project: "keiko-jira-4081-test", httpPort: 18084 }, records),
  ).toThrow();
  records[1].Config.Labels["com.docker.compose.project"] = "keiko-jira-4081-test";
  records[0].Config.Image = "foreign";
  expect(() =>
    validateServices({ project: "keiko-jira-4081-test", httpPort: 18084 }, records),
  ).toThrow();
});

vi.mock("../testing/jira-chat-lab/lab-client.mjs", async (original) => ({
  ...(await original()),
  labRequest: vi.fn(),
}));
const roots = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tokenFixture() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-owned-pat-"));
  roots.push(directory);
  mkdirSync(join(directory, "secrets"));
  for (const name of ["api-user-password", "api-token", "editor-token", "restricted-token"])
    writeFileSync(join(directory, "secrets", name), `synthetic-${name}`, { mode: 0o600 });
  const group = {
    phase: "prepared",
    tokenName: "owned",
    tokenPath: join(directory, "secrets", "owned.json"),
    pendingPath: join(directory, "pending.json"),
  };
  const result = { id: 8, name: "owned", rawToken: "synthetic-new-owned" };
  labRequest.mockImplementation(async (_session, method, path) => {
    if (path.includes("mypermissions"))
      return {
        status: 200,
        value: {
          permissions: {
            ADMINISTER: { havePermission: false },
            SYSTEM_ADMIN: { havePermission: false },
          },
        },
      };
    if (method === "GET") return { status: 200, value: [{ id: 7, name: "shared" }] };
    expect(JSON.parse(readFileSync(group.pendingPath)).phase).toBe("pat-creation-may-have-started");
    return { status: 201, value: result };
  });
  return { context: { session: { directory } }, group, result };
}

it("persists owned credentials privately only after a single journaled native creation", async () => {
  const f = tokenFixture();
  await createOwnedToken(f.context, f.group);
  expect(JSON.parse(readFileSync(f.group.tokenPath))).toEqual(f.result);
  expect(statSync(f.group.tokenPath).mode & 0o077).toBe(0);
  expect(readFileSync(f.group.pendingPath, "utf8")).not.toContain(f.result.rawToken);
  expect(labRequest.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
});

it("retains an uncertain PAT creation intent and refuses a second dispatch after response loss", async () => {
  const f = tokenFixture();
  const original = labRequest.getMockImplementation();
  labRequest.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[1] === "POST") throw new TypeError("Synthetic lost response");
    return result;
  });
  await expect(createOwnedToken(f.context, f.group)).rejects.toThrow("Synthetic lost response");
  expect(JSON.parse(readFileSync(f.group.pendingPath)).phase).toBe("pat-creation-may-have-started");
  await expect(createOwnedToken(f.context, f.group)).rejects.toThrow("cannot resume");
  expect(labRequest.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
});

function recoveryReadiness() {
  let elapsed = 0;
  return {
    ready: vi.fn(async () => true),
    license: vi.fn(async () => 9000),
    now: () => elapsed,
    pause: vi.fn(async () => {
      elapsed += 2000;
    }),
  };
}
it("waits for licensed readiness after Docker reports healthy without repeating any write", async () => {
  const actions = recoveryReadiness();
  actions.license.mockRejectedValueOnce(new TypeError("License endpoint is still initializing"));
  await expect(waitForLicensedRecovery(actions, 6000)).resolves.toBeUndefined();
  expect(actions.ready).toHaveBeenCalledTimes(2);
  expect(actions.license).toHaveBeenCalledTimes(2);
  expect(actions.pause).toHaveBeenCalledOnce();
});
it("keeps an unavailable license bounded and never claims healthy recovery", async () => {
  const actions = recoveryReadiness();
  actions.license.mockRejectedValue(new TypeError("License is unavailable"));
  await expect(waitForLicensedRecovery(actions, 4000)).rejects.toThrow("within the recovery wait");
  expect(actions.license).toHaveBeenCalledTimes(2);
});
it("never treats changed service identity or volume checks as a retryable license startup", async () => {
  const actions = recoveryReadiness();
  actions.ready.mockRejectedValueOnce(new TypeError("Service ownership changed"));
  await expect(waitForLicensedRecovery(actions, 6000)).rejects.toThrow("ownership changed");
  expect(actions.license).not.toHaveBeenCalled();
  expect(actions.pause).not.toHaveBeenCalled();
});
