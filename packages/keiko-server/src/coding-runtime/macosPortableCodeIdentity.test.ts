import { describe, expect, it } from "vitest";

import {
  macosDeveloperIdRequirement,
  macosTeamIdentifierFromOutput,
} from "./macosPortableCodeIdentity.js";

describe("macOS portable code identity", () => {
  it("extracts exactly one closed Apple team identifier", () => {
    expect(
      macosTeamIdentifierFromOutput("Authority=Developer ID\nTeamIdentifier=AB12CD34EF\n"),
    ).toBe("AB12CD34EF");
    expect(
      macosTeamIdentifierFromOutput("TeamIdentifier=AB12CD34EF\nTeamIdentifier=ZZ98YX76WV\n"),
    ).toBeUndefined();
    expect(macosTeamIdentifierFromOutput("TeamIdentifier=not set\n")).toBeUndefined();
  });

  it("builds a Developer ID requirement bound to team and bundle identity", () => {
    expect(macosDeveloperIdRequirement("AB12CD34EF", "dev.oscharko.keiko.macos-arm64")).toBe(
      'anchor apple generic and identifier "dev.oscharko.keiko.macos-arm64"' +
        ' and certificate leaf[subject.OU] = "AB12CD34EF"',
    );
    expect(macosDeveloperIdRequirement("AB12CD34EF")).toBe(
      'anchor apple generic and certificate leaf[subject.OU] = "AB12CD34EF"',
    );
    expect(() => macosDeveloperIdRequirement("invalid")).toThrow(TypeError);
  });
});
