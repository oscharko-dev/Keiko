import { describe, it, expect } from "vitest";
import {
  buildGatewaySeatbeltCommand,
  buildWrappedCommand,
  DEFAULT_CONTAINER_IMAGE,
  EXECUTION_ROOT_MOUNT,
  EXECUTION_ROOT_TMP,
  SEATBELT_DENY_EGRESS_PROFILE,
  type WrappedCommand,
} from "./backends.js";
import {
  executionRootSeatbeltProfile,
  OWN_PROCESS_TARGETS_SEATBELT_RULE,
} from "./seatbelt-execution-root.js";
import type { IsolatedRunPlan, NetworkGatewayPolicy } from "./types.js";

const plan: IsolatedRunPlan = {
  command: "node",
  args: ["-e", "process.exit(0)"],
  cwd: "/work/root",
  network: "none",
};

function expectWrapped(command: WrappedCommand | undefined): WrappedCommand {
  expect(command).toBeDefined();
  if (command === undefined) {
    throw new Error("expected a wrapped command");
  }
  return command;
}

describe("buildWrappedCommand", () => {
  it("pins the default container backend to the governed Node.js 24 LTS patch", () => {
    expect(DEFAULT_CONTAINER_IMAGE).toBe("node:24.18.0-slim");
  });

  it("bubblewrap preserves compatibility mode for network-only runs", () => {
    const wrapped = expectWrapped(buildWrappedCommand("bubblewrap", plan));
    expect(wrapped.command).toBe("bwrap");
    expect(wrapped.args).toEqual([
      "--unshare-net",
      "--die-with-parent",
      "--dev-bind",
      "/",
      "/",
      "--chdir",
      "/work/root",
      "--",
      "node",
      "-e",
      "process.exit(0)",
    ]);
  });

  it("bubblewrap execution-root mode avoids a broad host-root bind", () => {
    const wrapped = expectWrapped(
      buildWrappedCommand("bubblewrap", { ...plan, filesystem: "execution-root" }),
    );
    expect(wrapped.command).toBe("bwrap");
    expect(wrapped.args).toEqual([
      "--unshare-net",
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--setenv",
      "HOME",
      "/tmp",
      "--setenv",
      "USERPROFILE",
      "/tmp",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--ro-bind-try",
      "/usr",
      "/usr",
      "--ro-bind-try",
      "/bin",
      "/bin",
      "--ro-bind-try",
      "/lib",
      "/lib",
      "--ro-bind-try",
      "/lib64",
      "/lib64",
      "--ro-bind-try",
      "/opt",
      "/opt",
      "--ro-bind-try",
      "/nix/store",
      "/nix/store",
      "--dir",
      EXECUTION_ROOT_MOUNT,
      "--bind",
      "/work/root",
      EXECUTION_ROOT_MOUNT,
      "--dir",
      EXECUTION_ROOT_TMP,
      "--symlink",
      EXECUTION_ROOT_TMP,
      "/tmp",
      "--chdir",
      EXECUTION_ROOT_MOUNT,
      "--",
      "node",
      "-e",
      "process.exit(0)",
    ]);
  });

  it("bubblewrap execution-root mode read-only binds an absolute command directory", () => {
    const wrapped = expectWrapped(
      buildWrappedCommand("bubblewrap", {
        ...plan,
        command: "/usr/local/bin/node",
        filesystem: "execution-root",
      }),
    );
    expect(wrapped.args).toEqual([
      "--unshare-net",
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--setenv",
      "HOME",
      "/tmp",
      "--setenv",
      "USERPROFILE",
      "/tmp",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--ro-bind-try",
      "/usr",
      "/usr",
      "--ro-bind-try",
      "/bin",
      "/bin",
      "--ro-bind-try",
      "/lib",
      "/lib",
      "--ro-bind-try",
      "/lib64",
      "/lib64",
      "--ro-bind-try",
      "/opt",
      "/opt",
      "--ro-bind-try",
      "/nix/store",
      "/nix/store",
      "--ro-bind-try",
      "/usr/local/bin",
      "/usr/local/bin",
      "--dir",
      EXECUTION_ROOT_MOUNT,
      "--bind",
      "/work/root",
      EXECUTION_ROOT_MOUNT,
      "--dir",
      EXECUTION_ROOT_TMP,
      "--symlink",
      EXECUTION_ROOT_TMP,
      "/tmp",
      "--chdir",
      EXECUTION_ROOT_MOUNT,
      "--",
      "/usr/local/bin/node",
      "-e",
      "process.exit(0)",
    ]);
  });

  it("keeps execution-root process confinement when networking is explicitly inherited", () => {
    const wrapped = expectWrapped(
      buildWrappedCommand("bubblewrap", {
        ...plan,
        filesystem: "execution-root",
        network: "inherit",
      }),
    );
    expect(wrapped.command).toBe("bwrap");
    expect(wrapped.args).toContain("--unshare-pid");
    expect(wrapped.args).not.toContain("--unshare-net");
  });

  it("unshare maps root and creates a fresh network namespace", () => {
    const wrapped = expectWrapped(buildWrappedCommand("unshare", plan));
    expect(wrapped.command).toBe("unshare");
    expect(wrapped.args).toEqual(["--map-root-user", "--net", "node", "-e", "process.exit(0)"]);
  });

  it("seatbelt denies outbound egress via the deny profile", () => {
    const wrapped = expectWrapped(buildWrappedCommand("seatbelt", plan));
    expect(wrapped.command).toBe("sandbox-exec");
    expect(wrapped.args[0]).toBe("-p");
    expect(wrapped.args[1]).toBe(SEATBELT_DENY_EGRESS_PROFILE);
    expect(wrapped.args.slice(2)).toEqual(["node", "-e", "process.exit(0)"]);
  });

  it("supports execution-root Seatbelt without granting the host home or loopback network", () => {
    const wrapped = expectWrapped(
      buildWrappedCommand("seatbelt", {
        ...plan,
        filesystem: "execution-root",
        cwd: '/work/root"quoted',
      }),
    );
    const profile = wrapped.args[1];
    expect(profile).toContain(
      "(deny file-read* file-write* network* mach-lookup appleevent-send lsopen)",
    );
    expect(profile).toContain('(subpath "/work/root\\"quoted")');
    expect(profile).toContain(OWN_PROCESS_TARGETS_SEATBELT_RULE);
    expect(profile).not.toContain("localhost");
    expect(profile).not.toContain('(subpath "/Users")');
    const home = "/Users/test-owner";
    const nvm = `${home}/.nvm/versions/node/v24/bin`;
    const bounded = executionRootSeatbeltProfile({ ...plan, filesystem: "execution-root" }, [nvm]);
    expect(bounded).toContain(`(subpath ${JSON.stringify(nvm)})`);
    expect(bounded).not.toContain(`(subpath ${JSON.stringify(home)})`);
  });

  it("does not import broad Linux install roots or mutable System volumes into macOS", () => {
    const wrapped = expectWrapped(
      buildWrappedCommand("seatbelt", {
        ...plan,
        command: "/trusted/node/bin/node",
        filesystem: "execution-root",
      }),
    );
    expect(wrapped.args[1]).not.toContain('(subpath "/opt")');
    expect(wrapped.args[1]).not.toContain('(subpath "/usr")');
    expect(wrapped.args[1]).not.toContain('(subpath "/System")');
    expect(wrapped.args[1]).toContain('(subpath "/System/Library")');
    expect(wrapped.args[1]).toContain('(literal "/private/var/select/sh")');
  });

  it("admits a resolved npm package without granting its installation parent's other files", () => {
    const wrapped = expectWrapped(
      buildWrappedCommand("seatbelt", {
        ...plan,
        filesystem: "execution-root",
        command: "/trusted/node/lib/node_modules/npm/bin/npx-cli.js",
      }),
    );
    expect(wrapped.args[1]).toContain('(subpath "/trusted/node/lib/node_modules/npm")');
    expect(wrapped.args[1]).not.toContain('(subpath "/trusted/node")');
  });

  it.each(["relative/root", "/work/root\nother", "/work/root\0other"])(
    "refuses an unsafe execution root before building the profile: %j",
    (cwd) => {
      expect(() =>
        buildWrappedCommand("seatbelt", { ...plan, filesystem: "execution-root", cwd }),
      ).toThrow("seatbelt-execution-root-invalid");
    },
  );

  it("the seatbelt profile denies remote egress but keeps loopback and unix sockets", () => {
    expect(SEATBELT_DENY_EGRESS_PROFILE).toContain("(deny network-outbound)");
    expect(SEATBELT_DENY_EGRESS_PROFILE).toContain("(allow network-outbound (remote unix-socket))");
    expect(SEATBELT_DENY_EGRESS_PROFILE).toContain('(remote ip "localhost:*")');
  });

  it("container backends run with no network and bind-mount the execution root", () => {
    for (const [backend, bin] of [
      ["container-docker", "docker"],
      ["container-podman", "podman"],
    ] as const) {
      const wrapped = expectWrapped(buildWrappedCommand(backend, plan));
      expect(wrapped.command).toBe(bin);
      expect(wrapped.args).toEqual([
        "run",
        "--rm",
        "--network=none",
        "--volume",
        "/work/root:/work/root:rw",
        "--workdir",
        "/work/root",
        DEFAULT_CONTAINER_IMAGE,
        "node",
        "-e",
        "process.exit(0)",
      ]);
    }
  });

  it("container execution-root mode uses a read-only image root plus private tmp", () => {
    const wrapped = expectWrapped(
      buildWrappedCommand("container-docker", { ...plan, filesystem: "execution-root" }),
    );
    expect(wrapped.args).toEqual([
      "run",
      "--rm",
      "--network=none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "--volume",
      "/work/root:/work/root:rw",
      "--workdir",
      "/work/root",
      DEFAULT_CONTAINER_IMAGE,
      "node",
      "-e",
      "process.exit(0)",
    ]);
  });

  it("returns undefined for the 'none' backend (no enforcing wrapper)", () => {
    expect(buildWrappedCommand("none", plan)).toBeUndefined();
  });

  it("fails closed for an unsupported backend value", () => {
    expect(() => buildWrappedCommand("unsupported" as never, plan)).toThrow(
      "Unsupported sandbox backend: unsupported",
    );
  });

  it("preserves an empty argument list", () => {
    const wrapped = expectWrapped(
      buildWrappedCommand("seatbelt", { ...plan, args: [], command: "true" }),
    );
    expect(wrapped.args).toEqual(["-p", SEATBELT_DENY_EGRESS_PROFILE, "true"]);
  });
});

describe("buildGatewaySeatbeltCommand child process policy (#3390 live run)", () => {
  const gateway: NetworkGatewayPolicy = { mode: "gateway", host: "127.0.0.1", port: 1983 };

  // Regression pin: `(deny process-fork)` broke the OpenCode git handshake. Fork itself therefore
  // remains available, but the executable transition is deny-by-default and admits only the
  // verified runtime plus the one caller-attested Git executable (#3394 T47) — no conventional
  // Xcode/CommandLineTools path is trusted unconditionally, since a local user can replace it.
  it("denies arbitrary child executables while admitting only the runtime and the attested git", () => {
    const wrapped = buildGatewaySeatbeltCommand(
      gateway,
      "/trusted/opencode",
      ["serve"],
      "/qualified/apple/git",
    );
    const profile = wrapped.args[1];
    expect(profile).not.toContain("process-fork");
    expect(profile).toContain("(deny process-exec)");
    expect(profile).toContain('(literal "/trusted/opencode")');
    expect(profile).toContain('(literal "/qualified/apple/git")');
    expect(profile).not.toContain('(literal "/usr/bin/git")');
    expect(profile).not.toContain("CommandLineTools");
    expect(profile).not.toContain("Xcode.app");
    expect(profile).not.toContain("(allow process-exec)");
    for (const denied of ["network*", "mach-lookup", "appleevent-send", "lsopen"])
      expect(profile).toContain(`(deny ${denied})`);
    // #3897 review (P1): the gateway profile also starts from `allow default`, so it carries the
    // same own-process rule as the native and execution-root profiles, exactly once.
    expect(profile?.split(OWN_PROCESS_TARGETS_SEATBELT_RULE)).toHaveLength(2);
  });

  it("rejects a relative runtime executable before compiling the profile", () => {
    expect(() =>
      buildGatewaySeatbeltCommand(gateway, "opencode", ["serve"], "/qualified/apple/git"),
    ).toThrow("gateway-seatbelt-command-not-absolute");
  });

  // #3897: the native profile runs the agent's own toolchains like standalone OpenCode; at Full
  // access the wrapper also leaves egress inherited. What it always enforces is the filesystem
  // boundary and the service escapes. The pins below keep the original inherited-exec,
  // inherited-egress shape for `inherited` and add the kernel read allowlist.
  const nativeFilesystem = {
    workspaceRoot: "/accepted/workspace",
    workspaceAccess: "read-write" as const,
    privateStateRoot: "/private/state",
    runtimeReadRoot: "/immutable/runtime",
    deniedReadRoots: ["/Users/owner/.ssh", "/Users/owner/Library/Application Support/Keiko"],
    toolchainReadRoots: ["/opt/homebrew"],
  };

  function nativeProfile(egress?: "inherited" | "loopback-only"): string {
    return (
      buildGatewaySeatbeltCommand(
        gateway,
        "/trusted/opencode",
        ["serve"],
        "/qualified/apple/git",
        nativeFilesystem,
        "keiko-native",
        egress,
      ).args[1] ?? ""
    );
  }

  it("compiles the native profile with inherited exec and egress at Full access", () => {
    const wrapped = buildGatewaySeatbeltCommand(
      gateway,
      "/trusted/opencode",
      ["serve"],
      "/qualified/apple/git",
      nativeFilesystem,
      "keiko-native",
      "inherited",
    );
    const profile = wrapped.args[1] ?? "";
    expect(wrapped.command).toBe("/usr/bin/sandbox-exec");
    expect(profile).not.toContain("(deny network*)");
    expect(profile).not.toContain("(deny process-exec)");
    expect(profile).not.toContain("(deny mach-lookup)");
    for (const denied of ["appleevent-send", "lsopen"])
      expect(profile).toContain(`(deny ${denied})`);
    expect(profile).toContain('(subpath "/accepted/workspace")');
    expect(profile).toContain('(deny file-read* file-write* (subpath "/Users/owner/.ssh")');
    // The workspace and the private state root are re-allowed after the denied roots, so Keiko's
    // own state directory may contain both (managed task workspaces do live there) while every
    // other file of that directory stays unreadable (#3897).
    expect(
      profile.lastIndexOf(
        '(allow file-read* file-write* (subpath "/accepted/workspace") (subpath "/private/state"))',
      ),
    ).toBeGreaterThan(profile.lastIndexOf('(deny file-read* file-write* (subpath "/Users'));
  });

  // Strengthens the former `(deny file-write*)` pin: reads are denied by default as well, so the
  // process can open only the admitted roots (finding A, #3897).
  it("denies reads and writes by default and admits only the explicit roots", () => {
    const profile = nativeProfile("inherited");
    expect(profile.indexOf("(deny file-read* file-write*)")).toBeGreaterThan(
      profile.indexOf("(allow default)"),
    );
    expect(profile).toContain('(subpath "/opt/homebrew")');
    expect(profile).toContain('(subpath "/immutable/runtime")');
    expect(profile).not.toContain('(subpath "/Users")');
    expect(profile).not.toContain('(subpath "/System/Volumes/Data")');
    // Credential names are denied LAST, after the workspace re-allow, so a `.env` inside the
    // workspace cannot be reopened by any earlier rule.
    expect(profile.lastIndexOf("(deny file-read* file-write* ")).toBeGreaterThan(
      profile.lastIndexOf("(allow file-read* file-write* (subpath"),
    );
    expect(profile.endsWith("))")).toBe(true);
  });

  it("confines network to loopback below Full access and fails closed without a disposition", () => {
    const loopback =
      '(deny network*)(allow network-outbound (remote ip "localhost:*"))' +
      '(allow network-inbound (local ip "localhost:*"))' +
      '(allow network-bind (local ip "localhost:*"))';
    expect(nativeProfile("loopback-only").endsWith(loopback)).toBe(true);
    // An absent disposition is the restrictive one; only an explicit `inherited` opens egress.
    expect(nativeProfile()).toBe(nativeProfile("loopback-only"));
    expect(nativeProfile("inherited")).not.toContain("(deny network*)");
    expect(nativeProfile("loopback-only")).not.toContain("remote unix-socket");
  });

  it("refuses a native profile without a writable filesystem", () => {
    expect(() =>
      buildGatewaySeatbeltCommand(
        gateway,
        "/trusted/opencode",
        ["serve"],
        "/git",
        undefined,
        "keiko-native",
      ),
    ).toThrow("native-seatbelt-filesystem-invalid");
    expect(() =>
      buildGatewaySeatbeltCommand(
        gateway,
        "/trusted/opencode",
        ["serve"],
        "/git",
        { ...nativeFilesystem, workspaceAccess: "read-only" },
        "keiko-native",
      ),
    ).toThrow("native-seatbelt-filesystem-invalid");
  });

  it("refuses toolchain roots that would open a top-level directory", () => {
    for (const toolchainReadRoots of [["/Users"], ["/"], ["relative/root"]])
      expect(() =>
        buildGatewaySeatbeltCommand(
          gateway,
          "/trusted/opencode",
          [],
          "/git",
          { ...nativeFilesystem, toolchainReadRoots },
          "keiko-native",
        ),
      ).toThrow("native-seatbelt-filesystem-invalid");
  });
});

describe("Linux native profile (#3897): refused until a Linux boundary is qualified", () => {
  const gateway: NetworkGatewayPolicy = { mode: "gateway", host: "127.0.0.1", port: 1983 };
  const nativePlan: IsolatedRunPlan = {
    command: "/opt/keiko/runtime/opencode",
    args: ["serve"],
    cwd: "/work/ws",
    network: gateway,
    gatewayProfile: "keiko-native",
    gatewayFilesystem: {
      workspaceRoot: "/work/ws",
      workspaceAccess: "read-write",
      privateStateRoot: "/state/run-1",
      runtimeReadRoot: "/opt/keiko/runtime",
    },
  };

  // The PR audit executed the previous bubblewrap mount plan in a Linux container: a shell child
  // read a workspace `.env`, and below Full access the runtime could not reach the gateway. Both
  // Linux wrappers therefore refuse a native run instead of launching a weaker boundary.
  it("refuses a native run under bubblewrap and under unshare, in both egress dispositions", () => {
    for (const backend of ["bubblewrap", "unshare"] as const) {
      for (const gatewayEgress of ["loopback-only", "inherited"] as const) {
        expect(() => buildWrappedCommand(backend, { ...nativePlan, gatewayEgress })).toThrow(
          "native-linux-backend-unqualified",
        );
      }
    }
  });

  it("still wraps the qualified gateway profile under bubblewrap", () => {
    const { gatewayProfile: _native, gatewayFilesystem: _filesystem, ...gatewayPlan } = nativePlan;
    expect(() => buildWrappedCommand("bubblewrap", gatewayPlan)).not.toThrow();
  });
});
