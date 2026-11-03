import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi, type Mock } from "vitest";
import { NativeUiAdmissionError, startNativeUiProcess } from "./native-ui-runtime.js";

const launchId = "a".repeat(32),
  rootPid = 424242;
type Mode = "healthy" | "generic" | "wrong-root" | "wrong-launch" | "spawn-error" | "wrong-ack";

function frame(kind: number, tag: string, pid = rootPid): Buffer {
  const header = Buffer.from("4b5253310100040024000000", "hex");
  const identity = Buffer.from(tag);
  header.writeUInt16LE(kind, 6);
  if (kind === 1) {
    header.writeUInt32LE(0, 8);
    return header;
  }
  if (kind === 5) {
    header.writeUInt32LE(identity.length, 8);
    return Buffer.concat([header, identity]);
  }
  const root = Buffer.alloc(4);
  root.writeUInt32LE(pid);
  return Buffer.concat([header, root, identity]);
}

type NativeInput = Parameters<typeof startNativeUiProcess>[0];
type NativeSpawn = NativeInput["spawnFn"];
interface NativeUiFixture {
  readonly input: NativeInput;
  readonly spawned: Mock<NativeSpawn>;
  readonly reserve: Mock<() => void>;
  readonly packets: Buffer[];
}

function fixture(mode: Mode = "healthy"): NativeUiFixture {
  const child = new ChildProcess(),
    control = new PassThrough(),
    response = new PassThrough();
  Object.defineProperty(child, "pid", { value: mode === "spawn-error" ? undefined : 777777 });
  Object.assign(child, { stdio: [null, null, null, control, response], unref: vi.fn() });
  const exited = (): void => {
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
  };
  control.once("finish", exited).once("close", exited);
  const packets: Buffer[] = [];
  control.on("data", (packet: Buffer): void => {
    packets.push(packet);
    if (mode === "spawn-error") return;
    if (packet.subarray(0, 4).toString() === "KRP1")
      response.write(
        frame(
          mode === "generic" ? 1 : 4,
          mode === "wrong-launch" ? "b".repeat(32) : launchId,
          mode === "wrong-root" ? 0 : rootPid,
        ),
      );
    else response.write(frame(5, mode === "wrong-ack" ? "b".repeat(32) : launchId));
  });
  const spawned = vi.fn<NativeSpawn>(() => {
    if (mode === "spawn-error")
      queueMicrotask(() => child.emit("error", new Error("Fixture spawn refusal")));
    return child;
  });
  const reserve = vi.fn<() => void>();
  return { spawned, reserve, packets, input: nativeInput(spawned, reserve) };
}

function nativeInput(spawned: Mock<NativeSpawn>, reserve: Mock<() => void>): NativeInput {
  return {
    runtime: {
      launcherPath: "/fixture/Keiko",
      supervisorPath: "/fixture/supervisor",
      supervisorSha256: "c".repeat(64),
      nodePath: "/fixture/node",
      cliBinPath: "/fixture/cli.js",
      staticRoot: "/fixture/static",
    },
    args: ["/fixture/cli.js", "ui", "--launch-id", launchId],
    cwd: "/fixture",
    launchId,
    startTimeoutMs: 1000,
    deadline: performance.now() + 1000,
    reserve,
    spawnFn: spawned,
    env: {
      KEIKO_STATE_DIR: "/fixture/state",
      KEIKO_UI_LAUNCH_ID: launchId,
      KEIKO_START_TIMEOUT_SECS: "20",
      OPENAI_API_KEY: "fixture-placeholder",
      NODE_EXTRA_CA_CERTS: "fixture-certificate.pem",
      BROWSER: "fixture-browser",
      ...Object.fromEntries(
        Array.from({ length: 140 }, (_, i) => [`FIXTURE_${String(i)}`, "value"]),
      ),
    },
  };
}

describe("native UI client admission", () => {
  it("preserves the app environment, selects the flag grant, and requires the closed app ACK", async () => {
    const { input, spawned, reserve, packets } = fixture();
    const launch = await startNativeUiProcess(input);
    expect(launch.pid).toBe(rootPid);
    expect(reserve).toHaveBeenCalledOnce();
    const options = spawned.mock.calls[0]?.[2];
    expect(options).toMatchObject({
      detached: true,
      env: {
        KEIKO_START_TIMEOUT_SECS: "1",
      },
    });
    expect(Object.keys(options?.env ?? {}).sort()).toEqual(
      [
        "KEIKO_START_TIMEOUT_SECS",
        "KEIKO_STATE_DIR",
        "KEIKO_UI_LAUNCH_ID",
        "KEIKO_UI_START_DEADLINE_MS",
      ].sort(),
    );
    expect(packets[0]?.includes(Buffer.from("FIXTURE_139=value"))).toBe(true);
    expect(packets[0]?.includes(Buffer.from("OPENAI_API_KEY=fixture-placeholder"))).toBe(true);
    expect(packets[0]?.includes(Buffer.from("KEIKO_UI_WORKING_DIRECTORY=/fixture"))).toBe(true);
    expect(packets[0]?.readUInt16LE(14)).toBe(3);
    await launch.commit();
    launch.release();
  });

  it.each(["generic", "wrong-root", "wrong-launch", "spawn-error"] as const)(
    "refuses %s without using W exit as whole-generation evidence",
    async (mode) => {
      const { input } = fixture(mode);
      await expect(startNativeUiProcess(input)).rejects.toMatchObject({
        name: "NativeUiAdmissionError",
        nativeAuthorityMayBeLive: mode !== "spawn-error",
      });
    },
  );

  it("retains uncertainty after a mismatched commit ACK", async () => {
    const { input } = fixture("wrong-ack");
    const launch = await startNativeUiProcess(input);
    await expect(launch.commit()).rejects.toThrow();
    launch.release();
  });

  it("validates the packet before reserving or spawning", async () => {
    const { input, reserve, spawned } = fixture();
    await expect(startNativeUiProcess({ ...input, launchId: "invalid" })).rejects.toMatchObject({
      nativeAuthorityMayBeLive: false,
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(spawned).not.toHaveBeenCalled();
  });

  it("does not spawn when reservation fails", async () => {
    const { input, spawned } = fixture();
    await expect(
      startNativeUiProcess({
        ...input,
        reserve: (): never => {
          throw new Error("Fixture refusal");
        },
      }),
    ).rejects.toBeInstanceOf(NativeUiAdmissionError);
    expect(spawned).not.toHaveBeenCalled();
  });

  it("holds an arbitrary synchronous spawn failure conservatively", async () => {
    const { input } = fixture();
    await expect(
      startNativeUiProcess({
        ...input,
        spawnFn: (): never => {
          throw new Error("Unknown spawn stage");
        },
      }),
    ).rejects.toMatchObject({ nativeAuthorityMayBeLive: true });
  });
});
