import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const properties = readFileSync(resolve(root, "sonar-project.properties"), "utf8");

function property(name) {
  return properties
    .split("\n")
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

describe("SonarCloud analysis scope", () => {
  it("classifies repository tests separately from production source", () => {
    expect(property("sonar.tests")).toBe(".");
    expect(property("sonar.test.inclusions")?.split(",")).toEqual([
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.test.mjs",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/__tests__/**",
      "tests/**",
    ]);
  });

  it("does not broaden the existing dedicated-realm coverage exclusion", () => {
    expect(property("sonar.exclusions")?.split(",")).not.toContain(
      "packages/keiko-feedback-intake/assets/**",
    );
    expect(property("sonar.coverage.exclusions")?.split(",")).toEqual([
      "packages/keiko-ui/public/**",
    ]);
  });
});
