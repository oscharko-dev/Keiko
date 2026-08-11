// Hermetic coverage for the script-owned MSVC toolchain resolution (#3072/#3075): the real
// chain only ever executes on a Windows host with Visual Studio, so vswhere and the vcvars
// import are exercised here through module-level mocks of spawnSync/existsSync — no process
// is spawned and no Windows host is required.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: (...args) => spawnSyncMock(...args) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: (...args) => existsSyncMock(...args) };
});

const realFs = await vi.importActual("node:fs");
existsSyncMock.mockImplementation((path) => realFs.existsSync(path));

const { resolveWindowsMsvcEnv } = await import("../stage-portable-runtime.mjs");

const VSWHERE_SUFFIX = ["Microsoft Visual Studio", "Installer", "vswhere.exe"].join(
  process.platform === "win32" ? "\\" : "/",
);

function vcvarsDump(lines) {
  return { status: 0, stdout: `${lines.join("\r\n")}\r\n` };
}

describe("resolveWindowsMsvcEnv", () => {
  let exitSpy;
  let errorSpy;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    spawnSyncMock.mockReset();
    existsSyncMock.mockImplementation((path) => realFs.existsSync(path));
  });

  it("uses a Developer Command Prompt environment as-is without spawning anything", () => {
    const baseEnv = { INCLUDE: String.raw`C:\inc`, LIB: String.raw`C:\lib` };
    expect(resolveWindowsMsvcEnv(baseEnv)).toBe(baseEnv);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("imports the vcvars64 environment and merges every PATH case variant onto one key", () => {
    existsSyncMock.mockImplementation((path) => String(path).endsWith("vswhere.exe"));
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "C:\\VS\\2022\n" })
      .mockReturnValueOnce(
        vcvarsDump([
          "Path=C:\\VS\\bin;C:\\Windows\\system32",
          "INCLUDE=C:\\VS\\include",
          "LIB=C:\\VS\\lib",
        ]),
      );

    const resolved = resolveWindowsMsvcEnv({
      SystemRoot: String.raw`C:\Windows`,
      PATH: String.raw`C:\old`,
      "ProgramFiles(x86)": String.raw`C:\Program Files (x86)`,
    });

    expect(resolved.INCLUDE).toBe("C:\\VS\\include");
    expect(resolved.LIB).toBe("C:\\VS\\lib");
    // cmd emits `Path=`, the parent carried `PATH=`: exactly one canonical key must survive.
    const pathKeys = Object.keys(resolved).filter((key) => key.toUpperCase() === "PATH");
    expect(pathKeys).toEqual(["PATH"]);
    expect(resolved.PATH).toBe("C:\\VS\\bin;C:\\Windows\\system32");

    expect(String(spawnSyncMock.mock.calls[0]?.[0])).toContain(VSWHERE_SUFFIX);
    expect(String(spawnSyncMock.mock.calls[1]?.[0])).toContain("cmd.exe");
    expect(String(spawnSyncMock.mock.calls[1]?.[1]?.[3])).toContain("vcvars64.bat");
  });

  it("resolves vswhere under the canonical Program Files (x86) when the variable is relative", () => {
    const probed = [];
    existsSyncMock.mockImplementation((path) => {
      probed.push(String(path));
      return false;
    });
    expect(() => resolveWindowsMsvcEnv({ "ProgramFiles(x86)": "relative\\pf" })).toThrow(
      "process.exit(1)",
    );
    expect(probed.at(-1)?.startsWith("C:\\Program Files (x86)")).toBe(true);
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain("vswhere missing");
  });

  it("fails closed when vswhere finds no C++ build tools installation", () => {
    existsSyncMock.mockImplementation((path) => String(path).endsWith("vswhere.exe"));
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "\n" });
    expect(() => resolveWindowsMsvcEnv({})).toThrow("process.exit(1)");
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain("not installed");
  });

  it("fails closed when the vcvars64 import itself fails", () => {
    existsSyncMock.mockImplementation((path) => String(path).endsWith("vswhere.exe"));
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "C:\\VS\\2022\n" })
      .mockReturnValueOnce({ status: 1, stdout: "" });
    expect(() => resolveWindowsMsvcEnv({})).toThrow("process.exit(1)");
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain("vcvars64");
  });

  it("fails closed when the imported environment still lacks INCLUDE and LIB", () => {
    existsSyncMock.mockImplementation((path) => String(path).endsWith("vswhere.exe"));
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "C:\\VS\\2022\n" })
      .mockReturnValueOnce(vcvarsDump(["Path=C:\\VS\\bin"]));
    expect(() => resolveWindowsMsvcEnv({})).toThrow("process.exit(1)");
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain("did not define INCLUDE and LIB");
  });
});
