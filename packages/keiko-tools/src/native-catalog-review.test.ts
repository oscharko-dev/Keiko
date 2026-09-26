import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";
import { makeWorkspace } from "./_support.js";
import { WorkspaceToolHost } from "./registry.js";
import { workspaceToolDescriptor } from "./catalog.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("rechecks catalog patch authority after source validation before the first filesystem effect", async () => {
  const { root, info } = makeWorkspace();
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/x.txt"), "one\ntwo\n");
  let allowed = true;
  const read = nodeWorkspaceFs.readFileUtf8SameDescriptor;
  if (read === undefined) throw new TypeError("Production descriptor reader missing");
  const host = new WorkspaceToolHost({
    workspace: info,
    config: { applyEnabled: true },
    fs: {
      ...nodeWorkspaceFs,
      readFileUtf8SameDescriptor: (...args): ReturnType<typeof read> => {
        const value = read(...args);
        allowed = false;
        return value;
      },
      readFileUtf8: (path): string => {
        const value = nodeWorkspaceFs.readFileUtf8(path);
        allowed = false;
        return value;
      },
    },
  });
  const descriptor = workspaceToolDescriptor("apply_patch");
  await expect(
    host.executeCatalog({
      toolCallId: "invocation-1",
      toolRef: descriptor.toolRef,
      descriptorDigest: descriptor.descriptorDigest,
      arguments: { diff: "--- a/src/x.txt\n+++ b/src/x.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n" },
      signal: new AbortController().signal,
      beforeEffect: () => allowed,
      observeExecution: vi.fn(),
    }),
  ).rejects.toThrow();
  expect(readFileSync(join(root, "src/x.txt"), "utf8")).toBe("one\ntwo\n");
});
