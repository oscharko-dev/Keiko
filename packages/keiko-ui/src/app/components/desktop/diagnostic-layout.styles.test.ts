import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "postcss";
import { describe, expect, it } from "vitest";

function declarations(file: string, selector: string): Record<string, string> {
  const values: Record<string, string> = {};
  parse(readFileSync(join(import.meta.dirname, file), "utf8")).walkRules((rule) => {
    if (rule.selectors.includes(selector))
      rule.walkDecls((item) => {
        values[item.prop] = item.value;
      });
  });
  return values;
}

describe("diagnostic action layout", () => {
  it("lets wrapped report controls grow beyond the global fixed button height", () => {
    const action = declarations("SupportReportButton.module.css", ".cmpControl .cmpAction");
    expect(action).toMatchObject({ height: "auto", "min-height": "28px", "white-space": "normal" });
  });
  it("keeps the alert stack bounded and clickable without swallowing gaps or clipping focus", () => {
    const stack = declarations("AppShell.module.css", ".cmpSourceAlertStack");
    expect(stack).toMatchObject({
      position: "absolute",
      display: "flex",
      "flex-direction": "column",
      "max-height": "calc(100% - 28px)",
      "overflow-y": "auto",
      "pointer-events": "none",
      padding: "6px",
    });
    expect(declarations("AppShell.module.css", ".cmpSourceAlertStack > *")).toMatchObject({
      position: "static",
      "flex-shrink": "0",
      "pointer-events": "auto",
      transform: "none",
      width: "100%",
    });
  });
  it("uses the design-system focus colour and width for technical source details", () => {
    expect(
      declarations("GroundedAnswer.module.css", ".cmpOriginalDetails > summary:focus-visible"),
    ).toMatchObject({
      outline: "var(--focus-width, 2px) solid var(--focus-ring)",
      "outline-offset": "2px",
    });
  });
});
