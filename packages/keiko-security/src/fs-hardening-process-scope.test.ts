import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, closeSync, mkdtempSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
  vi.doUnmock("./process-scope.js");
  vi.resetModules();
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
}
type OwnerProbe = (descriptor: number, stat: Identity) => bigint | undefined;
async function namespacePolicy(probe: OwnerProbe): Promise<typeof import("./fs-hardening.js")> {
  const original = await vi.importActual<typeof import("./process-scope.js")>("./process-scope.js");
  vi.doMock("./process-scope.js", () => ({
    ...original,
    currentProcessScopeKind: (): string => "outer-native",
    fileDescriptorOwnerUid: probe,
  }));
  return import("./fs-hardening.js");
}

function fixture(): { root: string; file: string; parent: Identity } {
  const root = mkdtempSync(join(tmpdir(), "keiko-scope-policy-"));
  roots.push(root);
  const parentPath = join(root, "parent");
  mkdirSync(parentPath, { mode: 0o700 });
  return {
    root,
    file: join(parentPath, "artifact"),
    parent: statSync(parentPath, { bigint: true }),
  };
}

function expectRefusal(
  policy: typeof import("./fs-hardening.js"),
  item: { readonly root: string; readonly file: string },
  kind: string,
): void {
  let descriptor: number | undefined;
  try {
    expect(() => {
      descriptor = policy.openSafeArtifactFile(item.file, {
        artifactClass: "manifest",
        mode: "exclusive-create",
        trustedRoot: item.root,
      });
    }).toThrow(expect.objectContaining({ kind }));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

describe.skipIf(process.platform === "win32")("native coordinate filesystem ownership", () => {
  it.each(["foreign", "unknown"])(
    "refuses %s ownership even when mapped stat looks self-owned",
    async (mode) => {
      const item = fixture();
      const policy = await namespacePolicy((_fd, stat) =>
        stat.ino === item.parent.ino && stat.dev === item.parent.dev
          ? mode === "foreign"
            ? stat.uid + 1n
            : undefined
          : stat.uid,
      );
      expectRefusal(policy, item, "unsafe-ancestor");
    },
  );

  it("accepts positively observed root and genuine caller-owned ancestors", async () => {
    const item = fixture(),
      policy = await namespacePolicy((_fd, stat) => stat.uid);
    const descriptor = policy.openSafeArtifactFile(item.file, {
      artifactClass: "manifest",
      mode: "exclusive-create",
      trustedRoot: item.root,
    });
    closeSync(descriptor);
    expect(statSync(item.file).size).toBe(0);
  });

  it.each(["owner", "mode"])(
    "rechecks a same-inode %s change before returning a writable handle",
    async (fault) => {
      const item = fixture();
      let changed = false;
      const policy = await namespacePolicy((_fd, stat) => {
        if (stat.ino !== item.parent.ino && (stat.mode & 0o170000n) === 0o100000n) {
          changed = true;
          if (fault === "mode") chmodSync(join(item.root, "parent"), 0o777);
        }
        return changed && fault === "owner" && stat.ino === item.parent.ino
          ? stat.uid + 1n
          : stat.uid;
      });
      try {
        expectRefusal(policy, item, "target-mutated");
        expect(changed).toBe(true);
        expect(statSync(item.file).size).toBe(0);
      } finally {
        chmodSync(join(item.root, "parent"), 0o700);
      }
    },
  );
});
