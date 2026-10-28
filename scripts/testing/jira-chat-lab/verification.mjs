import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { withLiveChat, jsonRequest } from "./chat-read.mjs";
import {
  loadSession,
  readPrivateFile,
  basicAuth,
  labRequest,
  requireLicense,
} from "./lab-client.mjs";
import { privateJson } from "./private-json.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const execute = promisify(execFile);
const JIRA_IMAGE =
  "atlassian/jira-software:10.3.26@sha256:ddcddc61ee43067fa274538b888d36408c47bc6a4ec14e41113dc304b8529168";
const save = (group) => privateJson(group.pendingPath, group);
const api = (context, path, body, method = "POST") =>
  jsonRequest(context.origin, context.cookie, "native-verification", path, body, method);
const verificationPath = (authRef) =>
  `/api/atlassian-connectors/credentials/${encodeURIComponent(authRef)}/verify`;

async function credential(context, authRef) {
  const result = await api(context, "/api/atlassian-connectors/credentials", undefined, "GET");
  const current = result.credentials.find((entry) => entry.authRef === authRef);
  assert.ok(current?.livePod);
  return current;
}

async function createCredential(context, token) {
  return api(context, "/api/atlassian-connectors/credentials", {
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    displayName: "Synthetic native verification",
    baseUrl: "https://127.0.0.1:18443",
    apiToken: token,
    livePodCreationRequestId: randomUUID(),
  });
}

export function verifyInvalidation(before, after, status) {
  assert.equal(after.authRef, before.authRef);
  assert.equal(after.livePod.podId, before.livePod.podId);
  assert.equal(after.livePod.verificationStatus, status);
  assert.ok(after.generation > before.generation);
  assert.ok(after.livePod.authenticationGeneration > before.livePod.authenticationGeneration);
}

async function verify(context, original, expected) {
  const result = await api(context, verificationPath(original.authRef), {});
  assert.equal(result.status, expected);
  const current = await credential(context, original.authRef);
  assert.equal(current.livePod.verificationStatus, expected);
  if (expected !== "ok") verifyInvalidation(original, current, expected);
  return current;
}

/** Delay one real successful response; never synthesize a Jira status or response body. */
export function delayedVerification() {
  let target;
  let observed;
  let release;
  const ready = new Promise((resolveReady) => {
    observed = resolveReady;
  });
  const pending = new Promise((resolvePending) => {
    release = resolvePending;
  });
  let held = 0;
  const decorate = (factory) => (metadata, correlationId, lifecycle) => {
    const port = factory(metadata, correlationId, lifecycle);
    return async (request) => {
      const response = await port(request);
      if (
        target === undefined ||
        metadata.authRef !== target ||
        request.method !== "GET" ||
        !new URL(request.url).pathname.endsWith("/rest/api/2/myself") ||
        response.kind !== "response" ||
        response.status !== 200 ||
        held !== 0
      )
        return response;
      held += 1;
      observed();
      await pending;
      return response;
    };
  };
  return { decorate, arm: (authRef) => (target = authRef), ready, release, count: () => held };
}

async function native(context, method, path, body) {
  return labRequest(context.session, method, path, basicAuth(context.session, "api"), body);
}

async function ownedTokens(context) {
  const result = await native(context, "GET", "/rest/pat/latest/tokens");
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.value) && result.value.length <= 100);
  for (const token of result.value) assert.ok(Number.isSafeInteger(token.id) && token.id > 0);
  return result.value;
}

export function validateOwnedToken(token, group, protectedTokens) {
  assert.ok(Number.isSafeInteger(token?.id) && token.id > 0);
  assert.equal(token.name, group.tokenName);
  assert.ok(!group.priorTokenIds.includes(token.id));
  assert.ok(typeof token.rawToken === "string" && token.rawToken.trim().length > 0);
  assert.ok(!protectedTokens.includes(token.rawToken));
  return token;
}

export async function createOwnedToken(context, group) {
  assert.equal(group.phase, "prepared", "PAT creation cannot resume an uncertain dispatch");
  const permission = await native(
    context,
    "GET",
    "/rest/api/2/mypermissions?permissions=ADMINISTER,SYSTEM_ADMIN",
  );
  assert.equal(permission.status, 200);
  for (const name of ["ADMINISTER", "SYSTEM_ADMIN"])
    assert.equal(permission.value.permissions[name].havePermission, false);
  group.priorTokenIds = (await ownedTokens(context)).map((token) => token.id);
  group.phase = "pat-creation-may-have-started";
  save(group);
  const result = await native(context, "POST", "/rest/pat/latest/tokens", {
    name: group.tokenName,
    expirationDuration: 1,
  });
  assert.ok(new Set([200, 201]).has(result.status));
  const protectedTokens = ["api", "editor", "restricted"].map((actor) =>
    readPrivateFile(join(context.session.directory, "secrets", `${actor}-token`)),
  );
  const token = validateOwnedToken(result.value, group, protectedTokens);
  privateJson(group.tokenPath, token, true);
  group.phase = "owned-pat-recorded";
  save(group);
  return token;
}

async function revokeOwnedToken(context, group) {
  const token = JSON.parse(readPrivateFile(group.tokenPath));
  validateOwnedToken(token, group, []);
  const current = (await ownedTokens(context)).filter((entry) => entry.id === token.id);
  assert.equal(current.length, 1);
  assert.equal(current[0].name, group.tokenName);
  group.phase = "owned-pat-revocation-may-have-started";
  save(group);
  const result = await native(context, "DELETE", `/rest/pat/latest/tokens/${String(token.id)}`);
  assert.ok(new Set([200, 204]).has(result.status));
  assert.ok(!(await ownedTokens(context)).some((entry) => entry.id === token.id));
  group.phase = "owned-pat-revoked";
  save(group);
}

async function staleProbe(context, authRef) {
  const response = await globalThis.fetch(context.origin + verificationPath(authRef), {
    method: "POST",
    headers: {
      Cookie: context.cookie,
      Origin: context.origin,
      "X-Keiko-CSRF": "1",
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: globalThis.AbortSignal.timeout(60_000),
  });
  return { status: response.status, value: await response.json() };
}

async function waitForProbe(ready) {
  let timer;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(() => reject(new TypeError("Probe not observed")), 30_000);
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function qualifyRevoked(context, group, delay) {
  const token = await createOwnedToken(context, group);
  const created = await createCredential(context, token.rawToken);
  const valid = await verify(context, created, "ok");
  group.authRef = valid.authRef;
  save(group);
  delay.arm(valid.authRef);
  const late = staleProbe(context, valid.authRef).catch((error) => ({ error }));
  try {
    await waitForProbe(delay.ready);
    await revokeOwnedToken(context, group);
    const invalid = await verify(context, valid, "auth-failed");
    delay.release();
    const stale = await late;
    if ("error" in stale) throw stale.error;
    assert.equal(stale.status, 409);
    assert.equal(stale.value.error.code, "CREDENTIAL_CHANGED");
    assert.deepEqual(await credential(context, valid.authRef), invalid);
    assert.equal(delay.count(), 1);
    group.results.push({
      case: "revoked-pat",
      status: "auth-failed",
      staleStatus: 409,
      generationAdvanced: true,
    });
  } finally {
    delay.release();
    await late.catch(() => undefined);
  }
}

async function qualifyPat(context, group, delay) {
  await qualifyRevoked(context, group, delay);
  const invalid = await createCredential(context, `keiko-intentionally-invalid-${randomUUID()}`);
  await verify(context, invalid, "auth-failed");
  group.results.push({ case: "invalid-pat", status: "auth-failed", generationAdvanced: true });
  save(group);
}

export function validateServices(session, containers) {
  assert.match(session.project, /^keiko-jira-4081-[a-z0-9-]{1,32}$/u);
  const services = {};
  for (const container of containers) {
    assert.equal(container.Config.Labels["com.docker.compose.project"], session.project);
    const service = container.Config.Labels["com.docker.compose.service"];
    assert.ok(new Set(["jira", "tls", "database"]).has(service));
    assert.equal(services[service], undefined);
    assert.match(container.Id, /^[a-f0-9]{64}$/u);
    assert.equal(container.State.Running, true);
    services[service] = container;
  }
  assert.equal(Object.keys(services).length, 3);
  assert.equal(services.jira.Config.Image, JIRA_IMAGE);
  assert.deepEqual(services.jira.NetworkSettings.Ports["8080/tcp"], [
    { HostIp: "127.0.0.1", HostPort: String(session.httpPort) },
  ]);
  return services;
}

async function docker(args) {
  const result = await execute("docker", args, { timeout: 60_000, maxBuffer: 1_048_576 });
  return result.stdout.trim();
}

async function inspectServices(session) {
  const ids = (
    await docker(["ps", "-q", "--filter", `label=com.docker.compose.project=${session.project}`])
  ).split("\n");
  assert.equal(ids.length, 3);
  return validateServices(session, JSON.parse(await docker(["inspect", ...ids])));
}

function volumes(container) {
  return container.Mounts.filter((mount) => mount.Type === "volume").map((mount) => ({
    name: mount.Name,
    destination: mount.Destination,
  }));
}

export async function waitForLicensedRecovery(
  {
    ready,
    license,
    now = Date.now,
    pause = () => new Promise((resolve) => globalThis.setTimeout(resolve, 2000)),
  },
  timeoutMs = 300_000,
) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await ready()) {
      try {
        await license();
        return;
      } catch {
        // Docker health can precede Jira's license plugin. Only this read is retried.
        console.log(JSON.stringify({ operation: "jira-lab-recovery", case: "license-not-ready" }));
      }
    }
    await pause();
  }
  throw new TypeError(
    "Restarted Jira did not become licensed and healthy within the recovery wait",
  );
}
async function healthy(session, services) {
  await waitForLicensedRecovery({
    license: () => requireLicense(session),
    ready: async () => {
      const [current] = JSON.parse(await docker(["inspect", services.jira.Id]));
      if (current.State.Health?.Status !== "healthy") return false;
      const after = await inspectServices(session);
      for (const service of ["jira", "tls", "database"]) {
        assert.equal(after[service].Id, services[service].Id);
        assert.deepEqual(volumes(after[service]), volumes(services[service]));
      }
      return true;
    },
  });
}

async function restoreService(group, actions) {
  group.phase = "jira-restart-required";
  let persistenceError;
  try {
    actions.save();
  } catch (error) {
    persistenceError = error;
  }
  await actions.start();
  await actions.healthy();
  await actions.preflight();
  group.phase = "jira-recovered";
  actions.save();
  if (persistenceError !== undefined) throw persistenceError;
}

export async function withStoppedService(group, actions) {
  group.phase = "jira-stop-may-have-started";
  actions.save();
  try {
    await actions.stop();
    await actions.verify();
  } finally {
    await restoreService(group, actions);
  }
}

async function qualifyAvailability(context, group) {
  const services = await inspectServices(context.session);
  group.containerId = services.jira.Id;
  save(group);
  const token = readPrivateFile(join(context.session.directory, "secrets", "api-token"));
  const valid = await verify(context, await createCredential(context, token), "ok");
  await withStoppedService(group, {
    save: () => save(group),
    stop: () => docker(["stop", "--time", "30", services.jira.Id]),
    start: () => docker(["start", services.jira.Id]),
    healthy: () => healthy(context.session, services),
    preflight: () =>
      execute(
        process.execPath,
        [join(dirname(SCRIPT), "preflight.mjs"), context.session.directory],
        { timeout: 90_000 },
      ),
    verify: async () => {
      const current = JSON.parse(
        await docker(["inspect", ...Object.values(services).map((service) => service.Id)]),
      );
      for (const service of current)
        assert.equal(service.State.Running, service.Id !== services.jira.Id);
      await verify(context, valid, "unreachable");
    },
  });
  await verify(context, await credential(context, valid.authRef), "ok");
  group.results.push({
    case: "stopped-jira",
    status: "unreachable",
    recovered: true,
    preservedPeersAndVolumes: true,
  });
}

async function main() {
  const session = loadSession(process.argv[2]);
  const modelId = process.argv[3];
  const mode = process.argv[4];
  assert.ok(modelId && new Set(["pat", "availability"]).has(mode));
  const remaining = await requireLicense(session);
  assert.ok(remaining > 900, "Qualification needs enough licensed recovery time");
  const id = randomUUID();
  const group = {
    id,
    mode,
    results: [],
    phase: "prepared",
    tokenName: `Keiko 4081 revoke ${id.slice(0, 8)}`,
    tokenPath: join(session.directory, "secrets", `verification-${id}.json`),
    pendingPath: join(session.directory, `verification-${mode}.pending.json`),
  };
  privateJson(group.pendingPath, group, true);
  const delay = delayedVerification();
  await withLiveChat({
    session,
    modelId,
    retainState: true,
    decorateAtlassianHttp: delay.decorate,
    stateReady: (root) => {
      group.stateDirectory = root;
      save(group);
    },
    run: (context) =>
      mode === "pat" ? qualifyPat(context, group, delay) : qualifyAvailability(context, group),
  });
  await requireLicense(session);
  assert.equal(group.results.length, mode === "pat" ? 2 : 1);
  assert.notEqual(process.exitCode, 1);
  privateJson(
    join(session.directory, `verification-${mode}-${id}.json`),
    {
      schemaVersion: 1,
      id,
      mode,
      results: group.results,
      passed: true,
    },
    true,
  );
  rmSync(group.pendingPath);
  console.log(JSON.stringify({ qualification: "jira-native-verification", mode, passed: true }));
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT)
  await main().catch((error) => {
    console.log(
      JSON.stringify({
        qualification: "jira-native-verification",
        passed: false,
        errorType: error instanceof Error ? error.name : "unknown",
        reconcileRequired: true,
      }),
    );
    process.exitCode = 1;
  });
