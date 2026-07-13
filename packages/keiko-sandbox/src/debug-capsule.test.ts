import { describe, expect, it } from "vitest";
import {
  __assertImmutableMounts,
  __assertMountDestinations,
  __assertQualifiedPaths,
  __backendExecutable,
  __backendExecutableDigest,
  __buildForBackend,
  __deriveInitMechanism,
  __pathContains,
  DEBUG_CAPSULE_RUNTIME_MOUNT,
  planStrictDebugCapsule,
  StrictDebugCapsulePlanError,
} from "./debug-capsule.js";

const input = {
  platform: "linux" as const,
  availability: { bubblewrap: true, unshare: true, seatbelt: false, docker: false, podman: false },
  executionRoot: "/workspace",
  runtimeHostDirectory: "/private/runtime",
  runtimeCapsuleDirectory: "/run/keiko-debug",
  backendExecutables: {
    bubblewrap: "/usr/bin/bwrap",
    docker: "/usr/bin/docker",
    podman: "/usr/bin/podman",
  },
  backendExecutableIdentityDigests: {
    bubblewrap: "7".repeat(64),
    docker: "8".repeat(64),
    podman: "9".repeat(64),
  },
  runtimeMountIdentityDigest: "e".repeat(64),
  runtimeMountQualified: true,
  executionRootIdentityDigest: "f".repeat(64),
  containerImage: `registry.example/keiko-debug@sha256:${"1".repeat(64)}`,
  adapterCapsuleExecutable: "/opt/debug/adapter",
  adapterArgs: ["--server", "/run/keiko-debug/adapter.sock"],
  immutableMounts: [
    {
      hostPath: "/opt/debug/adapter",
      capsulePath: "/opt/debug/adapter",
      identityDigest: "c".repeat(64),
    },
    { hostPath: "/usr/bin/node", capsulePath: "/opt/runtime/node", identityDigest: "d".repeat(64) },
  ],
  runtimeIdentityDigest: "a".repeat(64),
};

describe("strict debug capsule planning", () => {
  it("keeps the private runtime mount fixed at module load", () => {
    expect(DEBUG_CAPSULE_RUNTIME_MOUNT).toBe("/run/keiko-debug");
    expect(input.runtimeCapsuleDirectory).toBe(DEBUG_CAPSULE_RUNTIME_MOUNT);
  });

  it("recognizes root and segment-boundary containment exactly", () => {
    expect(__pathContains("/", "/")).toBe(true);
    expect(__pathContains("/", "/nested/path")).toBe(true);
    expect(__pathContains("/", "relative")).toBe(false);
    expect(__pathContains("/parent", "/parent")).toBe(true);
    expect(__pathContains("/parent", "/parent/child")).toBe(true);
    expect(__pathContains("/parent", "/parentish")).toBe(false);
  });

  it("rejects every broad root path and any non-fixed runtime mount independently", () => {
    __assertQualifiedPaths(input);
    for (const override of [
      { executionRoot: "/" },
      { runtimeHostDirectory: "/" },
      { adapterCapsuleExecutable: "/" },
      { runtimeCapsuleDirectory: "/run/keiko-debug-other" },
    ]) {
      expect(() => {
        __assertQualifiedPaths({ ...input, ...override });
      }).toThrow(StrictDebugCapsulePlanError);
    }
  });

  it("rejects destination and source roots at their owning validators", () => {
    expect(() => {
      __assertMountDestinations({
        ...input,
        immutableMounts: [{ hostPath: "/safe", capsulePath: "/", identityDigest: "1".repeat(64) }],
      });
    }).toThrow(StrictDebugCapsulePlanError);
    expect(() => {
      __assertImmutableMounts({
        ...input,
        immutableMounts: [{ hostPath: "/", capsulePath: "/safe", identityDigest: "1".repeat(64) }],
      });
    }).toThrow(StrictDebugCapsulePlanError);
    expect(() => {
      __assertImmutableMounts({
        ...input,
        immutableMounts: [{ hostPath: "/safe", capsulePath: "/", identityDigest: "1".repeat(64) }],
      });
    }).toThrow(StrictDebugCapsulePlanError);
  });

  it("rejects duplicate and nested immutable source mounts independently", () => {
    const adapterMount = input.immutableMounts[0];
    if (adapterMount === undefined) throw new Error("invalid test fixture");
    for (const hostPath of ["/opt/debug/adapter", "/opt/debug/adapter/child", "/opt/debug"]) {
      expect(() => {
        __assertImmutableMounts({
          ...input,
          immutableMounts: [
            adapterMount,
            { hostPath, capsulePath: "/safe/tool", identityDigest: "1".repeat(64) },
          ],
        });
      }).toThrow(StrictDebugCapsulePlanError);
    }
  });

  it.each(["bubblewrap", "container-docker", "container-podman"] as const)(
    "selects the exact executable and identity digest for %s",
    (backend) => {
      const expected = {
        bubblewrap: ["/usr/bin/bwrap", "7".repeat(64)],
        "container-docker": ["/usr/bin/docker", "8".repeat(64)],
        "container-podman": ["/usr/bin/podman", "9".repeat(64)],
      }[backend];
      expect(__backendExecutable(input, backend)).toBe(expected[0]);
      expect(__backendExecutableDigest(input, backend)).toBe(expected[1]);
      expect(() =>
        __backendExecutable({ ...input, backendExecutables: undefined }, backend),
      ).toThrow(StrictDebugCapsulePlanError);
      expect(() =>
        __backendExecutableDigest(
          { ...input, backendExecutableIdentityDigests: undefined },
          backend,
        ),
      ).toThrow(StrictDebugCapsulePlanError);
    },
  );

  it("fails closed for an unsupported backend identity selector", () => {
    expect(() => __backendExecutable(input, "none")).toThrow(StrictDebugCapsulePlanError);
    expect(() => __backendExecutableDigest(input, "none")).toThrow(StrictDebugCapsulePlanError);
    expect(() => __buildForBackend(input, "none")).toThrow(StrictDebugCapsulePlanError);
  });

  it("attests every required bubblewrap argument and rejects --as-pid-1", () => {
    const required = ["--unshare-net", "--unshare-pid", "--die-with-parent"];
    expect(__deriveInitMechanism("linuxNamespace", required)).toBe("bubblewrapPid1Reaper");
    expect(__deriveInitMechanism("linuxNamespace", [...required, ""])).toBe("bubblewrapPid1Reaper");
    for (const omitted of required) {
      expect(() =>
        __deriveInitMechanism(
          "linuxNamespace",
          required.filter((argument) => argument !== omitted),
        ),
      ).toThrow(StrictDebugCapsulePlanError);
    }
    expect(() => __deriveInitMechanism("linuxNamespace", [...required, "--as-pid-1"])).toThrow(
      StrictDebugCapsulePlanError,
    );
  });

  it("attests OCI init, network denial, and immutable image pull independently", () => {
    const required = ["--init", "--network=none", "--pull=never"];
    expect(__deriveInitMechanism("oci", required)).toBe("ociInit");
    for (const omitted of required) {
      expect(() =>
        __deriveInitMechanism(
          "oci",
          required.filter((argument) => argument !== omitted),
        ),
      ).toThrow(StrictDebugCapsulePlanError);
    }
    expect(() =>
      __deriveInitMechanism("oci", ["--unshare-net", "--unshare-pid", "--die-with-parent"]),
    ).toThrow(StrictDebugCapsulePlanError);
  });

  it("models one Linux PID/network namespace and the private runtime mount", () => {
    const plan = planStrictDebugCapsule(input);
    expect(plan).toMatchObject({
      backend: "linuxNamespace",
      network: "none",
      filesystem: "executionRoot",
      descendantScope: "qualifiedCapsuleInit",
      runtimeMount: { mode: "0700", writable: true },
    });
    expect(plan.args).toStrictEqual([
      "--unshare-net",
      "--unshare-pid",
      "--die-with-parent",
      "--new-session",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--dir",
      "/keiko-execution-root",
      "--dir",
      "/run",
      "--dir",
      "/run/keiko-debug",
      "--dir",
      "/opt",
      "--dir",
      "/opt/debug",
      "--dir",
      "/opt/runtime",
      "--bind",
      "/workspace",
      "/keiko-execution-root",
      "--bind",
      "/private/runtime",
      "/run/keiko-debug",
      "--ro-bind",
      "/opt/debug/adapter",
      "/opt/debug/adapter",
      "--ro-bind",
      "/usr/bin/node",
      "/opt/runtime/node",
      "--chdir",
      "/keiko-execution-root",
      "--",
      "/opt/debug/adapter",
      "--server",
      "/run/keiko-debug/adapter.sock",
    ]);
    for (const containerImage of [undefined, "node:latest", "node@sha256:short"]) {
      expect(() =>
        planStrictDebugCapsule({
          ...input,
          availability: {
            ...input.availability,
            bubblewrap: false,
            docker: true,
            podman: false,
          },
          containerImage,
        }),
      ).toThrow(StrictDebugCapsulePlanError);
    }
    expect(plan.args.slice(-3)).toEqual([
      "/opt/debug/adapter",
      "--server",
      "/run/keiko-debug/adapter.sock",
    ]);
    expect(plan.command).toBe("/usr/bin/bwrap");
    expect(plan.backendExecutableIdentityDigest).toBe("7".repeat(64));
    expect(plan.runtimeIdentityDigest).toBe(input.runtimeIdentityDigest);
    expect(plan.immutableMounts).toStrictEqual(input.immutableMounts);
    expect(plan.initMechanism).toBe("bubblewrapPid1Reaper");
    expect(plan.args).not.toContain("--share-net");
    const invalidMount = {
      hostPath: "relative",
      capsulePath: "/opt/extra",
      identityDigest: "a".repeat(64),
    };
    for (const invalid of [
      { ...input, immutableMounts: [] },
      { ...input, adapterCapsuleExecutable: "/opt/unmounted" },
      { ...input, immutableMounts: [...input.immutableMounts, invalidMount] },
      { ...input, runtimeMountQualified: false },
      {
        ...input,
        immutableMounts: [
          ...input.immutableMounts,
          { ...invalidMount, hostPath: "/x", capsulePath: "/" },
        ],
      },
      {
        ...input,
        immutableMounts: [
          ...input.immutableMounts,
          { ...invalidMount, hostPath: "/", capsulePath: "/opt/extra" },
        ],
      },
      {
        ...input,
        immutableMounts: [
          ...input.immutableMounts,
          { ...invalidMount, hostPath: "/x", identityDigest: "A".repeat(64) },
        ],
      },
    ]) {
      expect(() => planStrictDebugCapsule(invalid)).toThrow(StrictDebugCapsulePlanError);
    }
    expect(() =>
      planStrictDebugCapsule({
        ...input,
        availability: {
          bubblewrap: false,
          unshare: false,
          seatbelt: false,
          docker: false,
          podman: false,
        },
      }),
    ).toThrow(
      expect.objectContaining({
        name: "StrictDebugCapsulePlanError",
        message: "DEBUG_CAPSULE_UNAVAILABLE",
        code: "DEBUG_CAPSULE_UNAVAILABLE",
      }),
    );
  });

  it.each(["docker", "podman"] as const)("requires container init for %s", (runtime) => {
    const plan = planStrictDebugCapsule({
      ...input,
      availability: {
        bubblewrap: false,
        unshare: false,
        seatbelt: false,
        docker: runtime === "docker",
        podman: runtime === "podman",
      },
    });
    expect(plan.args).toEqual(expect.arrayContaining(["--init", "--network=none"]));
    expect(plan.descendantScope).toBe("qualifiedCapsuleInit");
    expect(plan.initMechanism).toBe("ociInit");
    expect(plan.args).toContain(input.containerImage);
    expect(plan.command).toBe(`/usr/bin/${runtime}`);
    expect(plan.backend).toBe("oci");
    expect(plan.args).toStrictEqual([
      "run",
      "--rm",
      "--pull=never",
      "--init",
      "--network=none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "--volume",
      "/workspace:/keiko-execution-root:rw",
      "--volume",
      "/private/runtime:/run/keiko-debug:rw",
      "--volume",
      "/opt/debug/adapter:/opt/debug/adapter:ro",
      "--volume",
      "/usr/bin/node:/opt/runtime/node:ro",
      "--workdir",
      "/keiko-execution-root",
      input.containerImage,
      "/opt/debug/adapter",
      "--server",
      "/run/keiko-debug/adapter.sock",
    ]);
  });

  it("fails closed on a native macOS host", () => {
    expect(() =>
      planStrictDebugCapsule({
        ...input,
        platform: "darwin",
        availability: { ...input.availability, bubblewrap: false, seatbelt: true },
      }),
    ).toThrow(StrictDebugCapsulePlanError);
  });

  it("uses closed content-free errors", () => {
    const error = new StrictDebugCapsulePlanError();
    expect(error).toMatchObject({
      name: "StrictDebugCapsulePlanError",
      message: "DEBUG_CAPSULE_UNAVAILABLE",
      code: "DEBUG_CAPSULE_UNAVAILABLE",
    });
  });

  it.each([
    { adapterCapsuleExecutable: "/unmounted/adapter" },
    { runtimeIdentityDigest: "short" },
    { immutableMounts: [] },
    { runtimeMountQualified: false },
    { runtimeMountIdentityDigest: "G".repeat(64) },
    {
      immutableMounts: [
        { hostPath: "/x", capsulePath: "/keiko-execution-root/x", identityDigest: "a".repeat(64) },
      ],
    },
  ])("fails closed when capsule identities or mounts are unproven", (override) => {
    expect(() => planStrictDebugCapsule({ ...input, ...override })).toThrow(
      StrictDebugCapsulePlanError,
    );
  });

  it.each([
    { executionRoot: "relative" },
    { runtimeHostDirectory: "relative" },
    { runtimeCapsuleDirectory: "relative" },
    { adapterCapsuleExecutable: "relative" },
    { executionRoot: "/workspace\u0000x" },
    { runtimeIdentityDigest: "A".repeat(64) },
    { executionRootIdentityDigest: "A".repeat(64) },
    { runtimeMountIdentityDigest: "A".repeat(64) },
    { runtimeCapsuleDirectory: "/run/../keiko-execution-root/runtime" },
    { runtimeCapsuleDirectory: "/run/keiko-debug/../other" },
    { backendExecutables: { ...input.backendExecutables, bubblewrap: "bwrap" } },
    { backendExecutables: { ...input.backendExecutables, bubblewrap: "/usr/bin/../bin/bwrap" } },
    { executionRoot: "/" },
    { runtimeHostDirectory: "/" },
    { adapterCapsuleExecutable: "/" },
    { backendExecutables: { ...input.backendExecutables, bubblewrap: "/" } },
    {
      backendExecutableIdentityDigests: {
        ...input.backendExecutableIdentityDigests,
        bubblewrap: "A".repeat(64),
      },
    },
  ])("rejects invalid required path or digest %#", (override) => {
    expect(() => planStrictDebugCapsule({ ...input, ...override })).toThrow(
      StrictDebugCapsulePlanError,
    );
  });

  it.each([
    { runtimeHostDirectory: "/workspace" },
    { runtimeHostDirectory: "/workspace/runtime" },
    { executionRoot: "/workspace/project", runtimeHostDirectory: "/workspace" },
    {
      immutableMounts: [
        ...input.immutableMounts,
        { hostPath: "/workspace/tool", capsulePath: "/opt/tool", identityDigest: "a".repeat(64) },
      ],
    },
    {
      immutableMounts: [
        ...input.immutableMounts,
        {
          hostPath: "/private/runtime/tool",
          capsulePath: "/opt/tool",
          identityDigest: "a".repeat(64),
        },
      ],
    },
    {
      immutableMounts: [
        ...input.immutableMounts,
        { hostPath: "/opt", capsulePath: "/srv/tool", identityDigest: "a".repeat(64) },
      ],
    },
    {
      immutableMounts: [
        ...input.immutableMounts,
        { hostPath: "/srv/tool", capsulePath: "/opt", identityDigest: "a".repeat(64) },
      ],
    },
  ])("rejects normalized source overlap %#", (override) => {
    expect(() => planStrictDebugCapsule({ ...input, ...override })).toThrow(
      StrictDebugCapsulePlanError,
    );
  });

  it("requires an absolute approved executable for the selected backend", () => {
    for (const backendExecutables of [undefined, {}, { docker: "/usr/bin/docker" }]) {
      expect(() => planStrictDebugCapsule({ ...input, backendExecutables })).toThrow(
        StrictDebugCapsulePlanError,
      );
    }
    expect(() =>
      planStrictDebugCapsule({ ...input, backendExecutableIdentityDigests: undefined }),
    ).toThrow(StrictDebugCapsulePlanError);
  });

  it.each([
    {
      immutableMounts: [
        { hostPath: "/x", capsulePath: "/opt/debug/adapter", identityDigest: "a".repeat(64) },
        { hostPath: "/y", capsulePath: "/opt/debug/adapter", identityDigest: "b".repeat(64) },
      ],
    },
    {
      immutableMounts: [
        { hostPath: "/x", capsulePath: "/keiko-execution-root", identityDigest: "a".repeat(64) },
      ],
    },
    {
      immutableMounts: [
        { hostPath: "/x", capsulePath: "/keiko-execution-root/x", identityDigest: "a".repeat(64) },
      ],
    },
    { immutableMounts: [{ hostPath: "/x", capsulePath: "/run", identityDigest: "a".repeat(64) }] },
    {
      immutableMounts: [
        { hostPath: "/", capsulePath: "/opt/debug/adapter", identityDigest: "a".repeat(64) },
      ],
    },
    { immutableMounts: [{ hostPath: "/x", capsulePath: "/", identityDigest: "a".repeat(64) }] },
    {
      immutableMounts: [
        { hostPath: "x", capsulePath: "/opt/debug/adapter", identityDigest: "a".repeat(64) },
      ],
    },
    {
      immutableMounts: [{ hostPath: "/x", capsulePath: "adapter", identityDigest: "a".repeat(64) }],
    },
    {
      immutableMounts: [
        { hostPath: "/x", capsulePath: "/opt/debug/adapter", identityDigest: "A".repeat(64) },
      ],
    },
  ])(
    "rejects duplicate, overlapping, broad, relative, or unverified immutable mounts",
    ({ immutableMounts }) => {
      expect(() => planStrictDebugCapsule({ ...input, immutableMounts })).toThrow(
        StrictDebugCapsulePlanError,
      );
    },
  );

  it("derives a qualified Windows container identity only from a digest-pinned container", () => {
    const plan = planStrictDebugCapsule({
      ...input,
      platform: "win32",
      availability: {
        bubblewrap: false,
        unshare: false,
        seatbelt: false,
        docker: true,
        podman: false,
      },
    });
    expect(plan).toMatchObject({
      backend: "windowsContainer",
      command: "/usr/bin/docker",
      initMechanism: "ociInit",
    });
  });

  it.each([undefined, "node:latest", "node@sha256:short"])(
    "rejects a mutable OCI image %s",
    (containerImage) => {
      expect(() =>
        planStrictDebugCapsule({
          ...input,
          availability: { ...input.availability, bubblewrap: false, docker: true },
          containerImage,
        }),
      ).toThrow(StrictDebugCapsulePlanError);
    },
  );

  it("runs every independent strict-input denial in one mutation-complete test", () => {
    const invalidInputs = [
      { ...input, executionRoot: "relative" },
      { ...input, runtimeHostDirectory: "relative" },
      { ...input, runtimeCapsuleDirectory: "relative" },
      { ...input, adapterCapsuleExecutable: "relative" },
      { ...input, executionRoot: "/workspace\u0000x" },
      { ...input, runtimeIdentityDigest: "A".repeat(64) },
      { ...input, executionRootIdentityDigest: "A".repeat(64) },
      { ...input, runtimeMountIdentityDigest: "A".repeat(64) },
      { ...input, runtimeCapsuleDirectory: "/run/../keiko-debug" },
      { ...input, runtimeHostDirectory: "/workspace/runtime" },
      { ...input, backendExecutables: undefined },
      { ...input, backendExecutableIdentityDigests: undefined },
      { ...input, immutableMounts: [] },
      {
        ...input,
        immutableMounts: [
          { hostPath: "/x", capsulePath: "/opt/debug/adapter", identityDigest: "a".repeat(64) },
          { hostPath: "/y", capsulePath: "/opt/debug/adapter", identityDigest: "b".repeat(64) },
        ],
      },
      {
        ...input,
        immutableMounts: [
          ...input.immutableMounts,
          { hostPath: "/x", capsulePath: "/keiko-execution-root", identityDigest: "a".repeat(64) },
        ],
      },
      {
        ...input,
        immutableMounts: [
          ...input.immutableMounts,
          { hostPath: "/x", capsulePath: "/run", identityDigest: "a".repeat(64) },
        ],
      },
      {
        ...input,
        immutableMounts: [
          { hostPath: "/", capsulePath: "/opt/debug/adapter", identityDigest: "a".repeat(64) },
        ],
      },
      {
        ...input,
        immutableMounts: [{ hostPath: "/x", capsulePath: "/", identityDigest: "a".repeat(64) }],
      },
      {
        ...input,
        immutableMounts: [
          { hostPath: "x", capsulePath: "/opt/debug/adapter", identityDigest: "a".repeat(64) },
        ],
      },
      {
        ...input,
        immutableMounts: [
          { hostPath: "/x", capsulePath: "adapter", identityDigest: "a".repeat(64) },
        ],
      },
      {
        ...input,
        immutableMounts: [
          { hostPath: "/x", capsulePath: "/opt/debug/adapter", identityDigest: "A".repeat(64) },
        ],
      },
      {
        ...input,
        availability: { ...input.availability, bubblewrap: false, docker: true },
        containerImage: undefined,
      },
      {
        ...input,
        availability: { ...input.availability, bubblewrap: false, docker: true },
        containerImage: "node:latest",
      },
    ];
    for (const invalid of invalidInputs) {
      expect(() => planStrictDebugCapsule(invalid)).toThrow(StrictDebugCapsulePlanError);
    }
  });
});
