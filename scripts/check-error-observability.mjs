#!/usr/bin/env node
// RB-6 release gate (GEN-OBS-DIAGNOSTICS-901, CORRELATION-103/402/601) — Server error observability.
//
// Drives the REAL built BFF (packages/keiko-server/dist) end to end: a route handler is forced to
// throw, and the gate asserts the top-level catch (a) returns an opaque 500 that carries a well-formed
// correlation id, (b) echoes that id on the X-Keiko-Correlation-Id response header, (c) routes the
// redacted cause to the operator diagnostic sink keyed by the same id, (d) never leaks the raw cause
// to the browser, and (e) honours a well-formed UI-supplied correlation id (UI -> server continuity).
//
// It goes RED against the pre-RB-6 defect: a bare `.catch(() => { ... })` that discards the error and
// emits an id-less 500 fails assertions (b)/(a)/(c). This is the standalone, workflow-wired counterpart
// to the in-suite regression tests (server.test.ts / chat-stream-handlers.test.ts).

import { Buffer } from "node:buffer";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "../packages/keiko-server/dist/index.js");

const SECRET_MARKER = "gate-secret-DO-NOT-LEAK";
const ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const HOST = "127.0.0.1";

function fail(message) {
  console.error(`check:error-observability FAIL — ${message}`);
  process.exit(1);
}

function rawGet(port, path, headers = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      { host: HOST, port, path, method: "GET", headers: { host: `${HOST}:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function loadServerModule() {
  let mod;
  try {
    mod = await import(serverEntry);
  } catch (error) {
    fail(
      `could not import built server at ${serverEntry} — run \`npm run build\` first (${String(error)})`,
    );
  }
  const required = [
    "createUiServer",
    "buildRedactor",
    "createInMemoryUiStore",
    "createRunRegistry",
    "buildCspHeader",
  ];
  for (const name of required) {
    if (typeof mod[name] !== "function") fail(`built server does not export ${name}`);
  }
  return mod;
}

function throwingDeps(mod, records) {
  const store = mod.createInMemoryUiStore();
  return {
    config: undefined,
    configPresent: false,
    evidenceStore: { put: () => "", list: () => [], get: () => undefined, delete: () => undefined },
    env: {},
    redactor: mod.buildRedactor({}),
    diagnostics: { record: (r) => records.push(r) },
    registry: mod.createRunRegistry(),
    modelPortFactory: () => undefined,
    store: {
      ...store,
      listProjects: () => {
        throw new Error(SECRET_MARKER);
      },
    },
  };
}

// Two-phase bind so the Host/Origin allow-check validates against the real listening port.
async function startServer(mod, records) {
  const probe = mod.createUiServer({ staticRoot: here, csp: mod.buildCspHeader([]), port: 0 });
  const port = await new Promise((res) => {
    probe.listen(0, HOST, () => res(probe.address().port));
  });
  await new Promise((res) => probe.close(res));
  const server = mod.createUiServer({
    staticRoot: here,
    csp: mod.buildCspHeader([]),
    port,
    handlerDeps: throwingDeps(mod, records),
  });
  await new Promise((res) => server.listen(port, HOST, res));
  return { server, port };
}

function parse500Body(res) {
  if (res.status !== 500) fail(`expected 500 on handler throw, got ${res.status}`);
  try {
    return JSON.parse(res.body);
  } catch {
    return fail(`500 body is not JSON: ${res.body.slice(0, 200)}`);
  }
}

function assertNoLeak(res) {
  const headerBlob = Object.entries(res.headers)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(",") : v}`)
    .join("\n");
  if (res.body.includes(SECRET_MARKER) || headerBlob.includes(SECRET_MARKER)) {
    fail("raw cause leaked into the client-visible response");
  }
}

function assertOpaque500WithId(res) {
  const parsed = parse500Body(res);
  const cid = parsed?.error?.correlationId;
  if (typeof cid !== "string" || !ID_PATTERN.test(cid)) {
    fail(`500 body carries no well-formed error.correlationId (got ${JSON.stringify(cid)})`);
  }
  if (parsed.error.code !== "INTERNAL")
    fail(`expected error.code INTERNAL, got ${parsed.error.code}`);
  if (res.headers["x-keiko-correlation-id"] !== cid) {
    fail(`X-Keiko-Correlation-Id (${res.headers["x-keiko-correlation-id"]}) != body id (${cid})`);
  }
  assertNoLeak(res);
  return cid;
}

function assertDiagnosticCaptured(records, cid) {
  if (records.length !== 1) fail(`expected exactly 1 diagnostic record, got ${records.length}`);
  const [record] = records;
  if (record.correlationId !== cid)
    fail("diagnostic record correlationId does not match the 500 id");
  if (record.source !== "server.top-level-catch")
    fail(`unexpected diagnostic source ${record.source}`);
  if (!String(record.message).includes(SECRET_MARKER)) {
    fail("diagnostic record did not capture the underlying cause");
  }
}

async function assertClientIdHonoured(port) {
  const clientId = "gate-ui-req-0123456789";
  const echoed = await rawGet(port, "/api/projects", { "x-keiko-correlation-id": clientId });
  const parsed = JSON.parse(echoed.body);
  if (
    echoed.headers["x-keiko-correlation-id"] !== clientId ||
    parsed.error.correlationId !== clientId
  ) {
    fail("a well-formed UI-supplied correlation id was not honoured end to end");
  }
}

async function main() {
  const mod = await loadServerModule();
  const records = [];
  const { server, port } = await startServer(mod, records);
  try {
    const cid = assertOpaque500WithId(await rawGet(port, "/api/projects"));
    assertDiagnosticCaptured(records, cid);
    await assertClientIdHonoured(port);
  } finally {
    await new Promise((res) => server.close(res));
  }
  console.log(
    "check:error-observability PASS — top-level 500 carries a correlation id + header, the redacted cause is logged, and a UI-supplied id round-trips.",
  );
}

main().catch((error) => fail(`unexpected gate error: ${String(error?.stack ?? error)}`));
