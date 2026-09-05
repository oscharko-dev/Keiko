import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeGatewaySeatbeltCommand,
  createRuntimeGatewayConfinement,
  isRuntimeGatewayConfinement,
  type RuntimeGatewayConfinementInput,
} from "./runtime-gateway.js";
import { currentPlatform, probeBackends } from "./probe.js";

const input: RuntimeGatewayConfinementInput = {
  gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
  runId: "run-2951",
  treeBindingId: "a".repeat(64),
  envelopeDigest: "b".repeat(64),
  runtimeArtifactDigest: "c".repeat(64),
  modelProfileDigest: "d".repeat(64),
};

describe("long-lived gateway network confinement", () => {
  it("rejects accessors without invoking them before compiling a wrapper", () => {
    const policy = createRuntimeGatewayConfinement(input);
    let reads = 0;
    const hostile = Object.defineProperty({ ...policy }, "port", {
      enumerable: true,
      get: (): number => {
        reads += 1;
        return policy.port;
      },
    });
    expect(isRuntimeGatewayConfinement(hostile)).toBe(false);
    expect(() => buildRuntimeGatewaySeatbeltCommand(hostile, "/runtime", [])).toThrow();
    expect(reads).toBe(0);
  });

  it("permits only the authenticated gateway's TCP family/port and denies service escapes", () => {
    const policy = createRuntimeGatewayConfinement(input);
    const wrapped = buildRuntimeGatewaySeatbeltCommand(policy, "/trusted/opencode", ["serve"]);
    expect(wrapped.command).toBe("/usr/bin/sandbox-exec");
    expect(wrapped.args).toEqual(["-p", expect.any(String), "/trusted/opencode", "serve"]);
    const profile = wrapped.args[1];
    for (const denied of ["network*", "mach-lookup", "appleevent-send", "lsopen"])
      expect(profile).toContain(`(deny ${denied})`);
    expect(profile).toContain('(remote tcp4 "localhost:1983")');
    expect(profile).toContain('(local tcp4 "localhost:*")');
    expect(profile).not.toContain("unix-socket");
    expect(profile).not.toContain("udp");
    expect(profile).not.toContain('remote tcp4 "localhost:*"');
    expect(Object.isFrozen(policy)).toBe(true);
    expect(JSON.stringify(policy)).not.toContain(input.gatewayUrl);
  });

  // Regression pin (#3390 live run): the pinned OpenCode sidecar shells out to `git` for its own
  // session/history endpoints, so a fork denial in this profile broke every dev-lane coding run at
  // the handshake (`POST /sync/history` / `GET /session` both answered HTTP 500). This pin moved
  // here, strengthened, from the old "denies process-fork" assertion above: fork must stay ALLOWED,
  // and the other service-escape denials this incident did NOT touch must stay exactly as strict.
  it("allows process-fork so the sidecar can spawn git, while still denying every other escape (#3390)", () => {
    const policy = createRuntimeGatewayConfinement(input);
    const profile = buildRuntimeGatewaySeatbeltCommand(policy, "/trusted/opencode", ["serve"])
      .args[1];
    expect(profile).not.toContain("process-fork");
    expect(profile).not.toContain("(deny process*)");
    for (const denied of ["network*", "mach-lookup", "appleevent-send", "lsopen"])
      expect(profile).toContain(`(deny ${denied})`);
  });

  it("keeps IPv6 destinations separate from IPv4 and preserves the exact boundary ports", () => {
    for (const port of [1, 65_535]) {
      const policy = createRuntimeGatewayConfinement({
        ...input,
        gatewayUrl: `http://[::1]:${String(port)}/gateway`,
      });
      expect(policy.addressFamily).toBe("ipv6");
      expect(buildRuntimeGatewaySeatbeltCommand(policy, "/runtime", []).args[1]).toContain(
        `(remote tcp6 "localhost:${String(port)}")`,
      );
    }
    expect(
      createRuntimeGatewayConfinement({ ...input, gatewayUrl: "http://127.0.0.1/gateway" }).port,
    ).toBe(80);
  });

  it.each([
    "https://127.0.0.1:1983/gateway",
    "http://localhost:1983/gateway",
    "http://0.0.0.0:1983/gateway",
    "http://192.0.2.1:1983/gateway",
    "http://127.0.0.2:1983/gateway",
    "http://[::ffff:127.0.0.1]:1983/gateway",
    "http://127.0.0.1:0/gateway",
    "http://127.0.0.1:65536/gateway",
    "http://secret@127.0.0.1:1983/gateway",
    "http://127.0.0.1:1983/gateway?token=secret",
    "http://127.0.0.1:1983/gateway#secret",
    "not-a-url",
  ])("rejects an unqualified destination %s", (gatewayUrl) => {
    expect(() => createRuntimeGatewayConfinement({ ...input, gatewayUrl })).toThrow(
      "runtime-gateway-policy-invalid",
    );
  });

  it.each([
    "runId",
    "treeBindingId",
    "envelopeDigest",
    "runtimeArtifactDigest",
    "modelProfileDigest",
  ] as const)("binds the policy to %s and rejects malformed identities", (key) => {
    const policy = createRuntimeGatewayConfinement(input);
    const changed = createRuntimeGatewayConfinement({
      ...input,
      [key]: key === "runId" ? "other-run" : "e".repeat(64),
    });
    expect(changed.policyDigest).not.toBe(policy.policyDigest);
    expect(() => createRuntimeGatewayConfinement({ ...input, [key]: "" })).toThrow();
  });

  it("rejects widening, identity tampering, unknown fields and incomplete policies", () => {
    const policy = createRuntimeGatewayConfinement(input);
    expect(isRuntimeGatewayConfinement(policy)).toBe(true);
    for (const invalid of [
      null,
      [],
      {},
      { ...policy, port: 80 },
      { ...policy, addressFamily: "ipv6" },
      { ...policy, profile: "inherit" },
      { ...policy, schemaVersion: 2 },
      { ...policy, token: "secret" },
      { ...policy, modelProfileDigest: "e".repeat(64) },
      { ...policy, policyDigest: "invalid" },
    ])
      expect(isRuntimeGatewayConfinement(invalid)).toBe(false);
    expect(() =>
      buildRuntimeGatewaySeatbeltCommand({ ...policy, port: 80 }, "/runtime", []),
    ).toThrow();
  });
});

// LIVE OS-level proof (#2951, ADR-0043/ADR-0140 macOS-only scope). This is NOT an argv-string
// assertion: it actually spawns a trivial child under the real /usr/bin/sandbox-exec wrapper and
// proves the kernel denies a hostile loopback destination while it permits the exact configured
// gateway port. Both destinations are real, listening loopback servers on ephemeral ports -- never
// the internet -- so the proof is hermetic. It self-skips with a loud, recorded closed reason (never
// a silent green) on non-macOS hosts and where sandbox-exec is unavailable.
interface ChildRun {
  readonly status: number | null;
  readonly stdout: string;
}

function run(command: string, args: readonly string[]): ChildRun {
  const result = spawnSync(command, [...args], { timeout: 10_000 });
  if (result.error !== undefined) return { status: null, stdout: "" };
  return { status: result.status, stdout: result.stdout.toString("utf8").trim() };
}

function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

function connectSnippet(port: number): string {
  return [
    "const net = require('net');",
    `const s = net.connect({ host: '127.0.0.1', port: ${String(port)} });`,
    "s.setTimeout(3000);",
    "s.on('connect', () => { process.stdout.write('CONNECTED'); s.destroy(); process.exit(0); });",
    "s.on('error', () => { process.stdout.write('BLOCKED'); process.exit(3); });",
    "s.on('timeout', () => { process.stdout.write('TIMEOUT'); s.destroy(); process.exit(3); });",
  ].join("");
}

// Writes the connect probe to a file so a genuinely spawned grandchild `node` process can run it.
function writeForkConnectScript(dir: string, port: number): string {
  const path = join(dir, "fork-connect.cjs");
  writeFileSync(
    path,
    [
      "const net = require('net');",
      `const s = net.connect({ host: '127.0.0.1', port: ${String(port)} });`,
      "s.setTimeout(3000);",
      "s.on('connect', () => { process.stdout.write('CONNECTED'); s.destroy(); process.exit(0); });",
      "s.on('error', () => { process.stdout.write('BLOCKED'); process.exit(3); });",
      "s.on('timeout', () => { process.stdout.write('TIMEOUT'); s.destroy(); process.exit(3); });",
    ].join("\n"),
  );
  return path;
}

// Writes a "parent" script that itself calls `child_process.spawnSync` to launch the connect
// probe as a genuinely forked grandchild — the same mechanism OpenCode uses to spawn `git`
// (posix_spawn/fork, not a shell's exec-in-place optimization). If `(deny process-fork)` is
// present, `spawnSync` fails closed with an EPERM-shaped `result.error` and the parent reports
// SPAWN_DENIED instead of relaying the child's probe result — this is what makes the test able to
// detect a reinstated fork denial, unlike a `/bin/sh -c` single-command wrapper, which macOS's
// shell execs in place without ever calling fork().
function writeForkingParentScript(dir: string, childScriptPath: string): string {
  const path = join(dir, "fork-parent.cjs");
  writeFileSync(
    path,
    [
      "const { spawnSync } = require('child_process');",
      `const result = spawnSync(process.execPath, ['${childScriptPath}'], { timeout: 5000 });`,
      "if (result.error) { process.stdout.write('SPAWN_DENIED'); process.exit(4); }",
      "process.stdout.write(result.stdout ? result.stdout.toString('utf8') : 'NO_OUTPUT');",
      "process.exit(result.status === null ? 5 : result.status);",
    ].join("\n"),
  );
  return path;
}

async function listenEphemeral(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("ephemeral-listen-failed"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

describe("real OS-level gateway confinement (macOS Seatbelt, #2951)", () => {
  const seatbeltAvailable = probeBackends().seatbelt;
  const platformIsDarwin = currentPlatform() === "darwin";
  const canProveOnThisHost = platformIsDarwin && seatbeltAvailable;

  it.skipIf(!canProveOnThisHost)(
    "denies a hostile loopback destination while permitting only the configured gateway port",
    async () => {
      const gateway = await listenEphemeral();
      const hostile = await listenEphemeral();
      try {
        const policy = createRuntimeGatewayConfinement({
          ...input,
          gatewayUrl: `http://127.0.0.1:${String(gateway.port)}/gateway`,
        });

        // Failing-before proof: with no seatbelt wrapper at all, the hostile destination is
        // reachable. The confinement assertions below are meaningful only because this succeeds.
        const unconfined = run(process.execPath, ["-e", connectSnippet(hostile.port)]);
        expect(unconfined.stdout).toBe("CONNECTED");

        const hostileWrapped = buildRuntimeGatewaySeatbeltCommand(policy, process.execPath, [
          "-e",
          connectSnippet(hostile.port),
        ]);
        const denied = run(hostileWrapped.command, hostileWrapped.args);
        expect(["BLOCKED", "TIMEOUT"]).toContain(denied.stdout);
        expect(denied.stdout).not.toBe("CONNECTED");

        const gatewayWrapped = buildRuntimeGatewaySeatbeltCommand(policy, process.execPath, [
          "-e",
          connectSnippet(gateway.port),
        ]);
        const allowed = run(gatewayWrapped.command, gatewayWrapped.args);
        expect(allowed.stdout).toBe("CONNECTED");
        expect(allowed.status).toBe(0);
      } finally {
        gateway.server.close();
        hostile.server.close();
      }
    },
    20_000,
  );

  // Real OS-level proof that removing `(deny process-fork)` (#3390: OpenCode forks `git` for its
  // own session/history endpoints) does not weaken egress confinement: on macOS a Seatbelt profile
  // is inherited by every descendant process, so a genuinely FORKED grandchild (spawned from
  // *inside* the sandboxed process via `child_process.spawnSync`, the same posix_spawn/fork path
  // OpenCode uses to run `git` — not a shell's `-c` single-command exec-in-place, which never
  // calls fork() and so cannot detect a reinstated denial) must still be denied a hostile loopback
  // destination and permitted only the configured gateway port. If `(deny process-fork)` were
  // reinstated, `spawnSync` inside the sandboxed parent would fail closed and this test would fail
  // with a SPAWN_DENIED result instead of the expected connect outcome.
  it.skipIf(!canProveOnThisHost)(
    "denies a hostile loopback destination from a forked grandchild while permitting the gateway port",
    async () => {
      const gateway = await listenEphemeral();
      const hostile = await listenEphemeral();
      const scriptDir = mkdtempSync(join(tmpdir(), "keiko-fork-inherit-"));
      try {
        const policy = createRuntimeGatewayConfinement({
          ...input,
          gatewayUrl: `http://127.0.0.1:${String(gateway.port)}/gateway`,
        });

        const hostileScript = writeForkConnectScript(scriptDir, hostile.port);
        const hostileParent = writeForkingParentScript(scriptDir, hostileScript);
        const hostileWrapped = buildRuntimeGatewaySeatbeltCommand(policy, process.execPath, [
          hostileParent,
        ]);
        const denied = run(hostileWrapped.command, hostileWrapped.args);
        expect(["BLOCKED", "TIMEOUT"]).toContain(denied.stdout);
        expect(denied.stdout).not.toBe("CONNECTED");
        expect(denied.stdout).not.toBe("SPAWN_DENIED");

        const gatewayScript = writeForkConnectScript(scriptDir, gateway.port);
        const gatewayParent = writeForkingParentScript(scriptDir, gatewayScript);
        const gatewayWrapped = buildRuntimeGatewaySeatbeltCommand(policy, process.execPath, [
          gatewayParent,
        ]);
        const allowed = run(gatewayWrapped.command, gatewayWrapped.args);
        expect(allowed.stdout).toBe("CONNECTED");
        expect(allowed.status).toBe(0);
      } finally {
        gateway.server.close();
        hostile.server.close();
        rmSync(scriptDir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("records a closed skip reason when the real OS proof cannot run on this host", () => {
    if (canProveOnThisHost) {
      expect(canProveOnThisHost).toBe(true);
      return;
    }
    const reason = !platformIsDarwin
      ? `non-darwin platform (${currentPlatform()})`
      : "sandbox-exec is not on PATH";
    note(
      `[gateway-confinement-proof] skipped: ${reason}. The real seatbelt OS-level proof runs on ` +
        "macOS hosts only (ADR-0043/ADR-0140 macOS-only scope; Linux/Windows tracked separately).",
    );
    expect(canProveOnThisHost).toBe(false);
  });
});
