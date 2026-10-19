import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProcessScope, readProcessNamespaceIds } from "./process-scope.js";

const input = vi.hoisted(() => ({ content: "", filesystem: 0x9fa0, closes: 0 }));
const platform = process.platform;
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  openSync: (): number => 123,
  statfsSync: (): { type: number } => ({ type: input.filesystem }),
  readSync: (_fd: number, bytes: Buffer): number => {
    const content = Buffer.from(input.content);
    content.copy(bytes);
    return Math.min(bytes.length, content.length);
  },
  closeSync: (): void => {
    input.closes += 1;
  },
}));

function status(first: number, last = process.pid): string {
  return `Name:\tfixture\nNSpid:\t${String(first)} ${String(last)}\nNStgid:\t${String(first)} ${String(last)}\n`;
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  input.content = status(process.pid + 1000);
  input.filesystem = 0x9fa0;
  input.closes = 0;
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  vi.restoreAllMocks();
});

describe("positive Linux process coordinate metadata", () => {
  it("joins both kernel identity chains before choosing the outer coordinate", () => {
    expect(readProcessNamespaceIds()).toEqual([process.pid + 1000, process.pid]);
    expect(input.closes).toBe(1);
  });

  it.each([
    "missing",
    "duplicate",
    "thread",
    "local",
    "zero",
    "negative",
    "range",
    "leading-zero",
    "full",
    "filesystem",
  ])("refuses %s metadata and releases the held descriptor", (fault) => {
    corruptStatus(fault);
    expect(() => readProcessNamespaceIds()).toThrow();
    expect(input.closes).toBe(1);
  });

  it.each([false, true])(
    "never probes an outer coordinate with local kill even at numeric equality=%s",
    (equal) => {
      input.content = status(equal ? process.pid : process.pid + 1000);
      const kill = vi.spyOn(process, "kill"),
        scope = createProcessScope();
      expect(scope.kind()).toBe("outer-unprobed");
      expect(scope.pid()).toBe(equal ? process.pid : process.pid + 1000);
      expect(scope.liveness(process.pid + 2000)).toBe("unknown");
      expect(scope.liveness(scope.pid())).toBe("alive");
      expect(kill).not.toHaveBeenCalled();
    },
  );
});

function corruptStatus(fault: string): void {
  const content = new Map<string, string>([
    ["missing", "Name:\tfixture\n"],
    ["duplicate", input.content + `NSpid:\t${String(process.pid)}\n`],
    ["thread", input.content.replace("NStgid:", "Other:")],
    ["local", status(process.pid + 1000, process.pid + 1)],
    ["zero", status(0)],
    ["negative", status(-1)],
    ["range", status(0x80000000)],
    ["leading-zero", input.content.replaceAll(String(process.pid + 1000), "01")],
    ["full", "x".repeat(16 * 1024)],
  ]);
  input.content = content.get(fault) ?? input.content;
  if (fault === "filesystem") input.filesystem = 0x1234;
}
