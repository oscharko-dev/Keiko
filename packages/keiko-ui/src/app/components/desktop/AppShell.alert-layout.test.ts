import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "AppShell.module.css"),
  "utf8",
);

function rule(selector: string): string {
  const start = styles.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  return styles.slice(start, styles.indexOf("}", start) + 1);
}

describe("workspace error notice stack", () => {
  it("positions the stack once while preserving the existing single-alert placement", () => {
    const stack = rule(".cmpSourceAlertStack {");
    expect(stack).toMatch(/position:\s*absolute/u);
    expect(stack).toMatch(/bottom:\s*14px/u);
    expect(stack).toMatch(/left:\s*50%/u);
    expect(stack).toMatch(/flex-direction:\s*column/u);
    expect(stack).toMatch(/pointer-events:\s*none/u);
  });

  it("keeps independently actionable alerts in flow inside the stack", () => {
    const alert = rule('.cmpSourceAlertStack > [role="alert"]');
    expect(alert).toMatch(/position:\s*static/u);
    expect(alert).toMatch(/transform:\s*none/u);
    expect(alert).toMatch(/width:\s*100%/u);
    expect(alert).not.toMatch(/position:\s*absolute/u);
  });
});
