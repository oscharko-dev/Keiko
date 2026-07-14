import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEBUG_CAPSULE_RUNTIME_MOUNT,
  planStrictDebugCapsule,
  type DebugCapsuleImmutableMount,
  type StrictDebugCapsulePlan,
} from "./debug-capsule.js";
import { isExecutableOnPath } from "./probe.js";

const SAME_CAPSULE_MARKER = "SAME_CAPSULE_LOOPBACK_OK";
const SEPARATE_CAPSULE_MARKER = "SEPARATE_CAPSULE_BLOCKED";
const CHILD_SNIPPET = [
  "const net=require('net');",
  "const server=net.createServer(socket=>socket.end());",
  "server.listen(0,'127.0.0.1',()=>{",
  "const address=server.address();if(address===null||typeof address==='string')process.exit(2);",
  "const client=net.connect({host:'127.0.0.1',port:address.port},()=>{",
  "process.stdout.write('SAME_CAPSULE_LOOPBACK_OK');client.end();server.close();",
  "});client.setTimeout(5000,()=>process.exit(3));client.on('error',()=>process.exit(4));",
  "});",
].join("");

interface Fixture {
  readonly executionRoot: string;
  readonly runtimeDirectory: string;
  readonly bubblewrap: string;
  readonly mounts: readonly DebugCapsuleImmutableMount[];
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resolveBubblewrap(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, "bwrap");
    try {
      const scopedEnvironment = { ...process.env, PATH: directory };
      if (statSync(candidate).isFile() && isExecutableOnPath("bwrap", scopedEnvironment)) {
        return realpathSync(candidate);
      }
    } catch {
      // Continue through the already-qualified PATH entries.
    }
  }
  throw new Error("Linux requires qualified Bubblewrap");
}

function runtimeFiles(): readonly string[] {
  const result = spawnSync("ldd", [process.execPath], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0) return [];
  const matches = result.stdout.match(/\/[A-Za-z0-9_./+~-]+/gu) ?? [];
  return [...new Set(matches)];
}

function immutableRuntimeMounts(): readonly DebugCapsuleImmutableMount[] {
  const adapter = realpathSync(process.execPath);
  return [
    { hostPath: adapter, capsulePath: "/opt/keiko-debug/adapter", identityDigest: digest(adapter) },
    ...runtimeFiles().map((path) => ({
      hostPath: path,
      capsulePath: path,
      identityDigest: digest(path),
    })),
  ];
}

function createFixture(): Fixture {
  return {
    executionRoot: realpathSync(mkdtempSync(join(tmpdir(), "keiko-debug-root-"))),
    runtimeDirectory: realpathSync(mkdtempSync(join(tmpdir(), "keiko-debug-runtime-"))),
    bubblewrap: resolveBubblewrap(),
    mounts: immutableRuntimeMounts(),
  };
}

function cleanupFixture(fixture: Fixture): void {
  rmSync(fixture.executionRoot, { recursive: true, force: true });
  rmSync(fixture.runtimeDirectory, { recursive: true, force: true });
}

function capsulePlan(fixture: Fixture, adapterArgs: readonly string[]): StrictDebugCapsulePlan {
  return planStrictDebugCapsule({
    platform: "linux",
    availability: {
      bubblewrap: true,
      unshare: true,
      seatbelt: false,
      docker: false,
      podman: false,
    },
    backendExecutables: { bubblewrap: fixture.bubblewrap },
    backendExecutableIdentityDigests: { bubblewrap: digest(fixture.bubblewrap) },
    executionRoot: fixture.executionRoot,
    executionRootIdentityDigest: digestText(fixture.executionRoot),
    runtimeHostDirectory: fixture.runtimeDirectory,
    runtimeCapsuleDirectory: DEBUG_CAPSULE_RUNTIME_MOUNT,
    runtimeMountIdentityDigest: digestText(fixture.runtimeDirectory),
    runtimeMountQualified: true,
    adapterCapsuleExecutable: "/opt/keiko-debug/adapter",
    adapterArgs,
    immutableMounts: fixture.mounts,
    runtimeIdentityDigest: digestText(process.execPath),
  });
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function spawnPlan(plan: StrictDebugCapsulePlan): ChildProcessWithoutNullStreams {
  return spawn(plan.command, [...plan.args], { stdio: "pipe" });
}

function outputLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let diagnostics = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const end = output.indexOf("\n");
      if (end >= 0) resolve(output.slice(0, end));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`capsule exited before output: ${String(code)}: ${diagnostics}`));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function waitForStableFile(path: string, stableMs = 200, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = fileSize(path);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const current = fileSize(path);
    if (current !== previous) {
      previous = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return;
    }
  }
  throw new Error("heartbeat did not stop");
}

describe("Linux-authoritative strict debug capsule", () => {
  it.runIf(process.platform === "linux")(
    "uses the emitted backend argv for positive same-capsule loopback reachability",
    () => {
      const fixture = createFixture();
      try {
        const plan = capsulePlan(fixture, ["-e", CHILD_SNIPPET]);
        const result = spawnSync(plan.command, [...plan.args], {
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(SAME_CAPSULE_MARKER);
        expect(plan.command).toBe(fixture.bubblewrap);
        expect(plan.initMechanism).toBe("bubblewrapPid1Reaper");
      } finally {
        cleanupFixture(fixture);
      }
    },
    30_000,
  );

  it.runIf(process.platform === "linux")(
    "blocks loopback reachability between two separately emitted capsule wrappers",
    async () => {
      const listenerFixture = createFixture();
      const clientFixture = createFixture();
      const listenerPlan = capsulePlan(listenerFixture, [
        "-e",
        "const n=require('net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>process.stdout.write(String(s.address().port)+'\\n'));setInterval(()=>{},1000);",
      ]);
      const listener = spawnPlan(listenerPlan);
      try {
        const port = await outputLine(listener);
        const clientCode = `const n=require('net');const s=n.connect({host:'127.0.0.1',port:${port}},()=>process.exit(9));s.on('error',()=>{process.stdout.write('${SEPARATE_CAPSULE_MARKER}');process.exit(0);});s.setTimeout(3000,()=>process.exit(8));`;
        const clientPlan = capsulePlan(clientFixture, ["-e", clientCode]);
        const result = spawnSync(clientPlan.command, [...clientPlan.args], {
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(SEPARATE_CAPSULE_MARKER);
      } finally {
        listener.kill("SIGKILL");
        await waitForExit(listener).catch(() => null);
        cleanupFixture(listenerFixture);
        cleanupFixture(clientFixture);
      }
    },
    30_000,
  );

  it.runIf(process.platform === "linux")(
    "kills a hostile setsid descendant when the Bubblewrap capsule is terminated",
    async () => {
      const fixture = createFixture();
      const heartbeat = join(fixture.runtimeDirectory, "heartbeat");
      const childCode = `const f=require('fs');const p='${DEBUG_CAPSULE_RUNTIME_MOUNT}/heartbeat';f.writeFileSync(p,'x');setInterval(()=>f.appendFileSync(p,'x'),25);`;
      const parentCode = `const {spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'}).unref();process.stdout.write('READY\\n');setInterval(()=>{},1000);`;
      const capsule = spawnPlan(capsulePlan(fixture, ["-e", parentCode]));
      try {
        expect(await outputLine(capsule)).toBe("READY");
        await waitUntil(() => {
          try {
            return readFileSync(heartbeat, "utf8").length > 1;
          } catch {
            return false;
          }
        });
        capsule.kill("SIGKILL");
        await waitForExit(capsule);
        await waitForStableFile(heartbeat);
      } finally {
        if (capsule.exitCode === null) capsule.kill("SIGKILL");
        cleanupFixture(fixture);
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "linux")(
    "records that Linux is authoritative while non-Linux hosts remain hermetic",
    () => {
      expect(process.platform).not.toBe("linux");
    },
  );
});
