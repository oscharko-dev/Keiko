import { spawnSync } from "node:child_process";
import { expect } from "vitest";

/** Runs `control` with `operation` in a fresh Node process and returns stdout after a clean exit. */
export function runIsolatedControl(control: string, operation: string): string {
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", control, operation], {
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  return child.stdout;
}
