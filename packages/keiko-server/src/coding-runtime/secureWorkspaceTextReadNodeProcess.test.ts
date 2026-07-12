/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
  createNodeSecureWorkspaceReadProcessFactory,
  type SecureWorkspaceReadNodeChild,
} from "./secureWorkspaceTextReadNodeProcess.js";
import type { PortableSecureWorkspaceReadBinding } from "./secureWorkspaceTextReadPortable.js";

const artifact = {
  target: "darwin-arm64",
  installRelativePath: "runtime/native/keiko-secure-workspace-read",
  sha256: "a".repeat(64),
  protocol: "KSR1/KSS1",
  sourceCommit: "b".repeat(40),
  sourceTreeSha256: "c".repeat(64),
  signed: true,
} as const;

const binding: PortableSecureWorkspaceReadBinding = {
  artifact,
  executable:
    "/Applications/Keiko.app/Contents/Resources/runtime/native/keiko-secure-workspace-read",
  helperSizeBytes: 1024,
  resourceRoot: "/Applications/Keiko.app/Contents/Resources",
};

function fakeChild() {
  const events = new EventEmitter();
  const child: SecureWorkspaceReadNodeChild = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    on: events.on.bind(events),
    once: events.once.bind(events),
  };
  return { child, close: (code: number | null): void => events.emit("close", code) };
}

describe("Node secure workspace-read process adapter", () => {
  it("spawns the closed executable with fixed empty launch authority", async () => {
    const fake = fakeChild();
    const spawn = vi.fn(() => fake.child);
    const factory = createNodeSecureWorkspaceReadProcessFactory({
      binding,
      safeCwd: "/Applications/Keiko.app/Contents/Resources/runtime",
      spawn,
    });
    const process = factory.create(artifact);
    const run = process.run({
      stdin: Buffer.from("KSR1"),
      signal: new AbortController().signal,
    });

    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      binding.executable,
      [],
      expect.objectContaining({
        cwd: "/Applications/Keiko.app/Contents/Resources/runtime",
        env: {},
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
    fake.child.stdout.write("KSS1");
    fake.close(0);
    await expect(run).resolves.toEqual(Buffer.from("KSS1"));
  });

  it("kills and waits for close before settling cancellation", async () => {
    const fake = fakeChild();
    const factory = createNodeSecureWorkspaceReadProcessFactory({
      binding,
      safeCwd: "/Applications/Keiko.app/Contents/Resources/runtime",
      spawn: () => fake.child,
    });
    const controller = new AbortController();
    const run = factory
      .create(artifact)
      .run({ stdin: Buffer.from("KSR1"), signal: controller.signal });
    controller.abort();

    expect(fake.child.kill).toHaveBeenCalledWith("SIGKILL");
    let settled = false;
    void run.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.close(null);
    await expect(run).rejects.toThrow("secure-workspace-read-aborted");
  });

  it("rejects any artifact other than the closed portable binding", () => {
    const factory = createNodeSecureWorkspaceReadProcessFactory({
      binding,
      safeCwd: "/Applications/Keiko.app/Contents/Resources/runtime",
      spawn: () => fakeChild().child,
    });
    expect(() => factory.create({ ...artifact, sha256: "d".repeat(64) })).toThrow(
      "secure-workspace-read-artifact-mismatch",
    );
  });
});
