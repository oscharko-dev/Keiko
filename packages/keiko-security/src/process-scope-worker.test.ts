import { once } from "node:events";
import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindWorkerProcessScope,
  createProcessScopeWorkerBridge,
  type ProcessScopeWorkerBridge,
} from "./process-scope-worker.js";

const state = vi.hoisted(() => ({
  kind: "outer-native",
  observation: "ready",
  owner: vi.fn<(...args: readonly unknown[]) => bigint | undefined>(),
  probe: vi.fn<(pid: number) => "alive" | "dead" | "unknown">(),
}));

vi.mock("./process-scope.js", async (original) => ({
  ...(await original<typeof import("./process-scope.js")>()),
  currentProcessId: (): number => 4321,
  currentProcessScopeKind: (): string => state.kind,
  currentProcessScopeObservation: (): string => state.observation,
  processFileOwnerUid: state.owner,
  processLiveness: state.probe,
}));

const bridges: ProcessScopeWorkerBridge[] = [];
const workers: Worker[] = [];

beforeEach(() => {
  state.kind = "outer-native";
  state.observation = "ready";
  state.owner.mockReset().mockReturnValue(1000n);
  state.probe
    .mockReset()
    .mockImplementation((pid) => (pid === 2001 ? "alive" : pid === 2002 ? "dead" : "unknown"));
});

afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  await Promise.all(
    workers.splice(0).map(async (worker): Promise<void> => {
      await worker.terminate();
    }),
  );
});

function bridge(): ProcessScopeWorkerBridge {
  const value = createProcessScopeWorkerBridge();
  if (value === undefined) throw new Error("native bridge absent");
  bridges.push(value);
  return value;
}

async function observe(
  scope: unknown,
  ports: MessagePort[],
  mode = "normal",
  descriptor = 9,
): Promise<unknown> {
  const worker = new Worker(
    new URL(
      "../../../native/runtime-supervisor/process_scope_observer_worker_fixture.mjs",
      import.meta.url,
    ),
    {
      workerData: { scope, mode, descriptor },
      transferList: ports,
    },
  );
  workers.push(worker);
  const values = (await once(worker, "message")) as readonly unknown[];
  return values[0];
}

function send(
  owned: ProcessScopeWorkerBridge,
  overrides: Record<string, unknown> = {},
): Int32Array {
  const reply = new SharedArrayBuffer(16);
  owned.data.port.postMessage({
    kind: "owner",
    descriptor: 9,
    dev: 0x20000000000001n,
    ino: 0xffffffffffffffffn,
    mode: 0o100600n,
    reply,
    deadline: process.hrtime.bigint() + 5_000_000_000n,
    ...overrides,
  });
  return new Int32Array(reply);
}

async function barrier(owned: ProcessScopeWorkerBridge): Promise<void> {
  const reply = new Int32Array(new SharedArrayBuffer(16));
  owned.data.port.postMessage({
    kind: "observation",
    reply: reply.buffer,
    deadline: process.hrtime.bigint() + 5_000_000_000n,
  });
  await vi.waitFor(() => {
    expect(Atomics.load(reply, 0)).toBe(2);
  });
}

describe("private main-scope Worker observations", () => {
  it("leaves ordinary local Workers on their existing local scope", () => {
    state.kind = "local";
    expect(createProcessScopeWorkerBridge()).toBeUndefined();
    expect(state.owner).not.toHaveBeenCalled();
  });

  it("refuses Worker binding in the main thread", () => {
    expect(() => {
      bindWorkerProcessScope(bridge().data);
    }).toThrow();
    expect(state.owner).not.toHaveBeenCalled();
  });

  it.each([0n, 1000n, 65534n, 0xffffffffn])(
    "transports UID %s and exact outer observations to a real Worker",
    async (uid) => {
      const owned = bridge();
      state.owner.mockReturnValue(uid);
      expect(await observe(owned.data, [owned.data.port])).toEqual({
        first: uid,
        pid: 4321,
        kind: "outer-native",
        liveness: ["alive", "dead", "unknown"],
        observation: "ready",
      });
      expect(state.owner).toHaveBeenCalledExactlyOnceWith(
        9,
        0x20000000000001n,
        0xffffffffffffffffn,
        0o100600n,
      );
    },
  );

  it("keeps a closed metadata refusal separate from root availability", async () => {
    const owned = bridge();
    state.owner.mockReturnValue(undefined);
    expect(await observe(owned.data, [owned.data.port], "one")).toEqual({ first: undefined });
    expect(state.observation).toBe("ready");
    expect(state.owner).toHaveBeenCalledOnce();
  });

  it("does not publish ownership from an unavailable selected root", async () => {
    const owned = bridge();
    state.observation = "unavailable";
    expect(await observe(owned.data, [owned.data.port], "one")).toEqual({ first: undefined });
  });

  it("settles queued expired requests before native dispatch", async () => {
    const owned = bridge(),
      reply = send(owned, { deadline: process.hrtime.bigint() - 1n });
    await barrier(owned);
    expect(Atomics.load(reply, 0)).toBe(3);
    expect(state.owner).not.toHaveBeenCalled();
  });

  it("refuses an expanded caller deadline before native dispatch", async () => {
    const owned = bridge(),
      reply = send(owned, { deadline: process.hrtime.bigint() + 10_000_000_000n });
    await barrier(owned);
    expect(Atomics.load(reply, 0)).toBe(3);
    expect(state.owner).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 0x80000000])(
    "refuses an otherwise exact probe with invalid PID %s",
    async (pid) => {
      const owned = bridge(),
        reply = new Int32Array(new SharedArrayBuffer(16));
      owned.data.port.postMessage({
        kind: "probe",
        pid,
        reply: reply.buffer,
        deadline: process.hrtime.bigint() + 5_000_000_000n,
      });
      await barrier(owned);
      expect(Atomics.load(reply, 0)).toBe(0);
      expect(state.probe).not.toHaveBeenCalled();
    },
  );

  it("refuses an invalid local descriptor without posting a native query", async () => {
    const owned = bridge();
    expect(await observe(owned.data, [owned.data.port], "one", -1)).toEqual({ first: undefined });
    expect(state.owner).not.toHaveBeenCalled();
  });

  it.each([
    { descriptor: -1 },
    { descriptor: 1.5 },
    { descriptor: 0x80000000 },
    { dev: -1n },
    { dev: 0x10000000000000000n },
    { dev: 123 },
    { ino: -1n },
    { ino: 0x10000000000000000n },
    { mode: 0x100000000n },
    { kind: "probe", pid: 0 },
    { kind: "unknown" },
    { extra: true },
    { reply: new ArrayBuffer(16) },
    { reply: new SharedArrayBuffer(20) },
    { deadline: 123 },
  ])("refuses a malformed request before native dispatch: %o", async (fault) => {
    const owned = bridge(),
      reply = send(owned, fault);
    await barrier(owned);
    expect(Atomics.load(reply, 0)).toBe(0);
    expect(state.owner).not.toHaveBeenCalled();
    expect(state.probe).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])("refuses a nonempty initial reply field %s", async (index) => {
    const owned = bridge(),
      reply = new Int32Array(new SharedArrayBuffer(16));
    reply[index] = 42;
    send(owned, { reply: reply.buffer });
    await barrier(owned);
    expect(Atomics.load(reply, 0)).toBe(0);
    expect(state.owner).not.toHaveBeenCalled();
  });

  it("never reuses a terminal reply even through another cloned SAB wrapper", async () => {
    const owned = bridge(),
      reply = send(owned);
    await barrier(owned);
    expect(Atomics.load(reply, 0)).toBe(2);
    state.owner.mockReturnValue(2000n);
    send(owned, { reply: reply.buffer });
    await barrier(owned);
    expect(new DataView(reply.buffer).getUint32(8, true)).toBe(1000);
    expect(state.owner).toHaveBeenCalledOnce();
  });

  it("disposal settles an executing request without publishing a later UID", async () => {
    const owned = bridge();
    state.owner.mockImplementation(() => {
      owned.dispose();
      return 1000n;
    });
    expect(await observe(owned.data, [owned.data.port], "one")).toEqual({ first: undefined });
    expect(state.observation).toBe("ready");
  });

  it("a late old result cannot complete a fresh request or retire the root", async () => {
    const owned = bridge();
    state.owner
      .mockImplementationOnce(() => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5100);
        return 1000n;
      })
      .mockReturnValue(2000n);
    expect(await observe(owned.data, [owned.data.port], "timeout")).toEqual({
      first: undefined,
      second: 2000n,
      observation: "ready",
    });
    expect(state.owner).toHaveBeenCalledTimes(2);
    expect(state.observation).toBe("ready");
  }, 15000);

  it.each([{ version: 2 }, { pid: 0 }, { pid: "4321" }, { extra: true }])(
    "refuses mismatched Worker data before reader initialization: %o",
    async (fault) => {
      const owned = bridge();
      expect(await observe({ ...owned.data, ...fault }, [owned.data.port], "bind-refuse")).toBe(
        "refused",
      );
      expect(state.owner).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 3, outcome: 1, uid: 1000, observation: 1 },
    { status: 4, outcome: 1, uid: 1000, observation: 1 },
    { status: 99, outcome: 1, uid: 1000, observation: 1 },
    { status: 2, outcome: 1, uid: 1000, observation: 0 },
    { status: 2, outcome: 1, uid: 1000, observation: 2 },
    { status: 2, outcome: 1, uid: 1000, observation: 3 },
    { status: 2, outcome: 0, uid: 1000, observation: 1 },
    { status: 2, outcome: 99, uid: 1000, observation: 1 },
  ])("a terminal wake alone cannot authorize ownership: %o", async (fault) => {
    const channel = new MessageChannel();
    const owned: ProcessScopeWorkerBridge = {
      data: { version: 1, pid: 4321, port: channel.port2 },
      dispose: (): void => {
        channel.port1.close();
        channel.port2.close();
      },
    };
    bridges.push(owned);
    channel.port1.on("message", (request: { readonly reply: SharedArrayBuffer }): void => {
      const reply = new Int32Array(request.reply);
      reply[1] = fault.outcome;
      reply[2] = fault.uid;
      reply[3] = fault.observation;
      Atomics.store(reply, 0, fault.status);
      Atomics.notify(reply, 0);
    });
    expect(await observe(owned.data, [owned.data.port], "one")).toEqual({ first: undefined });
  });
});
