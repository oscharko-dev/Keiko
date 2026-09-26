import { describe, expect, it } from "vitest";
import { memFs } from "./_memfs.js";
import { detectWorkspaceAt } from "./detect.js";
import { discoverFiles } from "./discovery.js";
import type {
  WorkspaceDescriptorUtf8Read,
  WorkspaceDirEntry,
  WorkspaceFs,
  WorkspaceHardLinkPolicy,
  WorkspaceStat,
} from "./fs.js";
import { workspaceFsWithOwnedRootAuthority } from "./ownedRootMint.js";
import { DEFAULT_DISCOVERY_OPTIONS } from "./types.js";

class MethodBackedWorkspaceFs implements WorkspaceFs {
  readonly #delegate: WorkspaceFs;

  public constructor(delegate: WorkspaceFs) {
    this.#delegate = delegate;
  }

  public readFileUtf8(path: string): string {
    return this.#delegate.readFileUtf8(path);
  }

  public readFileUtf8SameDescriptor(
    path: string,
    maxBytes: number,
    _policy: WorkspaceHardLinkPolicy,
  ): WorkspaceDescriptorUtf8Read {
    const rawText = this.#delegate.readFileUtf8(path).slice(0, maxBytes);
    return { rawText, sizeBytes: Buffer.byteLength(rawText), stat: this.#delegate.stat(path) };
  }

  public stat(path: string): WorkspaceStat {
    return this.#delegate.stat(path);
  }

  public readDir(path: string, maxEntries?: number): readonly WorkspaceDirEntry[] {
    return this.#delegate.readDir(path, maxEntries);
  }

  public realPath(path: string): string {
    return this.#delegate.realPath(path);
  }

  public canonicalWorkspaceRoot(path: string): string {
    return this.#delegate.realPath(path);
  }

  public exists(path: string): boolean {
    return this.#delegate.exists(path);
  }
}

describe("owned-root WorkspaceFs forwarding", () => {
  it("preserves a method-backed adapter through detection, binding, and discovery", () => {
    const root = "/home/user/.keiko/task-workspaces/repo_a/ws_b";
    const source = new MethodBackedWorkspaceFs(
      memFs(root, {
        "package.json": JSON.stringify({ name: "managed-workspace" }),
        "src/app.ts": "export const ready = true;\n",
      }),
    );
    const fs = workspaceFsWithOwnedRootAuthority(source, root);

    const workspace = detectWorkspaceAt(root, fs);
    const files = discoverFiles(workspace, DEFAULT_DISCOVERY_OPTIONS, fs);

    expect(workspace).toMatchObject({ root, name: "managed-workspace" });
    expect(files.map((file) => file.relativePath)).toContain("src/app.ts");
  });
});
