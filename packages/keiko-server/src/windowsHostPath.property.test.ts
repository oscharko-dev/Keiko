import { describe, expect, it } from "vitest";

import {
  checkProperty,
  shrinkString,
  type Generator,
} from "../../../tests/support/property-testing.js";
import { isWindowsLocalDriveFilePath, isWindowsOrdinaryPathComponent } from "./windowsHostPath.js";

const DEVICES = ["CON", "prn", "Aux", "nul", "COM1", "com9", "LPT3", "COM¹", "CONIN$", "conout$"];
const SAFE = Array.from("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.äöü");

const safeName: Generator<string> = (random) => {
  const length = random.integer(1, 24);
  let name = "";
  for (let index = 0; index < length; index += 1) name += random.pick(SAFE);
  return name;
};

const deviceSpelling: Generator<string> = (random) => {
  const extension = random.chance(0.5) ? `.${safeName(random).replaceAll(".", "")}` : "";
  const trailing = random.pick(["", ".", " ", ". ", "..", "  "]);
  // Win32 also ignores spaces between the device name and the extension dot (`CON .txt`).
  const gap = extension === "" ? "" : random.pick(["", "", " ", "  "]);
  return `${random.pick(DEVICES)}${gap}${extension}${trailing}`;
};

describe("Windows host path forms (#4068 W7)", () => {
  it("admits local drive paths and refuses device, UNC, stream and device-name forms", () => {
    for (const path of [
      String.raw`C:\Users\someone\AGENTS.md`,
      "D:/work/repo/notes.md",
      String.raw`C:\Users\someone\console.md`,
      String.raw`C:\Users\someone\Ünïcödé notes.md`,
    ]) {
      expect(isWindowsLocalDriveFilePath(path), path).toBe(true);
    }
    for (const path of [
      String.raw`\\.\pipe\keiko`,
      String.raw`\\?\C:\Users\someone\AGENTS.md`,
      String.raw`\\server\share\AGENTS.md`,
      "//server/share/AGENTS.md",
      String.raw`C:relative\AGENTS.md`,
      String.raw`C:\Users\someone\AGENTS.md:hidden`,
      String.raw`C:\Users\someone\AGENTS.md::$DATA`,
      String.raw`C:\Users\CON\AGENTS.md`,
      String.raw`C:\Users\someone\nul.md`,
      String.raw`C:\Users\someone\NUL  .md`,
      "C:\\Users\\someone\\a\u0000b",
      "/home/someone/AGENTS.md",
    ]) {
      expect(isWindowsLocalDriveFilePath(path), path).toBe(false);
    }
  });

  it("refuses every device spelling, with any extension and trailing dots or spaces", async () => {
    let checked = 0;
    await checkProperty({
      name: "device names are never ordinary components",
      generate: deviceSpelling,
      shrink: shrinkString,
      property: (component) => {
        checked += 1;
        expect(isWindowsOrdinaryPathComponent(component)).toBe(false);
      },
    });
    expect(checked).toBeGreaterThan(0);
  });

  it("refuses any component holding a stream separator, and nothing else changes", async () => {
    let ordinary = 0;
    await checkProperty({
      name: "a colon anywhere makes a component a stream",
      generate: (random) => {
        const name = safeName(random);
        const at = random.integer(0, name.length);
        return { name, streamed: `${name.slice(0, at)}:${name.slice(at)}` };
      },
      property: ({ name, streamed }) => {
        expect(isWindowsOrdinaryPathComponent(streamed)).toBe(false);
        // Over-inclusive on purpose: a name this treats as a device is only left unasserted.
        const base = name.split(".")[0]?.trimEnd().toUpperCase() ?? "";
        const device = /^(?:CON|PRN|AUX|NUL|COM\d|LPT\d)$/u.test(base);
        if (!device) {
          ordinary += 1;
          expect(isWindowsOrdinaryPathComponent(name)).toBe(true);
        }
      },
    });
    expect(ordinary).toBeGreaterThan(0);
  });
});
