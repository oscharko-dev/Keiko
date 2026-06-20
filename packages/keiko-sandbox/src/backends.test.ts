import { describe, it, expect } from "vitest";
import {
  buildWrappedCommand,
  DEFAULT_CONTAINER_IMAGE,
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
  it("bubblewrap unshares the network, binds the fs, chdirs, and appends the command", () => {
    const wrapped = expectWrapped(buildWrappedCommand("bubblewrap", plan));
    expect(wrapped.command).toBe("bwrap");
    expect(wrapped.args).toContain("--unshare-net");
    expect(wrapped.args).toContain("--die-with-parent");
    expect(wrapped.args).toEqual(
      expect.arrayContaining(["--dev-bind", "/", "/", "--chdir", "/work/root"]),
    );
    const sep = wrapped.args.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(wrapped.args.slice(sep + 1)).toEqual(["node", "-e", "process.exit(0)"]);
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
      expect(wrapped.args).toContain("--network=none");
      expect(wrapped.args).toContain("--rm");
      expect(wrapped.args).toEqual(
        expect.arrayContaining(["--volume", "/work/root:/work/root:rw", "--workdir", "/work/root"]),
      );
      expect(wrapped.args).toContain(DEFAULT_CONTAINER_IMAGE);
      const imageIndex = wrapped.args.indexOf(DEFAULT_CONTAINER_IMAGE);
      expect(wrapped.args.slice(imageIndex + 1)).toEqual(["node", "-e", "process.exit(0)"]);
    }
  });

  it("returns undefined for the 'none' backend (no enforcing wrapper)", () => {
    expect(buildWrappedCommand("none", plan)).toBeUndefined();
  });

  it("preserves an empty argument list", () => {
    const wrapped = expectWrapped(
      buildWrappedCommand("seatbelt", { ...plan, args: [], command: "true" }),
    );
    expect(wrapped.args).toEqual(["-p", SEATBELT_DENY_EGRESS_PROFILE, "true"]);
  });
});
