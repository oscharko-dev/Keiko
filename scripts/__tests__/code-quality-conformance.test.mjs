import { expect, it } from "vitest";
import { qualifyPolicyFixtures } from "./support/code-quality-conformance.mjs";

it("runs all 21 immutable noncosmetic upstream suites through the production compilation path (#3915)", () => {
  const fixtures = qualifyPolicyFixtures();
  expect(fixtures).toHaveLength(21);
  expect(fixtures.reduce((sum, entry) => sum + entry.safe.total, 0)).toBe(190);
  expect(fixtures.reduce((sum, entry) => sum + entry.bad.total, 0)).toBe(191);
  expect(fixtures.every((entry) => entry.safe.failed === 0 && entry.bad.failed === 0)).toBe(true);
  // Effect fixtures are syntactic controls; native-host Effect API qualification belongs to #3988.
  expect(fixtures.filter((entry) => entry.id.startsWith("anti-slop-effect/"))).toHaveLength(5);
});
