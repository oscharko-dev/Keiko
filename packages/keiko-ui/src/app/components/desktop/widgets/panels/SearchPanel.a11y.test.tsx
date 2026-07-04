// GEN-UI-TEST-GAP-002 — a11y smoke test for the workspace Search panel. jest-axe runs the WCAG rule
// set; the honest coming-soon placeholder (disabled search input + described-by help) MUST emit zero
// violations. SearchPanel reads an OPTIONAL catalog context, so it renders standalone without a
// provider (falling back to "No project selected").

import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import { SearchPanel } from "./SearchPanel";

describe("SearchPanel a11y", () => {
  it("has no axe violations", async () => {
    const { container } = render(<SearchPanel />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
