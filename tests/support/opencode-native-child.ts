import assert from "node:assert/strict";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { parseOpenCodeV2ChildEndpoint } from "../../packages/keiko-server/src/coding-runtime/opencodeV2HttpClient.js";

/** Only the pipe and lifecycle contract shared by the immediate-kill native fixtures. */
export type NativeFixtureChild = Pick<
  ChildProcessByStdio<null, Readable, Readable>,
  "stdout" | "stderr" | "exitCode" | "signalCode" | "once" | "off" | "kill"
>;

export async function nativeChildEndpoint(
  child: NativeFixtureChild,
  timeoutMs = 20_000,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (bytes: Buffer): void => {
      for (const line of bytes.toString("utf8").split("\n")) {
        const endpoint = parseOpenCodeV2ChildEndpoint(line + "\n");
        if (endpoint !== undefined) {
          cleanup();
          resolve(endpoint);
          return;
        }
      }
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("fixture-startup-failed"));
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error("fixture-child-exited"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("fixture-startup-timeout"));
    }, timeoutMs);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

/** Immediate SIGKILL followed by reap; this is deliberately not orderly stdin/TERM shutdown. */
export async function stopNativeChild(child: NativeFixtureChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    child.kill("SIGKILL");
  });
}

/** Keep a primary fixture failure observable if resource disposal also fails. */
export async function withNativeChild(
  resource: NativeFixtureChild,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (error) {
    try {
      await stopNativeChild(resource);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "fixture-child-cleanup-failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
  await stopNativeChild(resource);
}

/** The shared fixture resource failure contract, checked against independently supplied sentinels. */
export function assertNativeCleanupFailure(failure: unknown, primary: Error, cleanup: Error): void {
  assert.ok(failure instanceof AggregateError);
  const errors: readonly unknown[] = failure.errors;
  assert.strictEqual(failure.cause, cleanup);
  assert.strictEqual(errors.length, 2);
  assert.strictEqual(errors[0], primary);
  assert.strictEqual(errors[1], cleanup);
}
