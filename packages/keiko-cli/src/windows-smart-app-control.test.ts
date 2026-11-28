import { describe, expect, it } from "vitest";
import {
  WindowsSystemBinaryMissingError,
  WindowsSystemDirectoryError,
} from "@oscharko-dev/keiko-security";
import {
  probeSmartAppControlState,
  readSmartAppControlState,
  smartAppControlStateFromRegQuery,
} from "./windows-smart-app-control.js";

function regOutput(value: string): string {
  return [
    "",
    "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy",
    `    VerifiedAndReputablePolicyState    REG_DWORD    ${value}`,
    "",
  ].join("\r\n");
}

describe("smartAppControlStateFromRegQuery", () => {
  it("maps the three documented policy values", () => {
    expect(smartAppControlStateFromRegQuery(regOutput("0x0"))).toBe("off");
    expect(smartAppControlStateFromRegQuery(regOutput("0x1"))).toBe("on");
    expect(smartAppControlStateFromRegQuery(regOutput("0x2"))).toBe("evaluation");
  });

  it("reads an undocumented value, empty output and a foreign line as unknown", () => {
    expect(smartAppControlStateFromRegQuery(regOutput("0x3"))).toBe("unknown");
    expect(smartAppControlStateFromRegQuery("")).toBe("unknown");
    expect(smartAppControlStateFromRegQuery("    OtherValue    REG_DWORD    0x1\r\n")).toBe(
      "unknown",
    );
    expect(
      smartAppControlStateFromRegQuery("    VerifiedAndReputablePolicyState    REG_SZ    0x1\r\n"),
    ).toBe("unknown");
  });

  it("does not accept the value name inside a longer name", () => {
    expect(
      smartAppControlStateFromRegQuery(
        "    XVerifiedAndReputablePolicyState    REG_DWORD    0x1\r\n",
      ),
    ).toBe("unknown");
  });
});

describe("readSmartAppControlState", () => {
  const env = { SystemRoot: String.raw`C:\Windows` };
  const trustedReg = (): string => String.raw`C:\Windows\System32\reg.exe`;
  const hostileRoot = String.raw`\\attacker\share`;

  it("never resolves or queries outside Windows", () => {
    let calls = 0;
    const state = readSmartAppControlState(
      "linux",
      env,
      () => {
        calls += 1;
        return regOutput("0x1");
      },
      () => {
        calls += 1;
        return "reg.exe";
      },
    );
    expect(state).toBe("not-windows");
    expect(calls).toBe(0);
  });

  it("queries the trusted reg.exe for the policy value", () => {
    const seen: { executable: string; args: readonly string[] }[] = [];
    const resolvedFor: unknown[] = [];
    const state = readSmartAppControlState(
      "win32",
      env,
      (executable, args) => {
        seen.push({ executable, args });
        return regOutput("0x1");
      },
      (readEnv) => {
        resolvedFor.push(readEnv);
        return trustedReg();
      },
    );
    expect(state).toBe("on");
    expect(resolvedFor).toEqual([env]);
    expect(seen).toEqual([
      {
        executable: String.raw`C:\Windows\System32\reg.exe`,
        args: [
          "query",
          String.raw`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy`,
          "/v",
          "VerifiedAndReputablePolicyState",
        ],
      },
    ]);
  });

  it("runs no query when the trusted resolver refuses the system root", () => {
    let calls = 0;
    const refused = new WindowsSystemDirectoryError("refused");
    expect(() =>
      readSmartAppControlState(
        "win32",
        { SystemRoot: hostileRoot },
        () => {
          calls += 1;
          return regOutput("0x1");
        },
        () => {
          throw refused;
        },
      ),
    ).toThrow(refused);
    expect(calls).toBe(0);
  });

  it("refuses a hostile system root through the default trusted resolver", () => {
    expect(() =>
      readSmartAppControlState("win32", { SystemRoot: hostileRoot }, () => regOutput("0x1")),
    ).toThrow(WindowsSystemDirectoryError);
  });

  it("is unknown when the query fails", () => {
    expect(readSmartAppControlState("win32", env, () => undefined, trustedReg)).toBe("unknown");
  });
});

describe("probeSmartAppControlState", () => {
  const env = { SystemRoot: String.raw`C:\Windows` };

  function probeWith(error: Error): string {
    return probeSmartAppControlState(
      "win32",
      env,
      () => regOutput("0x1"),
      () => {
        throw error;
      },
    );
  }

  // The refusal keeps its single line on the surface that uses the system root (#4569 next to the
  // hostile shortcut host root pin in portable.test.ts); the probe only reads as unknown.
  it("reads a refused system root and a missing reg.exe as unknown", () => {
    expect(probeWith(new WindowsSystemDirectoryError("refused"))).toBe("unknown");
    expect(probeWith(new WindowsSystemBinaryMissingError())).toBe("unknown");
  });

  it("reads a hostile system root as unknown through the default trusted resolver", () => {
    let calls = 0;
    const state = probeSmartAppControlState(
      "win32",
      { SystemRoot: String.raw`\\attacker\share` },
      () => {
        calls += 1;
        return regOutput("0x1");
      },
    );
    expect(state).toBe("unknown");
    expect(calls).toBe(0);
  });

  it("propagates an error that is not the resolver's own", () => {
    const foreign = new Error("foreign");
    expect(() => probeWith(foreign)).toThrow(foreign);
  });

  it("returns the read state when the read succeeds", () => {
    const state = probeSmartAppControlState(
      "win32",
      env,
      () => regOutput("0x2"),
      () => String.raw`C:\Windows\System32\reg.exe`,
    );
    expect(state).toBe("evaluation");
  });
});
