import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCspHeader } from "../csp.js";
import { UI_HOST } from "../server.js";
import { closeUiTestServer, startUiTestServer, type StartedUiTestServer } from "./_support.js";

const roots: string[] = [];
const servers: StartedUiTestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ server }) => closeUiTestServer(server)));
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

async function start(): Promise<StartedUiTestServer> {
  const staticRoot = mkdtempSync(join(tmpdir(), "keiko-ui-test-server-"));
  roots.push(staticRoot);
  const started = await startUiTestServer({ staticRoot, csp: buildCspHeader([]) });
  servers.push(started);
  return started;
}

describe("UI test server lifecycle", () => {
  it("binds once and validates the exact OS-selected loopback authority", async () => {
    const started = await start();
    const accepted = await fetch(`http://${UI_HOST}:${String(started.port)}/api/health`);
    const forged = await fetch(`http://${UI_HOST}:${String(started.port)}/api/health`, {
      headers: { Origin: `http://${UI_HOST}:1` },
    });

    expect(accepted.status).toBe(200);
    expect(forged.status).toBe(403);
  });

  it("uses a fresh authority after a server that handled keep-alive traffic closes", async () => {
    const first = await start();
    expect((await fetch(`http://${UI_HOST}:${String(first.port)}/api/health`)).status).toBe(200);
    await closeUiTestServer(first.server);
    servers.splice(servers.indexOf(first), 1);

    const second = await start();
    expect(second.port).not.toBe(first.port);
    expect((await fetch(`http://${UI_HOST}:${String(second.port)}/api/health`)).status).toBe(200);
  });
});
