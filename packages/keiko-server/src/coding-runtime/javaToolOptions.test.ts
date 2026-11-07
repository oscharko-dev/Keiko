import { describe, expect, it } from "vitest";

import {
  characters,
  checkProperty,
  shrinkString,
  type SeededRandom,
} from "../../../../tests/support/seeded-property.js";
import { javaSystemProperty, javaToolOptions } from "./javaToolOptions.js";

/**
 * HotSpot's own reading of `JAVA_TOOL_OPTIONS` (`Arguments::parse_options_buffer`): split at
 * whitespace outside quotes, strip single or double quotes, expand nothing, and refuse an unmatched
 * quote. The JVM owns this rule, not the code under test; its behaviour was confirmed against
 * OpenJDK 21 (#4271): `'-Duser.home=/tmp/o'"'"'neil dir $HOME'` arrives as `/tmp/o'neil dir $HOME`,
 * and an unmatched quote prints "Unmatched quote in JAVA_TOOL_OPTIONS" and stops the JVM.
 */
function hotspotOptions(buffer: string): readonly string[] | "unmatched-quote" {
  const options: string[] = [];
  const space = /[ \t\n\v\f\r]/u;
  let index = 0;
  while (index < buffer.length) {
    while (index < buffer.length && space.test(buffer.charAt(index))) index += 1;
    if (index >= buffer.length) break;
    let option = "";
    while (index < buffer.length && !space.test(buffer.charAt(index))) {
      const character = buffer.charAt(index);
      if (character !== "'" && character !== '"') {
        option += character;
        index += 1;
        continue;
      }
      const close = buffer.indexOf(character, index + 1);
      if (close === -1) return "unmatched-quote";
      option += buffer.slice(index + 1, close);
      index = close + 1;
    }
    options.push(option);
  }
  return options;
}

const HOSTILE = [
  ...characters("abc/._-~"),
  " ",
  "\t",
  "\n",
  "'",
  '"',
  "$",
  "\\",
  "`",
  "*",
  "=",
  ",",
  "${",
  "}",
  "--",
  "ü",
  " ",
  "😀",
];

function value(random: SeededRandom): string {
  return random.string(HOSTILE, 0, 24);
}

describe("JAVA_TOOL_OPTIONS for a native run", () => {
  it("quotes a value with an apostrophe, a space and a dollar sign exactly", () => {
    expect(javaSystemProperty("user.home", "/tmp/o'neil dir $HOME")).toBe(
      "'-Duser.home=/tmp/o'\"'\"'neil dir $HOME'",
    );
  });

  it("hands HotSpot every generated value byte for byte, as one option", () => {
    checkProperty(
      value,
      (generated) => {
        expect(hotspotOptions(javaSystemProperty("user.home", generated))).toEqual([
          `-Duser.home=${generated}`,
        ]);
      },
      { shrink: shrinkString },
    );
  });

  it("keeps every run property its own option after any well-formed inherited value", () => {
    checkProperty(
      (random) => ({
        inherited: random.array(0, 3, () => `-Dinherited.${String(random.integer(0, 9))}=x`),
        home: value(random),
        tmp: value(random),
      }),
      ({ inherited, home, tmp }) => {
        const buffer = javaToolOptions(inherited.join(" ") || undefined, {
          "java.io.tmpdir": tmp,
          "user.home": home,
        });
        expect(hotspotOptions(buffer)).toEqual([
          ...inherited,
          `-Djava.io.tmpdir=${tmp}`,
          `-Duser.home=${home}`,
        ]);
      },
    );
  });

  it("makes the JVM refuse to start, never absorb the run's options, after an unmatched quote", () => {
    checkProperty(
      (random) => ({ quote: random.pick(["'", '"']), home: value(random) }),
      ({ quote, home }) => {
        const buffer = javaToolOptions(`-Dbroken=${quote}x`, { "user.home": home });
        expect(hotspotOptions(buffer)).toBe("unmatched-quote");
      },
    );
  });
});
