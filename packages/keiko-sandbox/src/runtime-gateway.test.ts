import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRuntimeGatewaySeatbeltCommand as buildRuntimeGatewaySeatbeltCommandCore,
  createRuntimeGatewayConfinement,
  isRuntimeGatewayConfinement,
  type RuntimeGatewayConfinement,
  type RuntimeGatewayConfinementInput,
} from "./runtime-gateway.js";
import { resolveDarwinGitExecutable } from "./darwin-git.js";
import { nativeToolchainReadRoots } from "./native-toolchain-roots.js";
import { currentPlatform, probeBackends } from "./probe.js";
import {
  copyRuntimeGatewayFilesystem,
  OWN_PROCESS_TARGETS_SEATBELT_RULE,
} from "./seatbelt-execution-root.js";
import type { RuntimeGatewayFilesystem } from "./types.js";

const input: RuntimeGatewayConfinementInput = {
  gatewayUrl: "http://127.0.0.1:1983/api/coding-sidecar/gateway",
  runId: "run-2951",
  treeBindingId: "a".repeat(64),
  envelopeDigest: "b".repeat(64),
  runtimeArtifactDigest: "c".repeat(64),
  modelProfileDigest: "d".repeat(64),
};
const gitExecutable =
  currentPlatform() === "darwin" ? resolveDarwinGitExecutable().path : "/usr/bin/git";

function buildRuntimeGatewaySeatbeltCommand(
  policy: RuntimeGatewayConfinement,
  command: string,
  args: readonly string[],
): ReturnType<typeof buildRuntimeGatewaySeatbeltCommandCore> {
  return buildRuntimeGatewaySeatbeltCommandCore(policy, command, args, gitExecutable);
}

describe("long-lived gateway network confinement", () => {
  it.each(["object", "array"])("refuses a revoked %s filesystem", (kind) => {
    const revoked = Proxy.revocable(kind === "object" ? {} : [], {});
    revoked.revoke();
    expect(copyRuntimeGatewayFilesystem(revoked.proxy)).toBeUndefined();
  });

  it("rejects a revoked filesystem capability with the closed policy error", () => {
    const revoked = Proxy.revocable(
      {
        workspaceRoot: "/accepted/workspace",
        workspaceAccess: "read-only" as const,
        privateStateRoot: "/private/state",
        runtimeReadRoot: "/immutable/runtime",
      },
      {},
    );
    revoked.revoke();
    expect(() => createRuntimeGatewayConfinement({ ...input, filesystem: revoked.proxy })).toThrow(
      "runtime-gateway-policy-invalid",
    );
  });

  it("rejects writable private state containing the workspace or overlapping immutable runtime", () => {
    const filesystem = {
      workspaceRoot: "/accepted/workspace",
      workspaceAccess: "read-only" as const,
      privateStateRoot: "/private/state",
      runtimeReadRoot: "/immutable/runtime",
    };
    for (const changed of [
      { ...filesystem, privateStateRoot: "/accepted" },
      { ...filesystem, privateStateRoot: "/immutable" },
      { ...filesystem, privateStateRoot: "/immutable/runtime/state" },
      { ...filesystem, privateStateRoot: filesystem.runtimeReadRoot },
    ])
      expect(() => createRuntimeGatewayConfinement({ ...input, filesystem: changed })).toThrow();
  });
  it.skipIf(currentPlatform() !== "darwin")(
    "owns and binds the closed native filesystem capability without widening legacy policies",
    () => {
      const filesystem = {
        workspaceRoot: "/accepted/workspace",
        workspaceAccess: "read-only" as const,
        privateStateRoot: "/private/native-state",
        runtimeReadRoot: "/immutable/native-runtime",
      };
      const policy = createRuntimeGatewayConfinement({ ...input, filesystem });
      expect(policy.filesystem).toEqual(filesystem);
      expect(Object.isFrozen(policy.filesystem)).toBe(true);
      expect(policy.policyDigest).not.toBe(createRuntimeGatewayConfinement(input).policyDigest);
      filesystem.workspaceRoot = "/replaced/workspace";
      expect(policy.filesystem?.workspaceRoot).toBe("/accepted/workspace");
      expect(
        isRuntimeGatewayConfinement({
          ...policy,
          filesystem: { ...policy.filesystem, privateStateRoot: "/other/state" },
        }),
      ).toBe(false);
      expect(
        isRuntimeGatewayConfinement({
          ...policy,
          filesystem: { ...policy.filesystem, rawOutput: "synthetic" },
        }),
      ).toBe(false);
    },
  );

  it("records the native egress disposition, fails closed without one and refuses it elsewhere", () => {
    const filesystem = {
      workspaceRoot: "/accepted/workspace",
      workspaceAccess: "read-write" as const,
      privateStateRoot: "/private/state",
      runtimeReadRoot: "/immutable/runtime",
    };
    const native = { ...input, profile: "keiko-native" as const, filesystem };
    const absent = createRuntimeGatewayConfinement(native);
    const below = createRuntimeGatewayConfinement({ ...native, egress: "loopback-only" });
    const full = createRuntimeGatewayConfinement({ ...native, egress: "inherited" });
    expect(absent.egress).toBe("loopback-only");
    expect(absent).toEqual(below);
    expect(full.egress).toBe("inherited");
    expect(full.policyDigest).not.toBe(below.policyDigest);
    expect(isRuntimeGatewayConfinement(full)).toBe(true);
    // A tampered disposition, or one grafted onto another profile, no longer verifies.
    expect(isRuntimeGatewayConfinement({ ...below, egress: "inherited" })).toBe(false);
    expect(isRuntimeGatewayConfinement({ ...below, egress: "open" })).toBe(false);
    const { egress: _removed, ...withoutEgress } = below;
    expect(isRuntimeGatewayConfinement(withoutEgress)).toBe(false);
    expect(() => createRuntimeGatewayConfinement({ ...native, egress: "open" as never })).toThrow(
      "runtime-gateway-policy-invalid",
    );
    expect(() => createRuntimeGatewayConfinement({ ...input, egress: "inherited" })).toThrow(
      "runtime-gateway-policy-invalid",
    );
    expect(createRuntimeGatewayConfinement(input)).not.toHaveProperty("egress");
  });

  it("binds the toolchain read roots into the policy digest", () => {
    const filesystem = {
      workspaceRoot: "/accepted/workspace",
      workspaceAccess: "read-write" as const,
      privateStateRoot: "/private/state",
      runtimeReadRoot: "/immutable/runtime",
    };
    const native = { ...input, profile: "keiko-native" as const };
    const plain = createRuntimeGatewayConfinement({ ...native, filesystem });
    const withRoots = createRuntimeGatewayConfinement({
      ...native,
      filesystem: { ...filesystem, toolchainReadRoots: ["/opt/homebrew"] },
    });
    expect(withRoots.policyDigest).not.toBe(plain.policyDigest);
    expect(
      isRuntimeGatewayConfinement({
        ...withRoots,
        filesystem: { ...filesystem, toolchainReadRoots: ["/opt/other"] },
      }),
    ).toBe(false);
  });

  it("binds the protected write roots into the policy digest and refuses roots outside the writable ones", () => {
    const filesystem = {
      workspaceRoot: "/accepted/workspace",
      workspaceAccess: "read-write" as const,
      privateStateRoot: "/private/state",
      runtimeReadRoot: "/immutable/runtime",
    };
    const native = { ...input, profile: "keiko-native" as const };
    const plain = createRuntimeGatewayConfinement({ ...native, filesystem });
    const protectedRoots = ["/private/state/config/opencode"];
    const guarded = createRuntimeGatewayConfinement({
      ...native,
      filesystem: { ...filesystem, protectedWriteRoots: protectedRoots },
    });
    expect(guarded.policyDigest).not.toBe(plain.policyDigest);
    expect(guarded.filesystem?.protectedWriteRoots).toEqual(protectedRoots);
    expect(
      isRuntimeGatewayConfinement({
        ...guarded,
        filesystem: { ...filesystem, protectedWriteRoots: ["/private/state/config/other"] },
      }),
    ).toBe(false);
    expect(isRuntimeGatewayConfinement({ ...guarded, filesystem: { ...filesystem } })).toBe(false);
    // A protected root is a strict descendant of a writable root: anything else cannot guard what
    // the profile writes, and the whole writable root would make the run unusable.
    for (const invalid of [
      ["/elsewhere/config"],
      ["/private/state"],
      ["/accepted/workspace"],
      ["/private"],
      ["relative/config"],
      ["/"],
      [`/private/state/${"x".repeat(5_000)}`],
      Array.from({ length: 65 }, (_, index) => `/private/state/config/${String(index)}`),
    ])
      expect(() =>
        createRuntimeGatewayConfinement({
          ...native,
          filesystem: { ...filesystem, protectedWriteRoots: invalid },
        }),
      ).toThrow("runtime-gateway-policy-invalid");
    // The mapped gateway profile never writes the workspace and has no use for the field.
    expect(() =>
      createRuntimeGatewayConfinement({
        ...input,
        filesystem: {
          ...filesystem,
          workspaceAccess: "read-only",
          protectedWriteRoots: protectedRoots,
        },
      }),
    ).toThrow("runtime-gateway-policy-invalid");
  });

  it("binds the link-free plan roots into the policy digest and admits them in the private state only", () => {
    const filesystem = {
      workspaceRoot: "/accepted/workspace",
      workspaceAccess: "read-write" as const,
      privateStateRoot: "/private/state",
      runtimeReadRoot: "/immutable/runtime",
    };
    const native = { ...input, profile: "keiko-native" as const };
    const plain = createRuntimeGatewayConfinement({ ...native, filesystem });
    const roots = ["/private/state/home/.opencode/plan"];
    const guarded = createRuntimeGatewayConfinement({
      ...native,
      filesystem: { ...filesystem, linkFreeWriteRoots: roots },
    });
    expect(guarded.policyDigest).not.toBe(plain.policyDigest);
    expect(guarded.filesystem?.linkFreeWriteRoots).toEqual(roots);
    // A link-free root holds private notes: never the workspace, never the whole private state.
    for (const invalid of [
      ["/accepted/workspace/notes"],
      ["/private/state"],
      ["/elsewhere/plan"],
      ["relative/plan"],
      Array.from({ length: 9 }, (_, index) => `/private/state/plan-${String(index)}`),
    ])
      expect(() =>
        createRuntimeGatewayConfinement({
          ...native,
          filesystem: { ...filesystem, linkFreeWriteRoots: invalid },
        }),
      ).toThrow("runtime-gateway-policy-invalid");
    expect(() =>
      createRuntimeGatewayConfinement({
        ...input,
        filesystem: { ...filesystem, workspaceAccess: "read-only", linkFreeWriteRoots: roots },
      }),
    ).toThrow("runtime-gateway-policy-invalid");
  });

  it("refuses prototype-bearing filesystem input and a writable ancestor with a dot-prefix child", () => {
    const filesystem = {
      workspaceRoot: "/private/state/..accepted",
      workspaceAccess: "read-only" as const,
      privateStateRoot: "/private/state",
      runtimeReadRoot: "/immutable/runtime",
    };
    expect(() => createRuntimeGatewayConfinement({ ...input, filesystem })).toThrow();
    const prototypeBearing = { ...filesystem, workspaceRoot: "/accepted" };
    Object.setPrototypeOf(prototypeBearing, { extra: true });
    expect(() =>
      createRuntimeGatewayConfinement({ ...input, filesystem: prototypeBearing }),
    ).toThrow();
  });

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

  // Regression pin (#3390 live run): fork remains available for OpenCode's git handshake, while a
  // deny-by-default process-exec rule prevents the sidecar from selecting arbitrary child binaries.
  it("allows fork only into the runtime and the exact attested Git executable (#3390)", () => {
    const policy = createRuntimeGatewayConfinement(input);
    const profile = buildRuntimeGatewaySeatbeltCommand(policy, "/trusted/opencode", ["serve"])
      .args[1];
    expect(profile).not.toContain("process-fork");
    expect(profile).toContain("(deny process-exec)");
    expect(profile).toContain('(literal "/trusted/opencode")');
    expect(profile).toContain(`(literal ${JSON.stringify(gitExecutable)})`);
    expect(profile).not.toContain("Xcode.app");
    expect(profile).not.toContain("(allow process-exec)");
    for (const denied of ["network*", "mach-lookup", "appleevent-send", "lsopen"])
      expect(profile).toContain(`(deny ${denied})`);
  });

  // #3901 review (P1) pin: the native profile starts from `allow default`, so its process
  // authority is exactly the rule the execution-root profile owns. A widened target, a second
  // `signal` or `process-info*` clause, or a copy of the rule would each fail here.
  it.each(["loopback-only", "inherited"] as const)(
    "native profile (%s) carries the shared own-sandbox process rule and no other signal rule",
    (egress) => {
      const policy = createRuntimeGatewayConfinement({
        ...input,
        profile: "keiko-native",
        egress,
        filesystem: {
          workspaceRoot: "/accepted/workspace",
          workspaceAccess: "read-write",
          privateStateRoot: "/private/state",
          runtimeReadRoot: "/immutable/runtime",
        },
      });
      const wrapped = buildRuntimeGatewaySeatbeltCommand(policy, "/trusted/opencode", ["serve"]);
      const profile = wrapped.args[1] ?? "";
      expect(OWN_PROCESS_TARGETS_SEATBELT_RULE).toBe(
        "(deny signal process-info*)(allow signal process-info* (target self) (target same-sandbox))",
      );
      expect(profile.split(OWN_PROCESS_TARGETS_SEATBELT_RULE)).toHaveLength(2);
      expect(profile.replace(OWN_PROCESS_TARGETS_SEATBELT_RULE, "")).not.toMatch(
        /signal|process-info/u,
      );
      expect(profile.indexOf("(allow default)")).toBeLessThan(
        profile.indexOf(OWN_PROCESS_TARGETS_SEATBELT_RULE),
      );
    },
  );

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

interface DetailedRun extends ChildRun {
  readonly stderr: string;
}

function runDetailed(
  command: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
  cwd?: string,
): DetailedRun {
  const result = spawnSync(command, [...args], {
    timeout: 10_000,
    encoding: "utf8",
    ...(env === undefined ? {} : { env }),
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (result.error !== undefined) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function run(
  command: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
  cwd?: string,
): ChildRun {
  const { status, stdout } = runDetailed(command, args, env, cwd);
  return { status, stdout };
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

// ---- #3897: real-Seatbelt proofs for the native read boundary and the mode-aware egress ----

type NativeEgress = "inherited" | "loopback-only";

interface NativeProofTree {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly privateStateRoot: string;
  readonly canary: string;
  readonly sibling: string;
  readonly temporaryCanary: string;
  readonly cleanup: () => void;
}

// The tree lives under the HOME directory on purpose: no native rule opens it, whereas the
// per-user temp tree is readable and writable for toolchains. A canary there is the "unrelated
// file outside the task workspace" of the finding, and it is removed in `cleanup`.
function createNativeProofTree(): NativeProofTree {
  const root = realpathSync(mkdtempSync(join(homedir(), ".keiko-native-proof-")));
  const workspaceRoot = join(root, "workspace");
  const privateStateRoot = join(root, "state", "run-1");
  const canaryDirectory = join(root, "outside");
  const canary = join(canaryDirectory, "canary.txt");
  const sibling = join(root, "sibling.txt");
  // The system temporary directories are shared scratch that belongs to other processes too: a
  // file there is as unrelated to the task as any file outside the workspace.
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-proof-tmp-")));
  const temporaryCanary = join(temporaryRoot, "canary.txt");
  writeFileSync(temporaryCanary, "synthetic-temporary-canary");
  mkdirSync(join(workspaceRoot, "src"), { recursive: true });
  mkdirSync(join(workspaceRoot, "config"));
  mkdirSync(join(workspaceRoot, ".aws"));
  mkdirSync(privateStateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(canaryDirectory);
  writeFileSync(canary, "synthetic-canary");
  writeFileSync(sibling, "synthetic-sibling");
  writeFileSync(join(workspaceRoot, "src", "app.js"), "module.exports = 1;\n");
  writeFileSync(join(workspaceRoot, ".env"), "SYNTHETIC_ENV=1\n");
  writeFileSync(join(workspaceRoot, ".env.example"), "SYNTHETIC_ENV=\n");
  writeFileSync(join(workspaceRoot, "config", ".env.local"), "SYNTHETIC_ENV=2\n");
  writeFileSync(join(workspaceRoot, ".aws", "credentials"), "synthetic\n");
  writeFileSync(join(workspaceRoot, "package.json"), '{"name":"proof","version":"1.0.0"}');
  symlinkSync(canary, join(workspaceRoot, "escape.txt"));
  symlinkSync(canaryDirectory, join(workspaceRoot, "escape-dir"));
  spawnSync(gitExecutable, ["init", "-q", workspaceRoot], {
    env: { HOME: privateStateRoot, PATH: dirname(gitExecutable), GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return {
    root,
    workspaceRoot,
    privateStateRoot,
    canary,
    sibling,
    temporaryCanary,
    cleanup: (): void => {
      rmSync(root, { recursive: true, force: true });
      rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
}

/** The run's OpenCode configuration directory, laid out the way the composition materializes it. */
function protectedConfigProbes(tree: NativeProofTree): Readonly<Record<string, string>> {
  const config = join(tree.privateStateRoot, "config", "opencode");
  const plugin = join(config, "plugins", "keiko_native_policy.ts");
  const replacement = join(tree.workspaceRoot, "replacement.ts");
  const alias = join(tree.workspaceRoot, "plugin-alias.ts");
  const parent = join(tree.privateStateRoot, "config");
  return {
    pluginRead: readFact(plugin),
    siblingConfigWrite: `fs.writeFileSync(${JSON.stringify(join(parent, "sibling.json"))}, 'x')`,
    privateStateWrite: `fs.writeFileSync(${JSON.stringify(join(tree.privateStateRoot, "note.txt"))}, 'x')`,
    workspaceWrite: `fs.writeFileSync(${JSON.stringify(join(tree.workspaceRoot, "note.txt"))}, 'x')`,
    pluginOverwrite: `fs.writeFileSync(${JSON.stringify(plugin)}, 'x')`,
    pluginAppend: `fs.appendFileSync(${JSON.stringify(plugin)}, 'x')`,
    pluginChmod: `fs.chmodSync(${JSON.stringify(plugin)}, 0o644)`,
    pluginReplaceByRename: `fs.writeFileSync(${JSON.stringify(replacement)}, 'x'); fs.renameSync(${JSON.stringify(replacement)}, ${JSON.stringify(plugin)})`,
    hardLinkCreate: `fs.linkSync(${JSON.stringify(plugin)}, ${JSON.stringify(join(tree.workspaceRoot, "plugin-link.ts"))})`,
    hardLinkedAliasWrite: `fs.linkSync(${JSON.stringify(plugin)}, ${JSON.stringify(alias)}); fs.writeFileSync(${JSON.stringify(alias)}, 'x')`,
    configCreate: `fs.writeFileSync(${JSON.stringify(join(config, "plugins", "planted.ts"))}, 'x')`,
    configMkdir: `fs.mkdirSync(${JSON.stringify(join(config, "agents"))})`,
    settingsOverwrite: `fs.writeFileSync(${JSON.stringify(join(config, "opencode.json"))}, '{}')`,
    shellOverwrite: shellFact(`echo x > ${JSON.stringify(plugin)}`, tree.workspaceRoot),
    shellRemoveAndRecreate: shellFact(
      `rm -f ${JSON.stringify(plugin)} && echo x > ${JSON.stringify(plugin)}`,
      tree.workspaceRoot,
    ),
    pluginUnlink: `fs.unlinkSync(${JSON.stringify(plugin)})`,
    configDirectoryRename: `fs.renameSync(${JSON.stringify(config)}, ${JSON.stringify(join(parent, "opencode-moved"))})`,
    configParentRename: `fs.renameSync(${JSON.stringify(parent)}, ${JSON.stringify(join(tree.privateStateRoot, "config-moved"))})`,
  };
}

function protectedConfigRun(guard: "protected" | undefined): unknown {
  const tree = createNativeProofTree();
  try {
    const plugins = join(tree.privateStateRoot, "config", "opencode", "plugins");
    mkdirSync(plugins, { recursive: true });
    writeFileSync(join(plugins, "keiko_native_policy.ts"), "export default {};\n");
    writeFileSync(join(plugins, "..", "opencode.json"), "{}");
    const policy = nativeConfinement(
      tree,
      "loopback-only",
      1983,
      guard === undefined
        ? {}
        : { protectedWriteRoots: [join(tree.privateStateRoot, "config", "opencode")] },
    );
    const result = runNative(tree, policy, factScript(protectedConfigProbes(tree)));
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  } finally {
    tree.cleanup();
  }
}

/** The plan agent's private notes directory, laid out the way the composition materializes it. */
function linkFreePlanProbes(tree: NativeProofTree): Readonly<Record<string, string>> {
  const home = join(tree.privateStateRoot, "home");
  const dotOpencode = join(home, ".opencode");
  const plan = join(dotOpencode, "plan");
  const readme = join(tree.workspaceRoot, "README.md");
  return {
    noteWrite: `fs.writeFileSync(${JSON.stringify(join(plan, "plan.md"))}, 'note')`,
    noteRewrite: `fs.writeFileSync(${JSON.stringify(join(plan, "plan.md"))}, 'note 2')`,
    noteDirectory: `fs.mkdirSync(${JSON.stringify(join(plan, "drafts"))})`,
    symlinkToWorkspace: `fs.symlinkSync(${JSON.stringify(readme)}, ${JSON.stringify(join(plan, "link.md"))})`,
    shellSymlink: shellFact(
      `ln -s ${JSON.stringify(readme)} ${JSON.stringify(join(plan, "sh-link.md"))}`,
      tree.workspaceRoot,
    ),
    hardLinkToWorkspace: `fs.linkSync(${JSON.stringify(readme)}, ${JSON.stringify(join(plan, "hard.md"))})`,
    planRename: `fs.renameSync(${JSON.stringify(plan)}, ${JSON.stringify(join(dotOpencode, "plan-moved"))})`,
    ancestorRename: `fs.renameSync(${JSON.stringify(dotOpencode)}, ${JSON.stringify(join(home, "moved"))})`,
    ancestorSymlinkSwap: `fs.rmSync(${JSON.stringify(dotOpencode)}, { recursive: true, force: true }); fs.symlinkSync(${JSON.stringify(tree.workspaceRoot)}, ${JSON.stringify(dotOpencode)})`,
    homeEntryWrite: `fs.writeFileSync(${JSON.stringify(join(home, "other.txt"))}, 'x')`,
  };
}

function linkFreePlanRun(guard: "link-free" | undefined): unknown {
  const tree = createNativeProofTree();
  try {
    const plan = join(tree.privateStateRoot, "home", ".opencode", "plan");
    mkdirSync(plan, { recursive: true });
    writeFileSync(join(tree.workspaceRoot, "README.md"), "workspace readme\n");
    const policy = nativeConfinement(
      tree,
      "loopback-only",
      1983,
      guard === undefined ? {} : { linkFreeWriteRoots: [plan] },
    );
    const result = runNative(tree, policy, factScript(linkFreePlanProbes(tree)));
    expect(result.status).toBe(0);
    expect(readFileSync(join(tree.workspaceRoot, "README.md"), "utf8")).toBe("workspace readme\n");
    return JSON.parse(result.stdout);
  } finally {
    tree.cleanup();
  }
}

function nativeToolchainRoots(): readonly string[] {
  return nativeToolchainReadRoots(
    [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
    homedir(),
  );
}

function nativeConfinement(
  tree: NativeProofTree,
  egress: NativeEgress | undefined,
  gatewayPort = 1983,
  filesystem: Partial<RuntimeGatewayFilesystem> = {},
): RuntimeGatewayConfinement {
  return createRuntimeGatewayConfinement({
    ...input,
    gatewayUrl: `http://127.0.0.1:${String(gatewayPort)}/api/coding-sidecar/gateway`,
    profile: "keiko-native",
    ...(egress === undefined ? {} : { egress }),
    filesystem: {
      workspaceRoot: tree.workspaceRoot,
      workspaceAccess: "read-write",
      privateStateRoot: tree.privateStateRoot,
      runtimeReadRoot: dirname(process.execPath),
      toolchainReadRoots: nativeToolchainRoots(),
      ...filesystem,
    },
  });
}

/** The launcher's environment shape: the run's private state is HOME, the toolchain is on PATH. */
function nativeEnvironment(tree: NativeProofTree): Readonly<Record<string, string>> {
  return {
    HOME: tree.privateStateRoot,
    PATH: [dirname(process.execPath), dirname(gitExecutable), "/usr/bin", "/bin"].join(delimiter),
  };
}

function runNative(
  tree: NativeProofTree,
  policy: RuntimeGatewayConfinement,
  script: string,
): ChildRun {
  const wrapped = buildRuntimeGatewaySeatbeltCommand(policy, process.execPath, ["-e", script]);
  return run(wrapped.command, wrapped.args, nativeEnvironment(tree), tree.workspaceRoot);
}

// One probe per line: `fact name -> expression that throws when the operation is refused`.
function factScript(facts: Readonly<Record<string, string>>): string {
  const body = Object.entries(facts)
    .map(
      ([name, expression]) =>
        `try { ${expression}; facts[${JSON.stringify(name)}] = true; } catch { facts[${JSON.stringify(name)}] = false; }`,
    )
    .join("\n");
  return [
    "const fs = require('node:fs'); const cp = require('node:child_process'); const facts = {};",
    body,
    "process.stdout.write(JSON.stringify(facts));",
  ].join("\n");
}

function readFact(path: string): string {
  return `fs.readFileSync(${JSON.stringify(path)})`;
}

function shellFact(command: string, cwd: string): string {
  return `cp.execFileSync('/bin/sh', ['-c', ${JSON.stringify(command)}], { cwd: ${JSON.stringify(cwd)}, stdio: 'ignore' })`;
}

function nativeReadProbes(tree: NativeProofTree): Readonly<Record<string, string>> {
  const { workspaceRoot: ws } = tree;
  const alias = `/System/Volumes/Data${tree.canary}`;
  return {
    sourceRead: readFact(join(ws, "src", "app.js")),
    sourceWrite: `fs.writeFileSync(${JSON.stringify(join(ws, "src", "edited.js"))}, 'x')`,
    envExampleRead: readFact(join(ws, ".env.example")),
    envRead: readFact(join(ws, ".env")),
    envLocalRead: readFact(join(ws, "config", ".env.local")),
    credentialDirectoryRead: readFact(join(ws, ".aws", "credentials")),
    envWrite: `fs.writeFileSync(${JSON.stringify(join(ws, ".env"))}, 'x')`,
    externalCanaryRead: readFact(tree.canary),
    externalSiblingRead: readFact(tree.sibling),
    temporaryCanaryRead: readFact(tree.temporaryCanary),
    temporaryWrite: `fs.writeFileSync(${JSON.stringify(join(dirname(tree.temporaryCanary), "written.txt"))}, 'x')`,
    symlinkToCanaryRead: readFact(join(ws, "escape.txt")),
    symlinkedDirectoryRead: readFact(join(ws, "escape-dir", "canary.txt")),
    dataVolumeAliasRead: readFact(alias),
    externalDirectoryListing: `fs.readdirSync(${JSON.stringify(dirname(tree.canary))})`,
    shellCatEnv: shellFact("cat .env", ws),
    shellCatCanary: shellFact(`cat ${JSON.stringify(tree.canary)}`, ws),
    shellCatSymlink: shellFact("cat escape.txt", ws),
    shellCatSource: shellFact("cat src/app.js", ws),
    nodeChild: `cp.execFileSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })`,
    gitStatus: `cp.execFileSync(${JSON.stringify(gitExecutable)}, ['status', '--short'], { cwd: ${JSON.stringify(ws)}, stdio: 'ignore' })`,
  };
}

const NATIVE_READ_FACTS = {
  sourceRead: true,
  sourceWrite: true,
  envExampleRead: true,
  envRead: false,
  envLocalRead: false,
  credentialDirectoryRead: false,
  envWrite: false,
  externalCanaryRead: false,
  externalSiblingRead: false,
  temporaryCanaryRead: false,
  temporaryWrite: false,
  symlinkToCanaryRead: false,
  symlinkedDirectoryRead: false,
  dataVolumeAliasRead: false,
  externalDirectoryListing: false,
  shellCatEnv: false,
  shellCatCanary: false,
  shellCatSymlink: false,
  shellCatSource: true,
  nodeChild: true,
  gitStatus: true,
} as const;

function connectProbe(host: string, port: number): string {
  return [
    "const net = require('node:net');",
    `const s = net.connect({ host: ${JSON.stringify(host)}, port: ${String(port)} });`,
    "s.setTimeout(2500);",
    "s.on('connect', () => { process.stdout.write('CONNECTED'); s.destroy(); });",
    "s.on('error', (e) => { process.stdout.write('BLOCKED:' + e.code); });",
    "s.on('timeout', () => { process.stdout.write('TIMEOUT'); s.destroy(); });",
  ].join("");
}

function connectUnixProbe(path: string): string {
  return [
    "const net = require('node:net');",
    `const s = net.connect({ path: ${JSON.stringify(path)} });`,
    "s.setTimeout(2500);",
    "s.on('connect', () => { process.stdout.write('CONNECTED'); s.destroy(); });",
    "s.on('error', (e) => { process.stdout.write('BLOCKED:' + e.code); });",
    "s.on('timeout', () => { process.stdout.write('TIMEOUT'); s.destroy(); });",
  ].join("");
}

// ---- #3901: the confined tree signals and inspects its own processes and no others ----

interface OwnedProcess {
  readonly pid: number;
  /** Settles with the signal that ended the process, or null for a normal exit. */
  readonly exited: Promise<NodeJS.Signals | null>;
  /** Settles once the process has written its first byte of output. */
  readonly announced: Promise<void>;
  readonly running: () => boolean;
  readonly stop: () => void;
}

// The test starts every process it signals or inspects, so a proof never targets a developer
// process: a synthetic `/bin/sleep` stands for any process of the same user outside the run.
async function startOwnedProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<OwnedProcess> {
  const child = spawn(command, [...args], { ...options, stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    child.once("exit", (_code, signal) => {
      resolve(signal);
    });
  });
  const announced = new Promise<void>((resolve) => {
    child.stdout.once("data", () => {
      resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (child.pid === undefined) throw new Error("owned-process-not-started");
  return {
    pid: child.pid,
    exited,
    announced,
    running: () => child.exitCode === null && child.signalCode === null,
    stop: (): void => {
      child.kill("SIGKILL");
    },
  };
}

// What a native shell, an interpreter and the system `kill` can attempt against one process id.
// Signal 0 takes the kernel's and Seatbelt's `signal` authorization without ending the target.
function signalProbes(tree: NativeProofTree, pid: number): Readonly<Record<string, string>> {
  const target = String(pid);
  return {
    interpreterSignal: `process.kill(${target}, 0)`,
    shellBuiltinSignal: shellFact(`kill -0 ${target}`, tree.workspaceRoot),
    systemKillSignal: shellFact(`/bin/kill -0 ${target}`, tree.workspaceRoot),
  };
}

// The cancellation and toolchain paths the native runtime depends on, all inside the run's tree.
function ownProcessProbes(tree: NativeProofTree): Readonly<Record<string, string>> {
  const { workspaceRoot: ws } = tree;
  return {
    shellCancelsItsChild: shellFact("sleep 30 & kill $!; wait", ws),
    shellCancelsASiblingBranch: shellFact('sleep 30 & P=$!; /bin/sh -c "kill -TERM $P"; wait', ws),
    interpreterCancelsItsChild: `const c = cp.spawn('/bin/sleep', ['30'], { stdio: 'ignore' }); process.kill(c.pid, 0); process.kill(c.pid, 'SIGTERM')`,
    interpreterCancelsItsGroup: `const c = cp.spawn('/bin/sh', ['-c', 'sleep 30 & wait'], { detached: true, stdio: 'ignore' }); process.kill(-c.pid, 'SIGTERM')`,
    ownResourceUse: "process.memoryUsage(); process.resourceUsage(); process.cpuUsage()",
    nodeChild: `cp.execFileSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })`,
    gitVersion: `cp.execFileSync(${JSON.stringify(gitExecutable)}, ['--version'], { stdio: 'ignore' })`,
    shellPipeline: shellFact("echo ok | tr a-z A-Z | grep -q OK", ws),
  };
}

// `proc_pidinfo(PROC_PIDTBSDINFO)` through the system Ruby: the per-pid process-info call a shell
// toolchain can make without a setuid binary (`ps` and `top` cannot start under any Seatbelt
// profile, with or without a process rule). The call returns the struct size when allowed and 0
// when the kernel refuses it.
const PROCESS_INFO_RUBY = [
  'require "fiddle"',
  'lib = Fiddle.dlopen("/usr/lib/libproc.dylib")',
  "types = [Fiddle::TYPE_INT, Fiddle::TYPE_INT, Fiddle::TYPE_LONG_LONG, Fiddle::TYPE_VOIDP, Fiddle::TYPE_INT]",
  'info = Fiddle::Function.new(lib["proc_pidinfo"], types, Fiddle::TYPE_INT)',
  "buffer = Fiddle::Pointer.malloc(512)",
  'puts ARGV.map { |pid| info.call(pid.to_i, 3, 0, buffer, 512) > 0 ? "read" : "refused" }.join(",")',
].join("\n");
// Reads, in order: the foreign process, the shell itself and the shell's own child.
const PROCESS_INFO_SHELL =
  'sleep 30 & CHILD=$!; /usr/bin/ruby --disable-gems -e "$1" "$2" $$ $CHILD; kill $CHILD';

describe("real OS-level gateway confinement (macOS Seatbelt, #2951)", () => {
  const seatbeltAvailable = probeBackends().seatbelt;
  const platformIsDarwin = currentPlatform() === "darwin";
  const canProveOnThisHost = platformIsDarwin && seatbeltAvailable;

  it.skipIf(!canProveOnThisHost)(
    "separates readonly workspace and writable native state and denies external symlink access",
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-fs-proof-")));
      const workspaceRoot = join(root, "workspace");
      const privateStateRoot = join(workspaceRoot, ".keiko", "native-state");
      mkdirSync(workspaceRoot);
      mkdirSync(privateStateRoot, { recursive: true, mode: 0o700 });
      expect(
        spawnSync(gitExecutable, ["init", "-q", workspaceRoot], {
          env: {
            HOME: privateStateRoot,
            PATH: dirname(gitExecutable),
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
        }).status,
      ).toBe(0);
      writeFileSync(join(workspaceRoot, "source.txt"), "synthetic");
      writeFileSync(join(root, "outside.txt"), "synthetic");
      symlinkSync(join(root, "outside.txt"), join(workspaceRoot, "escape.txt"));
      const script = filesystemProbe(workspaceRoot, privateStateRoot, root);
      try {
        const control = run("/usr/bin/ruby", ["--disable-gems", "-e", script]);
        expect(JSON.parse(control.stdout)).toMatchObject({ externalRead: true, symlinkRead: true });
        const policy = createRuntimeGatewayConfinement({
          ...input,
          filesystem: {
            workspaceRoot,
            workspaceAccess: "read-only",
            privateStateRoot,
            runtimeReadRoot: "/usr/bin",
          },
        });
        const wrapped = buildRuntimeGatewaySeatbeltCommand(policy, "/usr/bin/ruby", [
          "--disable-gems",
          "-e",
          script,
        ]);
        expect(run(wrapped.command, wrapped.args)).toEqual({
          status: 0,
          stdout: JSON.stringify({
            workspaceRead: true,
            workspaceWrite: false,
            privateStateWrite: true,
            externalRead: false,
            externalWrite: false,
            symlinkRead: false,
            gitHandshakeRead: true,
          }),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // #3897: the native profile keeps the workspace writable and credential roots unreadable while
  // the agent's own toolchains run; proven against the real Seatbelt, not the profile text.
  it.skipIf(!canProveOnThisHost)(
    "native profile: writes the workspace, denies credential roots and lets toolchains run",
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-native-rw-proof-")));
      // The managed task workspace lives INSIDE Keiko's (denied) state directory, as in the
      // packaged product (#3897 lab: OpenCode could not realpath its workspace); so does the run's
      // private state.
      const workspaceRoot = join(root, "keiko-state", "task-workspaces", "ws-1");
      const privateStateRoot = join(root, "keiko-state", "coding-runtime", "run-1");
      const deniedRoot = join(root, "secrets");
      mkdirSync(workspaceRoot, { recursive: true });
      mkdirSync(privateStateRoot, { recursive: true, mode: 0o700 });
      mkdirSync(deniedRoot);
      writeFileSync(join(deniedRoot, "id_rsa"), "synthetic");
      writeFileSync(join(root, "keiko-state", "vault.db"), "synthetic");
      writeFileSync(join(root, "keiko-state", "task-workspaces", "sibling.txt"), "synthetic");
      // The external probe targets the home directory, which no native rule opens; it is removed
      // in `finally`.
      const externalPath = join(homedir(), `.keiko-native-proof-${basename(root)}`);
      const script = [
        "require 'json'",
        "r = {}",
        `begin; File.write(${JSON.stringify(join(workspaceRoot, "edited.txt"))}, 'x'); r['workspaceWrite'] = true; rescue; r['workspaceWrite'] = false; end`,
        `begin; File.realpath(${JSON.stringify(workspaceRoot)}); Dir.children(${JSON.stringify(workspaceRoot)}); r['workspaceRead'] = true; rescue; r['workspaceRead'] = false; end`,
        `begin; File.read(${JSON.stringify(join(deniedRoot, "id_rsa"))}); r['secretRead'] = true; rescue; r['secretRead'] = false; end`,
        `begin; File.read(${JSON.stringify(join(root, "keiko-state", "vault.db"))}); r['stateRead'] = true; rescue; r['stateRead'] = false; end`,
        `begin; File.write(${JSON.stringify(join(privateStateRoot, "state.txt"))}, 'x'); r['privateStateWrite'] = true; rescue; r['privateStateWrite'] = false; end`,
        `begin; File.write(${JSON.stringify(externalPath)}, 'x'); r['externalWrite'] = true; rescue; r['externalWrite'] = false; end`,
        `begin; File.write(${JSON.stringify(join(root, "keiko-state", "other.db"))}, 'x'); r['stateWrite'] = true; rescue; r['stateWrite'] = false; end`,
        `begin; File.stat(${JSON.stringify(join(root, "keiko-state"))}); r['stateAncestorStat'] = true; rescue; r['stateAncestorStat'] = false; end`,
        `begin; Dir.children(${JSON.stringify(join(root, "keiko-state"))}); r['stateAncestorList'] = true; rescue; r['stateAncestorList'] = false; end`,
        `begin; File.open(${JSON.stringify(join(root, "keiko-state", "task-workspaces"))}) { |d| d.close }; File.realpath(${JSON.stringify(join(root, "keiko-state", "task-workspaces"))}); r['workspaceParentOpen'] = true; rescue; r['workspaceParentOpen'] = false; end`,
        `begin; Dir.children(${JSON.stringify(join(root, "keiko-state", "coding-runtime"))}); r['stateSiblingList'] = true; rescue; r['stateSiblingList'] = false; end`,
        `begin; File.read(${JSON.stringify(join(root, "keiko-state", "task-workspaces", "sibling.txt"))}); r['siblingRead'] = true; rescue; r['siblingRead'] = false; end`,
        `r['snapshotInit'] = system('/usr/bin/git', '--git-dir', ${JSON.stringify(join(privateStateRoot, "snapshot"))}, '--work-tree', ${JSON.stringify(workspaceRoot)}, 'init', '-q') == true`,
        "r['childExec'] = system('/bin/echo', 'child', out: File::NULL) == true",
        "print JSON.generate(r)",
      ].join("\n");
      try {
        const policy = createRuntimeGatewayConfinement({
          ...input,
          profile: "keiko-native",
          filesystem: {
            workspaceRoot,
            workspaceAccess: "read-write",
            privateStateRoot,
            runtimeReadRoot: "/usr/bin",
            deniedReadRoots: [deniedRoot, join(root, "keiko-state")],
          },
        });
        expect(policy.profile).toBe("keiko-native");
        const wrapped = buildRuntimeGatewaySeatbeltCommand(policy, "/usr/bin/ruby", [
          "--disable-gems",
          "-e",
          script,
        ]);
        // The launcher gives the runtime a private HOME (`opencodeLaunchProfile`); the read
        // boundary admits no user-home dotfile, so the probe runs the way the product does.
        // ...and from the workspace, which is the runtime's working directory.
        expect(
          run(wrapped.command, wrapped.args, { HOME: privateStateRoot }, workspaceRoot),
        ).toEqual({
          status: 0,
          stdout: JSON.stringify({
            workspaceWrite: true,
            workspaceRead: true,
            secretRead: false,
            stateRead: false,
            privateStateWrite: true,
            externalWrite: false,
            stateWrite: false,
            // Ancestor directory NODES are readable (entry names) so the runtime can canonicalize
            // its workspace; files beside the workspace and sibling subtrees stay denied.
            stateAncestorStat: true,
            stateAncestorList: true,
            workspaceParentOpen: true,
            stateSiblingList: true,
            siblingRead: false,
            snapshotInit: true,
            childExec: true,
          }),
        });
      } finally {
        rmSync(externalPath, { force: true });
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // Finding A (#3897): the native profile is a kernel READ allowlist. The probes run as a shell
  // child, an interpreter and a descendant, because the product's permission policy vets
  // `cat .env` and never routes a shell operand through the native read tool.
  it.skipIf(!canProveOnThisHost).each(["loopback-only", "inherited"] as const)(
    "native profile (%s): denies a workspace .env, an external canary and a symlink to it",
    (egress) => {
      const tree = createNativeProofTree();
      try {
        const script = factScript(nativeReadProbes(tree));
        // Failing-before control: without the wrapper every probe the boundary must refuse
        // succeeds, so the confined result below is the boundary's doing and not the fixture's.
        const control = run(
          process.execPath,
          ["-e", script],
          { HOME: tree.privateStateRoot, PATH: "/usr/bin:/bin" },
          tree.workspaceRoot,
        );
        expect(JSON.parse(control.stdout)).toMatchObject({
          envRead: true,
          envLocalRead: true,
          credentialDirectoryRead: true,
          externalCanaryRead: true,
          externalSiblingRead: true,
          temporaryCanaryRead: true,
          temporaryWrite: true,
          externalDirectoryListing: true,
          symlinkToCanaryRead: true,
          symlinkedDirectoryRead: true,
          dataVolumeAliasRead: true,
          shellCatEnv: true,
          shellCatCanary: true,
        });
        const confined = runNative(tree, nativeConfinement(tree, egress), script);
        expect(confined.status).toBe(0);
        expect(JSON.parse(confined.stdout)).toEqual(NATIVE_READ_FACTS);
      } finally {
        tree.cleanup();
      }
    },
    20_000,
  );

  it.skipIf(!canProveOnThisHost || !existsSync(join(dirname(process.execPath), "npm")))(
    "native profile: npm and node still run from the workspace under the read boundary",
    () => {
      const tree = createNativeProofTree();
      try {
        const script = [
          "const cp = require('node:child_process'); const path = require('node:path');",
          `const npm = path.join(path.dirname(process.execPath), 'npm');`,
          `const out = cp.execFileSync(npm, ['--version'], { cwd: ${JSON.stringify(tree.workspaceRoot)}, encoding: 'utf8' });`,
          "process.stdout.write(/^\\d+[.]\\d+[.]\\d+/.test(out.trim()) ? 'NPM_OK' : 'NPM_BAD');",
        ].join("");
        const result = runNative(tree, nativeConfinement(tree, "loopback-only"), script);
        expect(result.stdout).toBe("NPM_OK");
      } finally {
        tree.cleanup();
      }
    },
    20_000,
  );

  // #3897 review (P1): the policy plugin and the private configuration live inside the writable
  // private state. A prompt-injected shell command must not replace them, however it writes.
  it.skipIf(!canProveOnThisHost)(
    "native profile: a shell child cannot write, replace or move the run's OpenCode configuration",
    () => {
      const control = protectedConfigRun(undefined);
      // Failing-before control: without the protected root every write below succeeds, so the
      // refusals in the confined run are the boundary's doing and not the fixture's.
      expect(control).toEqual({
        pluginRead: true,
        pluginOverwrite: true,
        pluginAppend: true,
        pluginChmod: true,
        pluginReplaceByRename: true,
        hardLinkCreate: true,
        hardLinkedAliasWrite: true,
        configCreate: true,
        configMkdir: true,
        settingsOverwrite: true,
        shellOverwrite: true,
        shellRemoveAndRecreate: true,
        pluginUnlink: true,
        configDirectoryRename: true,
        configParentRename: true,
        siblingConfigWrite: true,
        privateStateWrite: true,
        workspaceWrite: true,
      });
      expect(protectedConfigRun("protected")).toEqual({
        pluginRead: true,
        pluginOverwrite: false,
        pluginAppend: false,
        pluginChmod: false,
        pluginReplaceByRename: false,
        hardLinkCreate: false,
        hardLinkedAliasWrite: false,
        configCreate: false,
        configMkdir: false,
        settingsOverwrite: false,
        shellOverwrite: false,
        shellRemoveAndRecreate: false,
        pluginUnlink: false,
        configDirectoryRename: false,
        configParentRename: false,
        siblingConfigWrite: true,
        privateStateWrite: true,
        workspaceWrite: true,
      });
    },
    30_000,
  );

  // #3897 review: the plan agent's notes are exempt from workspace-edit approval because they stay
  // private. A link inside the plan directory (or a swapped ancestor) would make a note path name a
  // workspace file, so the kernel refuses every link there while ordinary notes stay writable.
  it.skipIf(!canProveOnThisHost)(
    "native profile: the plan directory takes notes but no link that could reach the workspace",
    () => {
      const notes = {
        noteWrite: true,
        noteRewrite: true,
        noteDirectory: true,
        homeEntryWrite: true,
      };
      // Failing-before control: without the rule every link and swap below succeeds.
      expect(linkFreePlanRun(undefined)).toEqual({
        ...notes,
        symlinkToWorkspace: true,
        shellSymlink: true,
        hardLinkToWorkspace: true,
        planRename: true,
        ancestorRename: true,
        ancestorSymlinkSwap: true,
      });
      expect(linkFreePlanRun("link-free")).toEqual({
        ...notes,
        symlinkToWorkspace: false,
        shellSymlink: false,
        hardLinkToWorkspace: false,
        planRename: false,
        ancestorRename: false,
        ancestorSymlinkSwap: false,
      });
    },
    30_000,
  );

  // #3897 review (P1): a PATH entry such as `~/.local/bin` must open that directory only. Its
  // parent holds `share/opencode/auth.json`, `state/gh` and other user state unrelated to the task.
  it.skipIf(!canProveOnThisHost)(
    "native profile: a generic user bin directory opens only itself, never its parent",
    () => {
      const tree = createNativeProofTree();
      try {
        const home = join(tree.root, "synthetic-home");
        const bin = join(home, ".local", "bin");
        const share = join(home, ".local", "share", "opencode");
        mkdirSync(bin, { recursive: true });
        mkdirSync(share, { recursive: true });
        const tool = join(bin, "synthetic-tool");
        writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        writeFileSync(join(bin, "sibling-data.txt"), "synthetic");
        writeFileSync(join(share, "state.json"), "synthetic");
        const pathValue = [bin, dirname(process.execPath)].join(delimiter);
        const roots = nativeToolchainReadRoots(pathValue, home);
        expect(roots).toContain(bin);
        expect(roots).not.toContain(join(home, ".local"));
        const script = factScript({
          toolRun: `cp.execFileSync(${JSON.stringify(tool)}, { stdio: 'ignore' })`,
          binDirectoryRead: readFact(join(bin, "sibling-data.txt")),
          shareRead: readFact(join(share, "state.json")),
          shareListing: `fs.readdirSync(${JSON.stringify(share)})`,
          shareWrite: `fs.writeFileSync(${JSON.stringify(join(share, "planted.json"))}, 'x')`,
        });
        // Failing-before control: the previous derivation opened the whole `~/.local`.
        const previous = runNative(
          tree,
          nativeConfinement(tree, "loopback-only", 1983, {
            toolchainReadRoots: [join(home, ".local"), ...nativeToolchainRoots()],
          }),
          script,
        );
        expect(JSON.parse(previous.stdout)).toMatchObject({ toolRun: true, shareRead: true });
        const confined = runNative(
          tree,
          nativeConfinement(tree, "loopback-only", 1983, {
            toolchainReadRoots: [...roots, ...nativeToolchainRoots()],
          }),
          script,
        );
        expect(JSON.parse(confined.stdout)).toEqual({
          toolRun: true,
          binDirectoryRead: true,
          shareRead: false,
          shareListing: false,
          shareWrite: false,
        });
      } finally {
        tree.cleanup();
      }
    },
    20_000,
  );

  // Finding B (#3897), kernel half: below Full access a workspace-approved command cannot reach a
  // second destination, whatever it runs (npm exec, a node script, a forked grandchild); Full
  // access keeps the inherited egress. Loopback, where the attested Model Gateway and the tool
  // facade live, works in every mode.
  it.skipIf(!canProveOnThisHost).each(["loopback-only", "inherited"] as const)(
    "native profile (%s): reaches loopback, including from a forked grandchild",
    async (egress) => {
      const loopback = await listenEphemeral();
      const tree = createNativeProofTree();
      try {
        const policy = nativeConfinement(tree, egress, loopback.port);
        const direct = runNative(tree, policy, connectProbe("127.0.0.1", loopback.port));
        expect(direct.stdout).toBe("CONNECTED");
        const byName = runNative(tree, policy, connectProbe("localhost", loopback.port));
        expect(byName.stdout).toBe("CONNECTED");
        const forked = runNative(
          tree,
          policy,
          [
            "const { spawnSync } = require('node:child_process');",
            `const r = spawnSync(process.execPath, ['-e', ${JSON.stringify(connectProbe("127.0.0.1", loopback.port))}], { encoding: 'utf8' });`,
            "process.stdout.write(r.stdout);",
          ].join(""),
        );
        expect(forked.stdout).toBe("CONNECTED");
      } finally {
        loopback.server.close();
        tree.cleanup();
      }
    },
    20_000,
  );

  // The destination is 192.0.2.1 (RFC 5737 TEST-NET-1): routable in form, answered by nobody. The
  // kernel denial returns EPERM before any packet is sent; an open network ends in a timeout or
  // an unreachable error. The machine's own addresses are not a valid second destination: the
  // kernel treats them as local and Seatbelt's `localhost` filter admits them.
  it.skipIf(!canProveOnThisHost)(
    "native profile: a second destination is denied before traffic below Full access and open at Full access",
    () => {
      const tree = createNativeProofTree();
      try {
        const probe = connectProbe("192.0.2.1", 80);
        const network = join(tree.workspaceRoot, "network.cjs");
        writeFileSync(network, probe);
        const denial = /^BLOCKED:(EPERM|EACCES)$/u;
        const control = run(process.execPath, ["-e", probe]).stdout;
        expect(control).not.toMatch(denial);
        for (const egress of ["loopback-only", undefined] as const) {
          const policy = nativeConfinement(tree, egress);
          // `node network.cjs` and `npm exec` are one process tree under one kernel profile; a
          // shell child and a forked grandchild stand for both.
          const viaShell = `process.stdout.write(require('node:child_process').spawnSync('/bin/sh', ['-c', ${JSON.stringify(`${JSON.stringify(process.execPath)} ${JSON.stringify(network)}`)}], { encoding: 'utf8' }).stdout)`;
          for (const script of [probe, viaShell])
            expect(runNative(tree, policy, script).stdout).toMatch(denial);
        }
        const full = runNative(tree, nativeConfinement(tree, "inherited"), probe);
        expect(full.stdout).not.toMatch(denial);
        expect(full.stdout).toMatch(/^(TIMEOUT|BLOCKED:E[A-Z]+)$/u);
      } finally {
        tree.cleanup();
      }
    },
    30_000,
  );

  it.skipIf(!canProveOnThisHost)(
    "native profile: unix-socket peers and DNS are denied below Full access",
    async () => {
      const tree = createNativeProofTree();
      const socketDirectory = mkdtempSync(join(tmpdir(), "keiko-sock-"));
      const socketPath = join(socketDirectory, "agent.sock");
      const server = createServer((socket) => socket.end());
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      try {
        const connect = connectUnixProbe(socketPath);
        expect(run(process.execPath, ["-e", connect]).stdout).toBe("CONNECTED");
        const denied = runNative(tree, nativeConfinement(tree, "loopback-only"), connect);
        expect(denied.stdout).toMatch(/^BLOCKED:/u);
        const resolver = runNative(
          tree,
          nativeConfinement(tree, "loopback-only"),
          "require('node:dns').lookup('example.com', (e) => process.stdout.write(e ? 'DNS_DENIED' : 'DNS_OPEN'));",
        );
        expect(resolver.stdout).toBe("DNS_DENIED");
      } finally {
        server.close();
        tree.cleanup();
        rmSync(socketDirectory, { recursive: true, force: true });
      }
    },
    20_000,
  );

  // #3901 review (P1): the profile starts from `allow default`, so without a process rule a shell
  // inside the tree could signal any process the OS user owns. Every process below is one the test
  // started; the control proves the unconfined `kill` is effective, so the refusal is the kernel's.
  it.skipIf(!canProveOnThisHost).each(["loopback-only", "inherited"] as const)(
    "native profile (%s): the confined tree cannot signal a process outside the run",
    async (egress) => {
      const tree = createNativeProofTree();
      const control = await startOwnedProcess("/bin/sleep", ["300"]);
      const sibling = await startOwnedProcess("/bin/sleep", ["300"]);
      try {
        expect(run("/bin/kill", ["-TERM", String(control.pid)]).status).toBe(0);
        expect(await control.exited).toBe("SIGTERM");
        const probes = factScript(signalProbes(tree, sibling.pid));
        const unconfined = run(
          process.execPath,
          ["-e", probes],
          nativeEnvironment(tree),
          tree.workspaceRoot,
        );
        expect(JSON.parse(unconfined.stdout)).toEqual({
          interpreterSignal: true,
          shellBuiltinSignal: true,
          systemKillSignal: true,
        });

        const policy = nativeConfinement(tree, egress);
        const wrapped = buildRuntimeGatewaySeatbeltCommand(policy, "/bin/kill", [
          "-TERM",
          String(sibling.pid),
        ]);
        const direct = runDetailed(
          wrapped.command,
          wrapped.args,
          nativeEnvironment(tree),
          tree.workspaceRoot,
        );
        expect(direct.status).not.toBe(0);
        expect(direct.stderr).toContain("Operation not permitted");
        const confined = runNative(tree, policy, probes);
        expect(JSON.parse(confined.stdout)).toEqual({
          interpreterSignal: false,
          shellBuiltinSignal: false,
          systemKillSignal: false,
        });
        expect(sibling.running()).toBe(true);
      } finally {
        control.stop();
        sibling.stop();
        tree.cleanup();
      }
    },
    30_000,
  );

  // Another run's tree is a foreign process too: two runs share the OS user and the profile text,
  // but not the sandbox, so neither can end the other.
  it.skipIf(!canProveOnThisHost)(
    "native profile: one run's confined tree cannot signal another run's confined tree",
    async () => {
      const [first, second] = [createNativeProofTree(), createNativeProofTree()];
      const peerCommand = buildRuntimeGatewaySeatbeltCommand(
        nativeConfinement(first, "loopback-only"),
        "/bin/sh",
        ["-c", "echo ready; exec /bin/sleep 300"],
      );
      const peer = await startOwnedProcess(peerCommand.command, peerCommand.args, {
        env: nativeEnvironment(first),
        cwd: first.workspaceRoot,
      });
      try {
        await peer.announced;
        const killer = buildRuntimeGatewaySeatbeltCommand(
          nativeConfinement(second, "loopback-only"),
          "/bin/kill",
          ["-TERM", String(peer.pid)],
        );
        const result = runDetailed(
          killer.command,
          killer.args,
          nativeEnvironment(second),
          second.workspaceRoot,
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Operation not permitted");
        expect(peer.running()).toBe(true);
      } finally {
        peer.stop();
        first.cleanup();
        second.cleanup();
      }
    },
    30_000,
  );

  it.skipIf(!canProveOnThisHost).each(["loopback-only", "inherited"] as const)(
    "native profile (%s): the confined tree cannot read a foreign process's information",
    async (egress) => {
      const tree = createNativeProofTree();
      const sibling = await startOwnedProcess("/bin/sleep", ["300"]);
      try {
        const args = ["-c", PROCESS_INFO_SHELL, "probe", PROCESS_INFO_RUBY, String(sibling.pid)];
        const unconfined = run("/bin/sh", args, nativeEnvironment(tree), tree.workspaceRoot);
        expect(unconfined.stdout).toBe("read,read,read");
        const wrapped = buildRuntimeGatewaySeatbeltCommand(
          nativeConfinement(tree, egress),
          "/bin/sh",
          args,
        );
        const confined = run(
          wrapped.command,
          wrapped.args,
          nativeEnvironment(tree),
          tree.workspaceRoot,
        );
        expect(confined.stdout).toBe("refused,read,read");
      } finally {
        sibling.stop();
        tree.cleanup();
      }
    },
    30_000,
  );

  // The refusals above must not cost the runtime its own cancellation or the agent's toolchain:
  // the shell starts, signals and cancels its own descendants, and node, Git and a pipeline run.
  it.skipIf(!canProveOnThisHost).each(["loopback-only", "inherited"] as const)(
    "native profile (%s): the confined tree still cancels its own processes and runs its toolchain",
    (egress) => {
      const tree = createNativeProofTree();
      try {
        const result = runNative(
          tree,
          nativeConfinement(tree, egress),
          factScript(ownProcessProbes(tree)),
        );
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          shellCancelsItsChild: true,
          shellCancelsASiblingBranch: true,
          interpreterCancelsItsChild: true,
          interpreterCancelsItsGroup: true,
          ownResourceUse: true,
          nodeChild: true,
          gitVersion: true,
          shellPipeline: true,
        });
      } finally {
        tree.cleanup();
      }
    },
    30_000,
  );

  it("refuses a native profile whose filesystem is not writable, and the reverse", () => {
    const filesystem = {
      workspaceRoot: "/accepted/workspace",
      workspaceAccess: "read-write" as const,
      privateStateRoot: "/private/state",
      runtimeReadRoot: "/immutable/runtime",
    };
    expect(() =>
      createRuntimeGatewayConfinement({
        ...input,
        profile: "keiko-native",
        filesystem: { ...filesystem, workspaceAccess: "read-only" },
      }),
    ).toThrow("runtime-gateway-policy-invalid");
    expect(() => createRuntimeGatewayConfinement({ ...input, filesystem })).toThrow(
      "runtime-gateway-policy-invalid",
    );
    const native = createRuntimeGatewayConfinement({
      ...input,
      profile: "keiko-native",
      filesystem,
    });
    const gateway = createRuntimeGatewayConfinement(input);
    expect(native.policyDigest).not.toBe(gateway.policyDigest);
    expect(native.profile).toBe("keiko-native");
  });

  it.skipIf(!canProveOnThisHost)(
    "denies an unapproved child executable while permitting the real Apple git chain",
    () => {
      const policy = createRuntimeGatewayConfinement(input);
      const childProbe = [
        "const { spawnSync } = require('node:child_process');",
        "const denied = spawnSync('/bin/echo', ['unexpected'], { encoding: 'utf8' });",
        "if (denied.error?.code !== 'EPERM') { process.stdout.write('UNAPPROVED_ALLOWED'); process.exit(2); }",
        `const git = spawnSync(${JSON.stringify(gitExecutable)}, ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });`,
        "if (git.status !== 0 || git.stdout.trim() !== 'true') { process.stdout.write('GIT_DENIED'); process.exit(3); }",
        "process.stdout.write('DENIED_UNAPPROVED_ALLOWED_GIT');",
      ].join("");
      const wrapped = buildRuntimeGatewaySeatbeltCommand(policy, process.execPath, [
        "-e",
        childProbe,
      ]);
      expect(run(wrapped.command, wrapped.args)).toEqual({
        status: 0,
        stdout: "DENIED_UNAPPROVED_ALLOWED_GIT",
      });
    },
  );

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

function filesystemProbe(workspace: string, state: string, root: string): string {
  return [
    "facts={};",
    `workspace=${JSON.stringify(workspace)};state=${JSON.stringify(state)};root=${JSON.stringify(root)};`,
    "checks={",
    '"workspaceRead"=>-> {File.read(workspace+"/source.txt")},',
    '"workspaceWrite"=>-> {File.write(workspace+"/edit.txt","synthetic")},',
    '"privateStateWrite"=>-> {File.write(state+"/state.txt","synthetic")},',
    '"externalRead"=>-> {File.read(root+"/outside.txt")},',
    '"externalWrite"=>-> {File.write(root+"/outside-write.txt","synthetic")},',
    '"symlinkRead"=>-> {File.read(workspace+"/escape.txt")}};',
    "checks.each {|key,check| begin;check.call;facts[key]=true;rescue SystemCallError;facts[key]=false;end};",
    `begin;pid=Process.spawn({"HOME"=>state,"GIT_CONFIG_NOSYSTEM"=>"1","GIT_CONFIG_GLOBAL"=>"/dev/null"},${JSON.stringify(gitExecutable)},"rev-parse","--is-inside-work-tree",chdir:workspace,out:File::NULL,err:File::NULL);facts["gitHandshakeRead"]=Process.wait2(pid).last.success?;rescue SystemCallError;facts["gitHandshakeRead"]=false;end;`,
    `print '{'+facts.map {|key,value| '"'+key+'":'+value.to_s}.join(',')+'}';`,
  ].join("");
}
