import { describe, expect, it } from "vitest";

import {
  isMacosTeamIdentifier,
  macosDeveloperIdRequirement,
  macosReleaseTeamIdentifier,
  macosTeamIdentifierFromOutput,
} from "./macosPortableCodeIdentity.js";

describe("macOS portable code identity", (): void => {
  it("accepts only closed ten-character Apple team identifiers", (): void => {
    expect(isMacosTeamIdentifier("AB12CD34EF")).toBe(true);
    expect(isMacosTeamIdentifier("")).toBe(false);
    expect(isMacosTeamIdentifier("ab12cd34ef")).toBe(false);
    expect(isMacosTeamIdentifier('AB12CD34E"')).toBe(false);
  });

  it("extracts exactly one closed Apple team identifier", (): void => {
    expect(
      macosTeamIdentifierFromOutput("Authority=Developer ID\nTeamIdentifier=AB12CD34EF\n"),
    ).toBe("AB12CD34EF");
    expect(
      macosTeamIdentifierFromOutput("TeamIdentifier=AB12CD34EF\nTeamIdentifier=ZZ98YX76WV\n"),
    ).toBeUndefined();
    expect(macosTeamIdentifierFromOutput("")).toBeUndefined();
    expect(macosTeamIdentifierFromOutput("TeamIdentifier=not set\n")).toBeUndefined();
  });

  it("builds a Developer ID requirement bound to team and bundle identity", (): void => {
    expect(macosDeveloperIdRequirement("AB12CD34EF", "dev.oscharko.keiko.macos-arm64")).toBe(
      'anchor apple generic and identifier "dev.oscharko.keiko.macos-arm64"' +
        ' and certificate leaf[subject.OU] = "AB12CD34EF"',
    );
    expect(macosDeveloperIdRequirement("AB12CD34EF")).toBe(
      'anchor apple generic and certificate leaf[subject.OU] = "AB12CD34EF"',
    );
    expect((): string => macosDeveloperIdRequirement("invalid")).toThrow(TypeError);
  });

  it("KEIKO-0788: rejects a bundleIdentifier containing characters outside the safe reverse-DNS charset", (): void => {
    // A quote or backslash would close the surrounding identifier and inject arbitrary
    // requirement text before this fix; the guard must throw TypeError to match the
    // team-identifier check's convention.
    expect((): string =>
      macosDeveloperIdRequirement("AB12CD34EF", 'dev.oscharko.keiko." and delete "'),
    ).toThrow(TypeError);
    // Backslash-escaped quote is not a valid bundle-id character either.
    expect((): string => macosDeveloperIdRequirement("AB12CD34EF", "keiko\\quote")).toThrow(
      TypeError,
    );
    // Empty bundleIdentifier is not "undefined" -- an empty string collapses the anchor clause
    // to a syntactically valid but semantically empty identifier requirement; fail closed too.
    expect((): string => macosDeveloperIdRequirement("AB12CD34EF", "")).toThrow(TypeError);
  });

  it("keeps an unbound development build unqualified", (): void => {
    expect(macosReleaseTeamIdentifier()).toBeUndefined();
  });
});
