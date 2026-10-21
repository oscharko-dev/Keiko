import { fstatSync } from "node:fs";
import { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
import {
  encodeNativeAppControlFrame,
  encodeNativeAppHandoffStart,
  type NativeAppControlFrame,
  type NativeAppControlKind,
  type NativeAppHandoffBinding,
} from "@oscharko-dev/keiko-contracts/runtime/native-runtime-wire";
import { isKeikoUiLaunchId } from "@oscharko-dev/keiko-contracts/runtime/ui-launch";
import {
  currentProcessId,
  currentProcessScopeKind,
  isProcessId,
} from "@oscharko-dev/keiko-security/process-scope";
import { NativeAppControlStream } from "./update-native-app-control-stream.js";

const APP_CONTROL_BOUND_MS = 5000;
const PENDING_HANDOFF_RESPONSES: ReadonlySet<NativeAppControlKind> = new Set([3, 5, 7, 10]);

export interface NativeAppHandoffControl {
  readonly start: (
    binding: NativeAppHandoffBinding,
    deadline: number,
    signal?: AbortSignal,
  ) => Promise<number>;
  readonly accept: (deadline: number, signal?: AbortSignal) => Promise<void>;
  readonly commit: (deadline: number, signal?: AbortSignal) => Promise<void>;
  readonly cancel: (activationId: string, deadline?: number) => Promise<void>;
}

export class NativeAppControlError extends Error {
  public constructor(
    public readonly nativeAuthorityMayBeLive: boolean,
    cause?: unknown,
  ) {
    super("native app handoff control refused", { cause });
    this.name = "NativeAppControlError";
  }
}

/** A private lifecycle transport; it cannot select paths, commands or another app generation. */
export class NativeAppControl {
  private active: NativeAppHandoffBinding | undefined;
  private authorityMayBeLive = false;
  private ownerPid: number | undefined;

  public constructor(
    private readonly stream: NativeAppControlStream,
    private readonly rootPid: number,
    private readonly launchId: string,
  ) {}

  public async ready(deadline: number): Promise<void> {
    const frame = await this.stream.read(deadline);
    const owner = frame.payload.readUInt32LE(4);
    if (
      frame.kind !== 1 ||
      frame.payload.readUInt32LE(0) !== this.rootPid ||
      !isProcessId(owner) ||
      owner === this.rootPid ||
      !isKeikoUiLaunchId(this.launchId) ||
      frame.payload.subarray(8).toString("ascii") !== this.launchId
    )
      throw new NativeAppControlError(false);
    this.ownerPid = owner;
  }

  public async start(
    binding: NativeAppHandoffBinding,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<number> {
    if (
      this.active !== undefined ||
      this.ownerPid === undefined ||
      binding.launchId !== this.launchId
    )
      throw new NativeAppControlError(this.authorityMayBeLive);
    let bytes: Buffer;
    try {
      bytes = encodeNativeAppHandoffStart(binding, nativeControlDeadline(deadline));
    } catch (error) {
      throw new NativeAppControlError(false, error);
    }
    this.active = binding;
    this.authorityMayBeLive = true;
    const frame = await this.exchange(bytes, 3, deadline, signal);
    const pid = frame.payload.readUInt32LE(32);
    if (!isProcessId(pid) || pid === this.rootPid || pid === this.ownerPid)
      throw new NativeAppControlError(true);
    return pid;
  }

  public async accept(deadline: number, signal?: AbortSignal): Promise<void> {
    const frame = await this.request(4, 5, deadline, signal);
    if (frame.payload.subarray(32).toString("ascii") !== this.active?.planSha256)
      throw new NativeAppControlError(true);
  }

  public async commit(deadline: number, signal?: AbortSignal): Promise<void> {
    await this.request(6, 7, deadline, signal);
  }

  public async cancel(
    activationId: string,
    grantedDeadline = performance.now() + APP_CONTROL_BOUND_MS,
  ): Promise<void> {
    if (this.active?.activationId !== activationId) throw new NativeAppControlError(true);
    const deadline = Math.min(grantedDeadline, performance.now() + APP_CONTROL_BOUND_MS);
    const bytes = encodeNativeAppControlFrame(8, Buffer.from(activationId, "ascii"));
    for (let count = 0; count < 3; ++count) {
      const frame = await this.stream.read(
        deadline,
        count === 0
          ? (): void => {
              this.stream.write(bytes, deadline);
            }
          : undefined,
      );
      this.assertActivation(frame);
      if (frame.kind === 9) {
        this.authorityMayBeLive = false;
        this.active = undefined;
        return;
      }
      if (!PENDING_HANDOFF_RESPONSES.has(frame.kind)) throw new NativeAppControlError(true);
    }
    throw new NativeAppControlError(true);
  }

  private request(
    kind: NativeAppControlKind,
    expected: NativeAppControlKind,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<NativeAppControlFrame> {
    if (this.active === undefined) return Promise.reject(new NativeAppControlError(false));
    return this.exchange(
      encodeNativeAppControlFrame(kind, Buffer.from(this.active.activationId, "ascii")),
      expected,
      deadline,
      signal,
    );
  }

  private async exchange(
    bytes: Buffer,
    expected: NativeAppControlKind,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<NativeAppControlFrame> {
    try {
      const frame = await this.stream.read(
        deadline,
        (): void => {
          this.stream.write(bytes, deadline);
        },
        signal,
      );
      this.assertActivation(frame);
      if (frame.kind !== expected) throw new NativeAppControlError(this.authorityMayBeLive);
      return frame;
    } catch (error) {
      throw new NativeAppControlError(this.authorityMayBeLive, error);
    }
  }

  private assertActivation(frame: NativeAppControlFrame): void {
    if (frame.payload.subarray(0, 32).toString("ascii") !== this.active?.activationId)
      throw new NativeAppControlError(this.authorityMayBeLive);
  }
}

function nativeControlDeadline(deadline: number): bigint {
  const native = process.hrtime.bigint() / 1_000_000n;
  const remaining = Math.floor(deadline - performance.now());
  if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new NativeAppControlError(false);
  return native + BigInt(remaining);
}

function validAppLaunchId(launchId: string): boolean {
  return isKeikoUiLaunchId(launchId) && launchId === process.env.KEIKO_UI_LAUNCH_ID;
}

function isMacosAppRuntime(kind: ReturnType<typeof currentProcessScopeKind>): boolean {
  return (
    kind === "local" && process.platform === "darwin" && process.env.KEIKO_APP_RUNTIME_OWNER === "1"
  );
}

let claimed = false;
let selected: Promise<NativeAppControl> | undefined;

/** Only the explicitly admitted main application consumes FD8. Workers never inspect or close it. */
export function currentNativeAppControl(launchId: string): Promise<NativeAppControl | undefined> {
  if (!isMainThread) return Promise.reject(new NativeAppControlError(false));
  const kind = currentProcessScopeKind();
  const macosApp = isMacosAppRuntime(kind);
  if (kind === "local" && !macosApp) return Promise.resolve(undefined);
  if (!macosApp && (kind !== "outer-native" || process.platform !== "linux"))
    return Promise.reject(new NativeAppControlError(false));
  if (!validAppLaunchId(launchId)) return Promise.reject(new NativeAppControlError(false));
  if (selected !== undefined) return selected;
  if (claimed) return Promise.reject(new NativeAppControlError(false));
  claimed = true;
  selected = openNativeAppControl(launchId);
  return selected;
}

async function openNativeAppControl(launchId: string): Promise<NativeAppControl> {
  if (!fstatSync(8).isSocket()) throw new NativeAppControlError(false);
  const socket = new Socket({ fd: 8, readable: true, writable: true });
  socket.unref();
  const control = new NativeAppControl(
    new NativeAppControlStream(socket),
    currentProcessId(),
    launchId,
  );
  try {
    await control.ready(performance.now() + APP_CONTROL_BOUND_MS);
    return control;
  } catch (error) {
    socket.destroy();
    throw new NativeAppControlError(false, error);
  }
}
