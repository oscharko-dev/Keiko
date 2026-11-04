// Findings of the independent review of the number formatter (#4235). Every expectation was
// checked against what LibreOffice shows for the same workbook cell.

import { describe, expect, it } from "vitest";

import { formatNumericCell } from "./xlsx-number-format.js";

function render(raw: string, code: string): string {
  return formatNumericCell({
    raw,
    numFmtId: 164,
    customNumFmts: new Map([[164, code]]),
    date1904: false,
  });
}

describe("elapsed time formats", () => {
  it.each([
    ["1.5", String.raw`[h]:mm`, "36:00"],
    ["0.0625", String.raw`[h]:mm:ss`, "01:30:00"],
    ["1.5", String.raw`[hh]:mm`, "36:00"],
    ["0.0034722222", String.raw`[m]`, "5"],
    ["0.5", String.raw`[mm]:ss`, "720:00"],
    ["0.5", String.raw`[s]`, "43200"],
  ] as const)("renders %s with %s as %s, never as a date", (raw, code, expected) => {
    expect(render(raw, code)).toBe(expected);
  });
});

describe("digits beyond the 15 significant ones", () => {
  it.each([
    // Excel keeps 15 significant digits; the rest are zeros, not the binary expansion.
    ["12345678901234567890", "0", "12345678901234600000"],
    ["12345678901234567890", "0.00", "12345678901234600000.00"],
    ["12345678901234567890", "0.0%", "1234567890123460000000.0%"],
    ["123456789012", "0.0000000000", "123456789012.0000000000"],
    ["1E+300", "0", `1${"0".repeat(300)}`],
    ["0.30000000000000004", "0.0000000000000000", "0.3000000000000000"],
    ["1.005", "0.00", "1.01"],
    ["-2.675", "0.00", "-2.68"],
    ["0.145", "0.0%", "14.5%"],
    ["12345.6789", "0.000E+00", "1.235E+04"],
    ["0.000123456", "0.00E+00", "1.23E-04"],
    ["9.999", "0.00E+00", "1.00E+01"],
  ] as const)("renders %s with %s as %s", (raw, code, expected) => {
    expect(render(raw, code)).toBe(expected);
  });

  it("falls back to General for a format with absurdly many digits instead of throwing", () => {
    expect(render("0.5", `0.${"0".repeat(120)}`)).toBe("0.5");
    expect(render("0.5", `0.${"0".repeat(101)}E+00`)).toBe("0.5");
    expect(render("1", "0".repeat(250))).toBe("1");
  });
});

describe("thousands scaling by trailing commas", () => {
  it.each([
    ["1234567", "#,##0,", "1235"],
    ["-1234567", "#,##0,", "-1235"],
    ["1234567", String.raw`0.0,,"M"`, "1.2M"],
    ["1234567", "0.0,", "1234.6"],
    ["1234567", "#,##0", "1234567"],
    ["500", "#,##0,", "1"],
    ["400", "#,##0,", "0"],
  ] as const)("renders %s with %s as %s", (raw, code, expected) => {
    expect(render(raw, code)).toBe(expected);
  });
});

describe("conditional sections", () => {
  const compact = String.raw`[>=1000000]0.0,,"M";[>=1000]0.0,"K";0`;
  it.each([
    ["0.3", "[>=100]0;0.0", "0.3"],
    ["250", "[>=100]0;0.0", "250"],
    ["-5", "[>=100]0;0.0", "-5.0"],
    ["2500000", compact, "2.5M"],
    ["2500", compact, "2.5K"],
    ["25", compact, "25"],
    ["-3", "[<0](0);0", "(3)"],
    ["5", "[Red][<=100]0.00;0", "5.00"],
  ] as const)("renders %s with %s as %s", (raw, code, expected) => {
    expect(render(raw, code)).toBe(expected);
  });
});

describe("sections without a digit placeholder", () => {
  it.each([
    ["0", String.raw`0;-0;"n/a"`, "n/a"],
    ["0", String.raw`#,##0_);(#,##0);"-"_)`, "-"],
    ["7", String.raw`0;-0;"n/a"`, "7"],
    ["-7", String.raw`0;-0;"n/a"`, "-7"],
  ] as const)("renders %s with %s as %s", (raw, code, expected) => {
    expect(render(raw, code)).toBe(expected);
  });
});
