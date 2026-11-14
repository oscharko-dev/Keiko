import { expect, it, vi, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  labRequest,
  DEFAULT_LAB_CONNECTION,
  labSessionConnection,
  normalizeLabSession,
  loadSession,
  assertSessionServerInfo,
} from "../testing/jira-chat-lab/lab-client.mjs";
import { sessionVerificationPort } from "../testing/jira-chat-lab/product-port.mjs";
import {
  createOwnedToken,
  delayedVerification,
  validateOwnedToken,
  validateServices,
  validateLabImage,
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

function containers(session) {
  const selected = labSessionConnection(session);
  return ["jira", "tls", "database"].map((service, index) => ({
    Id: String(index + 1).repeat(64),
    Image: `sha256:${"a".repeat(64)}`,
    State: { Running: true },
    Config: {
      Image: service === "jira" ? selected.jiraImage : service,
      Cmd:
        service === "tls"
          ? ["node", "/opt/tls-front.mjs", "/tls", String(selected.httpsPort), "8080", "compose"]
          : [],
      Labels: {
        "com.docker.compose.project": "keiko-jira-4081-test",
        "com.docker.compose.service": service,
      },
    },
    NetworkSettings: {
      Ports:
        service === "tls"
          ? {
              [`${selected.httpsPort}/tcp`]: [
                { HostIp: "127.0.0.1", HostPort: String(selected.httpsPort) },
              ],
            }
          : { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18084" }] },
    },
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

it("accepts the recorded private-address binding of the TLS front, and only that one", () => {
  const session = { project: "keiko-jira-4081-test", httpPort: 18084 };
  const withAddress = (address) => {
    const records = containers();
    const tls = records[1];
    const [port] = Object.keys(tls.NetworkSettings.Ports);
    tls.NetworkSettings.Ports[port].push({ HostIp: address, HostPort: port.split("/")[0] });
    tls.Config.Cmd.push(address);
    return records;
  };
  const records = withAddress("10.0.0.79");
  expect(validateServices(session, records, "10.0.0.79").tls.Id).toBe(records[1].Id);
  // An extra binding the session never recorded, a different address, or a recorded address that
  // is not published all fail: the published surface is exactly what the session declares.
  expect(() => validateServices(session, records)).toThrow();
  expect(() => validateServices(session, records, "10.0.0.80")).toThrow();
  expect(() => validateServices(session, containers(), "10.0.0.79")).toThrow();
  const wide = withAddress("0.0.0.0");
  expect(() => validateServices(session, wide, "10.0.0.79")).toThrow();
});

const OLD_SESSION = {
  schemaVersion: 1,
  project: "keiko-jira-4081-test",
  httpPort: 18084,
  syntheticOnly: true,
};
// Synthetic digest tests admission only; it is not a published or qualified Jira image pin.
const PINNED_SESSION = {
  ...OLD_SESSION,
  httpsPort: 19443,
  jiraVersion: "11.3.0",
  jiraImageDigest: "b".repeat(64),
};

it("normalizes legacy defaults without rewriting the original private manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-session-pins-"));
  roots.push(directory);
  const original = JSON.stringify(OLD_SESSION) + "\n";
  const path = join(directory, "session.json");
  writeFileSync(path, original, { mode: 0o600 });
  expect(loadSession(directory)).toMatchObject({
    ...DEFAULT_LAB_CONNECTION,
    httpPort: 18084,
    origin: "http://127.0.0.1:18084",
    httpsOrigin: "https://127.0.0.1:18443",
  });
  expect(readFileSync(path, "utf8")).toBe(original);
});

it("refuses a non-private or symlinked session manifest before any service access", () => {
  const directory = mkdtempSync(join(tmpdir(), "keiko-session-private-"));
  roots.push(directory);
  const path = join(directory, "session.json");
  writeFileSync(path, JSON.stringify(OLD_SESSION), { mode: 0o644 });
  chmodSync(path, 0o644);
  expect(() => loadSession(directory)).toThrow("private regular file");
  rmSync(path);
  const target = join(directory, "private.json");
  writeFileSync(target, JSON.stringify(OLD_SESSION), { mode: 0o600 });
  symlinkSync(target, path);
  expect(() => loadSession(directory)).toThrow("private regular file");
});

it.each(["10.3.26", "10.4.0", "11.2.0", "11.3.0"])(
  "binds an explicitly pinned %s session without a registry/tag lookup",
  (jiraVersion) => {
    const session = normalizeLabSession({ ...PINNED_SESSION, jiraVersion }, "/private/session");
    expect(session.jiraImage).toBe(
      `atlassian/jira-software:${jiraVersion}@sha256:${"b".repeat(64)}`,
    );
    expect(session.httpsOrigin).toBe("https://127.0.0.1:19443");
    expect(Object.isFrozen(session)).toBe(true);
    expect(() =>
      assertSessionServerInfo(session, {
        version: jiraVersion,
        versionNumbers: jiraVersion.split(".").map(Number),
        deploymentType: "Data Center",
      }),
    ).not.toThrow();
  },
);

it.each([
  { ...OLD_SESSION, httpsPort: 19443 },
  { ...PINNED_SESSION, jiraImageDigest: undefined },
  { ...PINNED_SESSION, httpsPort: null },
  { ...PINNED_SESSION, httpsPort: 18084 },
  { ...PINNED_SESSION, httpsPort: 8080 },
  { ...PINNED_SESSION, httpPort: "18084" },
  { ...PINNED_SESSION, jiraVersion: "11.3" },
  { ...PINNED_SESSION, jiraVersion: "11.3.0/latest" },
  { ...PINNED_SESSION, jiraVersion: "10.2.0" },
  { ...PINNED_SESSION, jiraImageDigest: "sha256:" + "b".repeat(64) },
  { ...PINNED_SESSION, origin: "https://other.invalid" },
  { ...PINNED_SESSION, environment: { JAVA_OPTS: "foreign" } },
])("refuses incomplete pins, collisions and untrusted manifest fields %#", (manifest) => {
  expect(() => normalizeLabSession(manifest, "/private/session")).toThrow();
});

it("checks the selected TLS port at publication and inside the Host-guarded frontend", () => {
  const records = containers(PINNED_SESSION);
  expect(validateServices(PINNED_SESSION, records).tls.Id).toBe(records[1].Id);
  records[1].Config.Cmd[3] = "18443";
  expect(() => validateServices(PINNED_SESSION, records)).toThrow();
  records[1].Config.Cmd[3] = "19443";
  records[1].NetworkSettings.Ports["19443/tcp"][0].HostIp = "0.0.0.0";
  expect(() => validateServices(PINNED_SESSION, records)).toThrow();
  records[1].NetworkSettings.Ports["19443/tcp"][0].HostIp = "127.0.0.1";
  records[1].NetworkSettings.Ports["18443/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "18443" }];
  expect(() => validateServices(PINNED_SESSION, records)).toThrow();
});

it("binds the running image ID and immutable repository digest, not merely Config.Image", () => {
  const [container] = containers(PINNED_SESSION);
  const image = {
    Id: container.Image,
    RepoDigests: [`atlassian/jira-software@sha256:${PINNED_SESSION.jiraImageDigest}`],
  };
  expect(() => validateLabImage(PINNED_SESSION, container, image)).not.toThrow();
  expect(() =>
    validateLabImage(PINNED_SESSION, { ...container, Image: `sha256:${"c".repeat(64)}` }, image),
  ).toThrow();
  expect(() =>
    validateLabImage(PINNED_SESSION, container, {
      ...image,
      RepoDigests: [`foreign/jira@sha256:${PINNED_SESSION.jiraImageDigest}`],
    }),
  ).toThrow();
  expect(() =>
    validateLabImage(PINNED_SESSION, container, {
      ...image,
      RepoDigests: [`atlassian/jira-software@sha256:${"c".repeat(64)}`],
    }),
  ).toThrow();
});

it("compares the actual native verification response to the selected release without issuing another request", async () => {
  const body = { version: "11.3.0", versionNumbers: [11, 3, 0], deploymentType: "Data Center" };
  const response = {
    kind: "response",
    status: 200,
    truncated: false,
    bodyText: JSON.stringify(body),
  };
  const native = vi.fn(async () => response);
  const port = sessionVerificationPort(PINNED_SESSION, native);
  const request = { method: "GET", url: "https://127.0.0.1:19443/rest/api/2/serverInfo" };
  expect(await port(request)).toBe(response);
  expect(native).toHaveBeenCalledOnce();
  expect(native).toHaveBeenCalledWith(request);
  native.mockResolvedValueOnce({
    ...response,
    bodyText: JSON.stringify({ ...body, version: "11.2.0", versionNumbers: [11, 2, 0] }),
  });
  await expect(port(request)).rejects.toThrow("does not match");
});

it("does not manufacture success or replace native errors when observing the selected release", async () => {
  const request = { method: "GET", url: "https://127.0.0.1:19443/rest/api/2/serverInfo" };
  const failure = { kind: "response", status: 401, truncated: false, bodyText: "not-json" };
  const native = vi.fn(async () => failure);
  const port = sessionVerificationPort(PINNED_SESSION, native);
  expect(await port(request)).toBe(failure);
  const truncated = { kind: "response", status: 200, truncated: true, bodyText: "{}" };
  native.mockResolvedValueOnce(truncated);
  expect(await port(request)).toBe(truncated);
  const malformed = {
    kind: "response",
    status: 200,
    truncated: false,
    bodyText: "synthetic-invalid-json",
  };
  native.mockResolvedValueOnce(malformed);
  expect(await port(request)).toBe(malformed);
  native.mockResolvedValueOnce({ kind: "response", status: 200, truncated: false, bodyText: "{}" });
  await expect(port(request)).rejects.toThrow("does not match");
  const defect = new TypeError("synthetic transport defect");
  native.mockRejectedValueOnce(defect);
  await expect(port(request)).rejects.toBe(defect);
});

it("refuses a stale session destination before calling the production HTTP port", async () => {
  const native = vi.fn();
  const port = sessionVerificationPort(PINNED_SESSION, native);
  await expect(
    port({ method: "GET", url: "https://127.0.0.1:18443/rest/api/2/serverInfo" }),
  ).rejects.toThrow("selected session");
  expect(native).not.toHaveBeenCalled();
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
