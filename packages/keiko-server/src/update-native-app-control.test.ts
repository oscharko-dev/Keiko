import { duplexPair, type Duplex } from "node:stream";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeNativeAppControlFrame,
  type NativeAppControlKind,
} from "@oscharko-dev/keiko-contracts/runtime/native-runtime-wire";
import { currentNativeAppControl, NativeAppControl } from "./update-native-app-control.js";
import { NativeAppControlStream } from "./update-native-app-control-stream.js";

const launchId = "b".repeat(32);
const binding = {
  activationId: "a".repeat(32),
  planSha256: "c".repeat(64),
  coordinatorSha256: "d".repeat(64),
  launchId,
};
const streams: Duplex[] = [];

function fixture(): { readonly control: NativeAppControl; readonly peer: Duplex } {
  const [socket, peer] = duplexPair();
  streams.push(socket, peer);
  return { control: new NativeAppControl(new NativeAppControlStream(socket), 123, launchId), peer };
}

function hello(peer: Duplex, root = 123, owner = 124, launch = launchId): void {
  const payload = Buffer.alloc(40);
  payload.writeUInt32LE(root, 0);
  payload.writeUInt32LE(owner, 4);
  payload.write(launch, 8, "ascii");
  peer.write(encodeNativeAppControlFrame(1, payload));
}

function reply(peer: Duplex, kind: NativeAppControlKind, suffix = Buffer.alloc(0)): void {
  peer.write(
    encodeNativeAppControlFrame(kind, Buffer.concat([Buffer.from(binding.activationId), suffix])),
  );
}

async function started(
  control: NativeAppControl,
  peer: Duplex,
  deadline = performance.now() + 1000,
): Promise<void> {
  const ready = control.ready(performance.now() + 1000);
  hello(peer);
  await ready;
  const pending = control.start(binding, deadline);
  const pid = Buffer.alloc(4);
  pid.writeUInt32LE(125);
  reply(peer, 3, pid);
  expect(await pending).toBe(125);
}

afterEach(() => {
  for (const stream of streams.splice(0)) stream.destroy();
  vi.unstubAllEnvs();
});

describe("native app handoff control", () => {
  it.runIf(process.platform === "darwin")("refuses an unowned Mac application", async () => {
    vi.stubEnv("KEIKO_APP_RUNTIME_OWNER", undefined);
    await expect(currentNativeAppControl(launchId)).rejects.toMatchObject({
      nativeAuthorityMayBeLive: false,
    });
  });
  it.each([
    [122, 124, launchId],
    [123, 123, launchId],
    [123, 0, launchId],
    [123, 124, "e".repeat(32)],
  ] as const)("refuses an unbound owner hello (%s, %s, %s)", async (root, owner, launch) => {
    const { control, peer } = fixture();
    const pending = control.ready(performance.now() + 1000);
    hello(peer, root, owner, launch);
    await expect(pending).rejects.toMatchObject({ nativeAuthorityMayBeLive: false });
  });

  it("sends only the selected binding and the original monotonic deadline", async () => {
    const { control, peer } = fixture();
    const requests: Buffer[] = [];
    peer.on("data", (bytes: Buffer) => requests.push(bytes));
    const before = process.hrtime.bigint() / 1_000_000n;
    await started(control, peer);
    const request = Buffer.concat(requests);
    expect(request).toHaveLength(212);
    expect(request.subarray(12, 44).toString("ascii")).toBe(binding.activationId);
    expect(request.subarray(44, 108).toString("ascii")).toBe(binding.planSha256);
    expect(request.subarray(108, 172).toString("ascii")).toBe(binding.coordinatorSha256);
    expect(request.subarray(172, 204).toString("ascii")).toBe(launchId);
    expect(request.readBigUInt64LE(204)).toBeGreaterThan(before);
    expect(request.readBigUInt64LE(204)).toBeLessThanOrEqual(before + 1000n);
  });

  it.each([0, 123, 124])("refuses a non-owned coordinator identity %s", async (pid) => {
    const { control, peer } = fixture();
    const ready = control.ready(performance.now() + 1000);
    hello(peer);
    await ready;
    const pending = control.start(binding, performance.now() + 1000);
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(pid);
    reply(peer, 3, bytes);
    await expect(pending).rejects.toMatchObject({ nativeAuthorityMayBeLive: true });
  });

  it("requires the same plan before committing and retains authority until positive cancellation", async () => {
    const { control, peer } = fixture();
    await started(control, peer);
    const accepted = control.accept(performance.now() + 1000);
    reply(peer, 5, Buffer.from("e".repeat(64)));
    await expect(accepted).rejects.toMatchObject({ nativeAuthorityMayBeLive: true });
    const cancelled = control.cancel(binding.activationId);
    reply(peer, 9);
    await cancelled;
    await expect(control.commit(performance.now() + 1000)).rejects.toMatchObject({
      nativeAuthorityMayBeLive: false,
    });
  });

  it("requires matching acceptance and commit responses", async () => {
    const { control, peer } = fixture();
    await started(control, peer);
    const accepted = control.accept(performance.now() + 1000);
    reply(peer, 5, Buffer.from(binding.planSha256));
    await accepted;
    const committed = control.commit(performance.now() + 1000);
    reply(peer, 7);
    await committed;
    await expect(control.start(binding, performance.now() + 1000)).rejects.toMatchObject({
      nativeAuthorityMayBeLive: true,
    });
  });

  it.each([7, 10] as const)(
    "consumes a late response %s before the positive owned cancellation receipt",
    async (kind) => {
      const { control, peer } = fixture();
      await started(control, peer);
      const cancelled = control.cancel(binding.activationId);
      reply(peer, kind, kind === 10 ? Buffer.alloc(2) : undefined);
      reply(peer, 9);
      await expect(cancelled).resolves.toBeUndefined();
    },
  );

  it("does not treat EOF or a different activation as positive cleanup", async () => {
    const { control, peer } = fixture();
    await started(control, peer);
    const cancelled = control.cancel(binding.activationId);
    peer.write(encodeNativeAppControlFrame(9, Buffer.from("e".repeat(32))));
    peer.end();
    await expect(cancelled).rejects.toMatchObject({ nativeAuthorityMayBeLive: true });
    await expect(control.start(binding, performance.now() + 1000)).rejects.toMatchObject({
      nativeAuthorityMayBeLive: true,
    });
  });
});
