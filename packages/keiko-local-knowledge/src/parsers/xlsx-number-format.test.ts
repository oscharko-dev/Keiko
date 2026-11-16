import { describe, expect, it } from "vitest";

import { formatNumericCell } from "./xlsx-number-format.js";

function render(
  raw: string,
  numFmtId: number | undefined,
  options: { readonly code?: string; readonly date1904?: boolean } = {},
): string {
  return formatNumericCell({
    raw,
    numFmtId,
    customNumFmts: options.code === undefined ? new Map() : new Map([[164, options.code]]),
    date1904: options.date1904 ?? false,
  });
}

describe("formatNumericCell numbers", () => {
  it.each([
    ["-1234.5", 4, undefined, "-1234.50"],
    ["2.5", 164, "0.0#", "2.5"],
    ["2.25", 164, "0.0#", "2.25"],
    ["2", 164, "0.0#", "2.0"],
    ["7", 164, "000", "007"],
    ["12345", 164, "0.00E+00", "1.23E+04"],
    ["-5", 164, "#,##0;(#,##0)", "(5)"],
    ["0.005", 9, undefined, "1%"],
    ["1.005", 164, "0.00", "1.01"],
    ["0.5", 164, "# ?/?", "0.5"],
    ["12", undefined, undefined, "12"],
    ["1.5E-5", undefined, undefined, "0.000015"],
    ["12", 164, "General", "12"],
    ["12.50", 164, String.raw`"EUR"\ 0.00`, "EUR 12.50"],
    ["12.5", 164, "[$€-407]\\ 0.0", "€ 12.5"],
  ] as const)("renders %s with format %s %s as %s", (raw, id, code, expected) => {
    expect(render(raw, id, code === undefined ? {} : { code })).toBe(expected);
  });

  it("returns a payload that is not a finite number unchanged", () => {
    expect(render("n/a", 14)).toBe("n/a");
    expect(render("", 14)).toBe("");
    expect(render("Infinity", 14)).toBe("Infinity");
  });

  it("keeps a text-format number as written", () => {
    expect(render("007", 49)).toBe("007");
  });
});

describe("formatNumericCell dates and times", () => {
  it("handles the 1900 date system including its non-existent leap day", () => {
    expect(render("1", 14)).toBe("1900-01-01");
    expect(render("59", 14)).toBe("1900-02-28");
    expect(render("60", 14)).toBe("1900-02-29");
    expect(render("61", 14)).toBe("1900-03-01");
    expect(render("45292", 14)).toBe("2024-01-01");
  });

  it("handles the 1904 date system", () => {
    expect(render("0", 14, { date1904: true })).toBe("1904-01-01");
    expect(render("1462", 14, { date1904: true })).toBe("1908-01-02");
  });

  it("renders custom date, time and date-time formats", () => {
    expect(render("45292", 164, { code: "dd.mm.yyyy" })).toBe("2024-01-01");
    expect(render("45292.75", 164, { code: "yyyy-mm-dd hh:mm:ss" })).toBe("2024-01-01 18:00:00");
    expect(render("0.5208333333", 164, { code: "hh:mm" })).toBe("12:30");
    expect(render("0.5", 164, { code: "[$-407]hh:mm" })).toBe("12:00");
  });

  it("does not take a numeric format with quoted or escaped letters for a date", () => {
    expect(render("5", 164, { code: String.raw`0 "days" \m` })).toBe("5 days m");
  });

  it("renders elapsed hours and seconds", () => {
    expect(render("1.5", 46)).toBe("36:00:00");
    expect(render("0.5000115741", 21)).toBe("12:00:01");
  });

  it("leaves a serial outside the representable range as written", () => {
    expect(render("-1", 14)).toBe("-1");
    expect(render("99999999", 14)).toBe("99999999");
  });
});
