import { describe, expect, it, vi } from "vitest";
import {
  resolveWindowsSystemDirectory,
  WindowsSystemDirectoryError,
} from "./windows-system-directory.js";

describe("Windows system root environment aliases (#4408)", () => {
  it.each(["SYSTEMROOT", "systemroot", "SystemRoot"])("validates the selected %s value", (name) => {
    const identity = vi.fn(() => true);
    expect(resolveWindowsSystemDirectory({ [name]: String.raw`D:\Windows` }, identity)).toBe(
      String.raw`D:\Windows`,
    );
    expect(identity).toHaveBeenCalledWith(
      String.raw`D:\Windows`,
      String.raw`\\?\GLOBALROOT\SystemRoot`,
    );
  });

  it("uses a mixed-case WINDIR only when the first SystemRoot alias is absent", () => {
    expect(
      resolveWindowsSystemDirectory(
        {
          SYSTEMROOT: undefined,
          SystemRoot: String.raw`D:\Windows`,
          Windir: String.raw`E:\Windows`,
        },
        () => true,
      ),
    ).toBe(String.raw`E:\Windows`);
  });

  it.each([
    { SYSTEMROOT: String.raw`\\untrusted\share`, SystemRoot: String.raw`C:\Windows` },
    { systemroot: "relative", WINDIR: String.raw`C:\Windows` },
    { Windir: String.raw`C:\Windows:stream` },
  ])("refuses malformed selected aliases instead of falling back: %j", (env) => {
    const identity = vi.fn(() => true);
    expect(() => resolveWindowsSystemDirectory(env, identity)).toThrow(WindowsSystemDirectoryError);
    expect(identity).not.toHaveBeenCalled();
  });

  it("still rejects a shaped alias that fails the OS-owned directory identity proof", () => {
    const identity = vi.fn(() => false);
    expect(() =>
      resolveWindowsSystemDirectory({ SYSTEMROOT: String.raw`D:\Windows` }, identity),
    ).toThrow(WindowsSystemDirectoryError);
    expect(identity).toHaveBeenCalledWith(
      String.raw`D:\Windows`,
      String.raw`\\?\GLOBALROOT\SystemRoot`,
    );
  });
});
