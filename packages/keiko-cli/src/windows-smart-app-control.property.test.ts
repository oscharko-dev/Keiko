import { describe, expect, it } from "vitest";
import {
  arrayOf,
  assertFrequencyFloor,
  checkProperty,
  propertySettings,
  unicodeString,
  type Generator,
} from "../../../tests/support/property-testing.js";
import {
  SMART_APP_CONTROL_STATES,
  smartAppControlStateFromRegQuery,
  type SmartAppControlState,
} from "./windows-smart-app-control.js";

interface RegCase {
  readonly noise: readonly string[];
  readonly value: number | undefined;
  readonly separator: "\r\n" | "\n";
}

const STATE_FOR_VALUE: ReadonlyMap<number, SmartAppControlState> = new Map([
  [0, "off"],
  [1, "on"],
  [2, "evaluation"],
]);

// Noise never carries the value name, so the only value line is the one the case places.
const noiseLine: Generator<string> = (random) =>
  unicodeString(40)(random).replaceAll("VerifiedAndReputablePolicyState", "");

const regCase: Generator<RegCase> = (random) => ({
  noise: arrayOf(noiseLine, 0, 6)(random),
  value: random.chance(0.8) ? random.pick([0, 1, 2, 3, 255, 0xffffffff]) : undefined,
  separator: random.pick(["\r\n", "\n"] as const),
});

function render(input: RegCase): string {
  const lines = [...input.noise];
  if (input.value !== undefined) {
    const line = `    VerifiedAndReputablePolicyState    REG_DWORD    0x${input.value.toString(16)}`;
    lines.splice(Math.floor(lines.length / 2), 0, line);
  }
  return lines.join(input.separator);
}

describe("smartAppControlStateFromRegQuery properties", () => {
  it("names exactly the state of the one value line, and unknown for anything else", async () => {
    const name = "smart-app-control-reg-query";
    const { runs } = propertySettings({ name });
    let enforcing = 0;
    await checkProperty({
      name,
      generate: regCase,
      property: (input) => {
        const state = smartAppControlStateFromRegQuery(render(input));
        expect(SMART_APP_CONTROL_STATES).toContain(state);
        const expected =
          input.value === undefined ? "unknown" : (STATE_FOR_VALUE.get(input.value) ?? "unknown");
        expect(state).toBe(expected);
        if (state === "on") enforcing += 1;
      },
    });
    assertFrequencyFloor({
      what: "an enforcing policy value",
      count: enforcing,
      runs,
      share: 0.05,
      validatedRuns: 200,
    });
  });
});
