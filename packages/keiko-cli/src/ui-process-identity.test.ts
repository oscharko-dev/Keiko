import { describe, expect, it } from "vitest";
import {
  defaultReadProcessCommandLine,
  defaultReadProcessEnviron,
  liveIdentityTextHasLaunchId,
  liveProcessHasLaunchId,
} from "./ui-process-identity.js";
import { KEIKO_UI_LAUNCH_ID_ENV, UI_LAUNCH_ID_FLAG } from "./state-paths.js";

const LAUNCH_ID = "a".repeat(32);

describe("liveIdentityTextHasLaunchId", () => {
  it("matches the env assignment, Linux cmdline NUL form, and ps argv form", () => {
    expect(liveIdentityTextHasLaunchId(`${KEIKO_UI_LAUNCH_ID_ENV}=${LAUNCH_ID}`, LAUNCH_ID)).toBe(
      true,
    );
    expect(liveIdentityTextHasLaunchId(`${UI_LAUNCH_ID_FLAG}\0${LAUNCH_ID}`, LAUNCH_ID)).toBe(true);
    expect(liveIdentityTextHasLaunchId(`${UI_LAUNCH_ID_FLAG} ${LAUNCH_ID}`, LAUNCH_ID)).toBe(true);
    expect(liveIdentityTextHasLaunchId(`node ui --port 1983`, LAUNCH_ID)).toBe(false);
  });
});

describe("liveProcessHasLaunchId", () => {
  it("accepts a Linux environ blob without consulting cmdline", () => {
    expect(
      liveProcessHasLaunchId(12, LAUNCH_ID, {
        platform: "linux",
        readEnviron: () => `${KEIKO_UI_LAUNCH_ID_ENV}=${LAUNCH_ID}\0PATH=/usr/bin`,
        readCommandLine: () => {
          throw new Error("cmdline must not run after environ matches");
        },
      }),
    ).toBe(true);
  });

  it("accepts a Linux cmdline NUL-separated --launch-id when environ is empty", () => {
    expect(
      liveProcessHasLaunchId(12, LAUNCH_ID, {
        platform: "linux",
        readEnviron: () => undefined,
        readCommandLine: () => `node\0ui\0${UI_LAUNCH_ID_FLAG}\0${LAUNCH_ID}`,
      }),
    ).toBe(true);
  });

  it("rejects a recycled pid whose environ and cmdline lack the launch id", () => {
    expect(
      liveProcessHasLaunchId(12, LAUNCH_ID, {
        platform: "darwin",
        readEnviron: () => "PATH=/usr/bin",
        readCommandLine: () => "node ui --port 1983",
      }),
    ).toBe(false);
  });
});

describe("default live identity readers", () => {
  it("return undefined for a pid that has no /proc identity files", () => {
    const missing = 2_147_483_647;
    expect(defaultReadProcessEnviron(missing, "linux")).toBeUndefined();
    expect(defaultReadProcessCommandLine(missing, "linux")).toBeUndefined();
  });
});
