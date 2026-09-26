import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadServer } from "./lazy-modules.js";
import { activateMacosPortableRuntime } from "./portable-macos-activation.js";
import { layoutFor } from "./portable-shared.js";

const roots: string[] = [];

function activationFixture(): {
  readonly root: string;
  readonly manager: string;
  readonly layout: ReturnType<typeof layoutFor>;
} {
  const root = join(homedir(), ".keiko-test-roots", `macos-activation-${randomUUID()}`);
  const layout = layoutFor("macos-arm64", join(root, "Keiko.app"));
  const manager = join(layout.installRoot, "Contents", "MacOS", "KeikoSystemExtensionManager");
  mkdirSync(join(layout.installRoot, "Contents", "MacOS"), { recursive: true });
  writeFileSync(manager, "fixture manager\n");
  roots.push(root);
  return { root, manager, layout };
}

// The production signature probe lives behind `loadServer()` — the whole keiko-server module graph,
// imported lazily (GEN-PERF-CLI-001). That import is the only slow thing in this file: under V8
// coverage instrumentation it alone exceeds vitest's default 5 s per-test budget, which made the
// "through the production probe" case time out intermittently while asserting nothing about time.
// Paying the import once here keeps that test measuring its own logic; the bound is on the HOOK and
// states what it covers (one cold module-graph load), so a real hang still fails rather than waits.
const SERVER_GRAPH_WARMUP_MS = 60_000;

beforeAll(async () => {
  await loadServer();
}, SERVER_GRAPH_WARMUP_MS);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("activateMacosPortableRuntime", () => {
  it("accepts only the manager's closed active result on a release-signed install", async () => {
    const fixture = activationFixture();
    const calls: string[][] = [];

    const activation = await activateMacosPortableRuntime(fixture.layout, "macos-arm64", {
      carriesReleaseSignature: () => true,
      verifyImmutableOwnership: () => true,
      runManager: (path, cwd) => {
        calls.push([path, cwd]);
        return Promise.resolve({ ok: true, stdout: "active\n", stderr: "" });
      },
    });

    expect(activation).toBe("active");
    expect(calls).toEqual([[fixture.manager, fixture.layout.installRoot]]);
  });

  it("waives containment for an install without a release signature and never probes the manager", async () => {
    // The v0.3.0-beta.0 incident: an unsigned evaluation install can never load its Endpoint
    // Security extension, so requiring activation turned every double-click into a silent exit 1.
    const fixture = activationFixture();
    const probed: string[][] = [];
    let managerExecuted = false;

    const activation = await activateMacosPortableRuntime(fixture.layout, "macos-arm64", {
      carriesReleaseSignature: (installRoot, target) => {
        probed.push([installRoot, target]);
        return false;
      },
      runManager: () => {
        managerExecuted = true;
        return Promise.resolve({ ok: true, stdout: "active\n", stderr: "" });
      },
    });

    expect(activation).toBe("waived-unsigned");
    // The probe receives the RESOURCE root — the shape the server's lane-downgrade guard derives
    // its app root from. Handing it the bundle path instead would silently classify every install,
    // signed included, as unsigned (caught on #3026 by pinning this exact argument).
    expect(probed).toEqual([[fixture.layout.resourceRoot, "macos-arm64"]]);
    expect(managerExecuted).toBe(false);
  });

  it("waives through the production probe when the install carries no signable code", async () => {
    // No seams for the signature anchor: the real lazy-loaded server probe runs against a root
    // whose resource layout carries no Endpoint Security surface, which is deterministic on every
    // host — there is no signable code, so no platform verifier is ever spawned.
    const fixture = activationFixture();
    let managerExecuted = false;

    const activation = await activateMacosPortableRuntime(fixture.layout, "macos-arm64", {
      runManager: () => {
        managerExecuted = true;
        return Promise.resolve({ ok: true, stdout: "active\n", stderr: "" });
      },
    });

    expect(activation).toBe("waived-unsigned");
    expect(managerExecuted).toBe(false);
  });

  it("fails closed to unavailable when the signature probe itself rejects", async () => {
    // A rejected probe (or failed lazy server load) must resolve to the fail-closed value, never
    // escape the MacosRuntimeActivation contract as a rejection (#3026 review finding).
    const fixture = activationFixture();

    await expect(
      activateMacosPortableRuntime(fixture.layout, "macos-arm64", {
        carriesReleaseSignature: () => Promise.reject(new Error("probe unavailable")),
        runManager: () => Promise.resolve({ ok: true, stdout: "active\n", stderr: "" }),
      }),
    ).resolves.toBe("unavailable");
  });

  it("lets the platform anchor decide before any manager result", async () => {
    // Even a manager that would report "active" must not upgrade an unsigned install: the waiver
    // is the platform's answer, not the artifact's.
    const fixture = activationFixture();

    const activation = await activateMacosPortableRuntime(fixture.layout, "macos-arm64", {
      carriesReleaseSignature: () => false,
      verifyImmutableOwnership: () => true,
      runManager: () => Promise.resolve({ ok: true, stdout: "active\n", stderr: "" }),
    });

    expect(activation).toBe("waived-unsigned");
  });

  it.each([
    [{ ok: false, stdout: "active\n", stderr: "" }],
    [{ ok: true, stdout: "needs-full-disk-access\n", stderr: "" }],
    [{ ok: true, stdout: "active\n", stderr: "unexpected" }],
  ] as const)("fails closed for a non-active manager result", async (result) => {
    const fixture = activationFixture();

    await expect(
      activateMacosPortableRuntime(fixture.layout, "macos-arm64", {
        carriesReleaseSignature: () => true,
        verifyImmutableOwnership: () => true,
        runManager: () => Promise.resolve(result),
      }),
    ).resolves.toBe("unavailable");
  });

  it("rejects a linked activation manager before execution", async () => {
    const fixture = activationFixture();
    const outside = join(fixture.root, "outside");
    let executed = false;
    rmSync(fixture.manager);
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, fixture.manager);

    const activation = await activateMacosPortableRuntime(fixture.layout, "macos-arm64", {
      carriesReleaseSignature: () => true,
      verifyImmutableOwnership: () => true,
      runManager: () => {
        executed = true;
        return Promise.resolve({ ok: true, stdout: "active\n", stderr: "" });
      },
    });

    expect(activation).toBe("unavailable");
    expect(executed).toBe(false);
  });

  it("rejects a mutable or non-root-owned activation path before execution", async () => {
    const fixture = activationFixture();
    let executed = false;

    const activation = await activateMacosPortableRuntime(fixture.layout, "macos-arm64", {
      carriesReleaseSignature: () => true,
      verifyImmutableOwnership: () => false,
      runManager: () => {
        executed = true;
        return Promise.resolve({ ok: true, stdout: "active\n", stderr: "" });
      },
    });

    expect(activation).toBe("unavailable");
    expect(executed).toBe(false);
  });

  it("applies the production root-ownership check before manager execution", async () => {
    const fixture = activationFixture();
    let executed = false;

    const activation = await activateMacosPortableRuntime(fixture.layout, "macos-arm64", {
      carriesReleaseSignature: () => true,
      runManager: () => {
        executed = true;
        return Promise.resolve({ ok: true, stdout: "active\n", stderr: "" });
      },
    });

    expect(activation).toBe("unavailable");
    expect(executed).toBe(false);
  });
});
