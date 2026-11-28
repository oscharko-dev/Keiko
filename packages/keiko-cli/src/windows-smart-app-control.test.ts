import { describe, expect, it } from "vitest";
import {
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
  const env = { SystemRoot: "C:\\Windows" };

  it("never queries outside Windows", () => {
    let calls = 0;
    const state = readSmartAppControlState("linux", env, () => {
      calls += 1;
      return regOutput("0x1");
    });
    expect(state).toBe("not-windows");
    expect(calls).toBe(0);
  });

  it("queries the system reg.exe by absolute path for the policy value", () => {
    const seen: { executable: string; args: readonly string[] }[] = [];
    const state = readSmartAppControlState("win32", env, (executable, args) => {
      seen.push({ executable, args });
      return regOutput("0x1");
    });
    expect(state).toBe("on");
    expect(seen).toEqual([
      {
        executable: "C:\\Windows\\System32\\reg.exe",
        args: [
          "query",
          "HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy",
          "/v",
          "VerifiedAndReputablePolicyState",
        ],
      },
    ]);
  });

  it("is unknown without an absolute system root, so no reg.exe from PATH is run", () => {
    let calls = 0;
    const query = (): string => {
      calls += 1;
      return regOutput("0x1");
    };
    expect(readSmartAppControlState("win32", {}, query)).toBe("unknown");
    expect(readSmartAppControlState("win32", { SystemRoot: "Windows" }, query)).toBe("unknown");
    expect(calls).toBe(0);
  });

  it("is unknown when the query fails", () => {
    expect(readSmartAppControlState("win32", env, () => undefined)).toBe("unknown");
  });
});
