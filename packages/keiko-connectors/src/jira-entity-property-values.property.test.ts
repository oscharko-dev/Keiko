import { expect, it } from "vitest";
import { checkProperty } from "../../../tests/support/property-testing.js";
import { jiraPropertyUserText } from "./jira-entity-property-values.js";

const CONTROL_CODES = [
  ...Array.from({ length: 32 }, (_, index) => index),
  ...Array.from({ length: 33 }, (_, index) => index + 127),
];

it("keeps bounded Unicode actor identities single-line for every control code", async () => {
  await checkProperty({
    name: "native actor identity rejects every Unicode control",
    generate: (random) =>
      random.pick(["User", "Über", "用户", "🚀", "Δ"]).repeat(random.integer(1, 8)),
    shrink: (actor) => (actor === "User" ? [] : ["User"]),
    property: (actor) => {
      expect(jiraPropertyUserText(actor)).toBe(true);
      // Every run exercises TAB, CR and LF as well as every other Cc value; no filter can hide them.
      for (const code of CONTROL_CODES)
        expect(jiraPropertyUserText(`${actor}${String.fromCodePoint(code)}${actor}`)).toBe(false);
    },
  });
});
