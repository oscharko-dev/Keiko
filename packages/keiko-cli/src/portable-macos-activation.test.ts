import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("activateMacosPortableRuntime", () => {
  it("accepts only the manager's closed active result", async () => {
    const fixture = activationFixture();
    const calls: string[][] = [];

    const active = await activateMacosPortableRuntime(fixture.layout, {
      verifyImmutableOwnership: () => true,
      runManager: (path, cwd) => {
        calls.push([path, cwd]);
        return Promise.resolve({ ok: true, stdout: "active\n", stderr: "" });
      },
    });

    expect(active).toBe(true);
    expect(calls).toEqual([[fixture.manager, fixture.layout.installRoot]]);
  });

  it.each([
    [{ ok: false, stdout: "active\n", stderr: "" }],
    [{ ok: true, stdout: "needs-full-disk-access\n", stderr: "" }],
    [{ ok: true, stdout: "active\n", stderr: "unexpected" }],
  ] as const)("fails closed for a non-active manager result", async (result) => {
    const fixture = activationFixture();

    await expect(
      activateMacosPortableRuntime(fixture.layout, {
        verifyImmutableOwnership: () => true,
        runManager: () => Promise.resolve(result),
      }),
    ).resolves.toBe(false);
  });

  it("rejects a linked activation manager before execution", async () => {
    const fixture = activationFixture();
    const outside = join(fixture.root, "outside");
    let executed = false;
    rmSync(fixture.manager);
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, fixture.manager);

    const active = await activateMacosPortableRuntime(fixture.layout, {
      verifyImmutableOwnership: () => true,
      runManager: () => {
        executed = true;
        return Promise.resolve({ ok: true, stdout: "active\n", stderr: "" });
      },
    });

    expect(active).toBe(false);
    expect(executed).toBe(false);
  });

  it("rejects a mutable or non-root-owned activation path before execution", async () => {
    const fixture = activationFixture();
    let executed = false;

    const active = await activateMacosPortableRuntime(fixture.layout, {
      verifyImmutableOwnership: () => false,
      runManager: () => {
        executed = true;
        return Promise.resolve({ ok: true, stdout: "active\n", stderr: "" });
      },
    });

    expect(active).toBe(false);
    expect(executed).toBe(false);
  });
});
