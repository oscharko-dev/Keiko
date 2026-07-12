import { describe, it, expect } from "vitest";
import {
  buildWrappedCommand,
  DEFAULT_CONTAINER_IMAGE,
  EXECUTION_ROOT_MOUNT,
  EXECUTION_ROOT_TMP,
  SEATBELT_DENY_EGRESS_PROFILE,
  type WrappedCommand,
} from "./backends.js";
import type { IsolatedRunPlan } from "./types.js";

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
