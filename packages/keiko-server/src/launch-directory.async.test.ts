import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pathDenialCauseAsync, pathIsDeniedAsync } from "./files-deny.js";
import { installationDenialCauseAsync, PROGRAM_FOLDER_LAUNCH_ENV } from "./launch-directory.js";

// The canonical check of the asynchronous predicate must never call the blocking realpath: the
// synchronous one is replaced by a function that fails the test when it is reached.
const blockedCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const blocked = (): never => {
    blockedCalls.count += 1;
    throw new Error("synchronous realpath reached the event loop");
  };
  return { ...actual, realpathSync: Object.assign(blocked, { native: blocked }) };
});

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  // The test's own canonical name comes from the real implementation, not the blocked one.
  const root = mkdtempSync(join(tmpdir(), "keiko-launch-async-"));
  roots.push(root);
  return root;
}

describe("installationDenialCauseAsync", () => {
  it("leaves an ordinary folder alone without a blocking realpath", async () => {
    const root = folder();
    mkdirSync(join(root, "project"));
    await expect(installationDenialCauseAsync(join(root, "project"))).resolves.toBeUndefined();
    await expect(pathIsDeniedAsync(join(root, "project"))).resolves.toBe(false);
    await expect(installationDenialCauseAsync(join(root, "no-such"))).resolves.toBeUndefined();
  });

  it("still follows a link to an installation payload and refuses it", async () => {
    const root = folder();
    const payload = join(root, "system", "Keiko", "app");
    mkdirSync(payload, { recursive: true });
    symlinkSync(payload, join(root, "alias"), "dir");
    await expect(installationDenialCauseAsync(join(root, "alias"))).resolves.toBe(
      "installation-payload",
    );
    await expect(pathDenialCauseAsync(join(root, "alias"))).resolves.toBe("installation-payload");
  });

  it("keeps the lexical exclusions: deny list, payload layout and program folder", async () => {
    await expect(pathDenialCauseAsync("/Users/me/.ssh/id_rsa")).resolves.toBe("deny-list");
    await expect(installationDenialCauseAsync("/Users/me/Keiko/system/Keiko/app")).resolves.toBe(
      "installation-payload",
    );
    const root = folder();
    const program = join(root, "Keiko");
    mkdirSync(join(program, "node_modules"), { recursive: true });
    vi.stubEnv(PROGRAM_FOLDER_LAUNCH_ENV, "1");
    await expect(
      installationDenialCauseAsync(join(program, "node_modules"), process.env, program),
    ).resolves.toBe("program-folder");
  });

  it("refuses a path whose canonical name cannot be given, for a reason other than not existing", async () => {
    // A link loop fails the canonical resolution with ELOOP: fail closed.
    const root = folder();
    symlinkSync(join(root, "b"), join(root, "a"));
    symlinkSync(join(root, "a"), join(root, "b"));
    await expect(installationDenialCauseAsync(join(root, "a"))).resolves.toBe("unresolvable-name");
  });
});

describe("the blocking predicate under the same guard", () => {
  it("is what the guard catches, so the asynchronous tests above prove a real difference", async () => {
    const { installationDenialCause } = await import("./launch-directory.js");
    const root = folder();
    expect(realpathSync).toBeTypeOf("function");
    expect(installationDenialCause(join(root, "project"))).toBe("unresolvable-name");
  });
});

describe("a launch directory on an unresponsive mount", () => {
  it("is resolved off the event loop by the asynchronous predicate", async () => {
    vi.stubEnv(PROGRAM_FOLDER_LAUNCH_ENV, "1");
    const before = blockedCalls.count;
    const cause = await installationDenialCauseAsync(
      "/Users/me/project",
      process.env,
      "/mnt/unresponsive-share/Keiko-launch",
    );
    expect(blockedCalls.count).toBe(before);
    expect(cause).toBeUndefined();
  });

  it("is still refused when it contains the path", async () => {
    const root = folder();
    vi.stubEnv(PROGRAM_FOLDER_LAUNCH_ENV, "1");
    await expect(
      installationDenialCauseAsync(join(root, "inner"), process.env, root),
    ).resolves.toBe("program-folder");
  });
});
