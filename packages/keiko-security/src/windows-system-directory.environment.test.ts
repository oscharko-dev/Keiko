import { describe, expect, it, vi } from "vitest";
import { environmentVariableValue } from "@oscharko-dev/keiko-contracts/runtime/process-environment";
import {
  resolveWindowsSystemDirectory,
  WindowsSystemDirectoryError,
} from "./windows-system-directory.js";

describe("Windows system root environment aliases (#4408)", () => {
  it("keeps the dependency-free bootstrap selector in parity with generated contracts aliases", () => {
    function aliases(name: string): readonly string[] {
      let prefixes = [""];
      for (const letter of name) {
        prefixes = prefixes.flatMap((prefix) => [
          prefix + letter.toLowerCase(),
          prefix + letter.toUpperCase(),
        ]);
      }
      return prefixes;
    }
    for (const name of ["SystemRoot", "Windir"]) {
      for (const alias of aliases(name)) {
        const entries: readonly (readonly [string, string | undefined])[] = [
          [alias, String.raw`D:\Windows`],
          [name.toUpperCase(), undefined],
          ["windir", String.raw`E:\Windows`],
        ];
        for (const input of [entries, [...entries].reverse()]) {
          const env = Object.fromEntries(input);
          const expected =
            environmentVariableValue(env, "SystemRoot", "win32") ??
            environmentVariableValue(env, "WINDIR", "win32") ??
            String.raw`C:\Windows`;
          const identity = vi.fn(() => true);
          expect(resolveWindowsSystemDirectory(env, identity)).toBe(expected);
          expect(identity).toHaveBeenCalledWith(expected, String.raw`\\?\GLOBALROOT\SystemRoot`);
        }
      }
    }
  });

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
