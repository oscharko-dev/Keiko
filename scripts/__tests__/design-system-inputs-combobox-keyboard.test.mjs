// KEIKO-0489 regression pin: the ArrowUp-from-closed keyboard handler on the combobox in
// design-system/inputs.html must land focus on the LAST option, not the second-to-last.
//
// design-system/inputs.html is the canonical WAI-ARIA reference pattern for the shipped
// Combobox component in packages/keiko-ui — a bug here is copy-pasted into the real
// component and mis-announces the focused option to assistive technology. The bug is:
//
//     active = (active + d + filtered.length) % filtered.length;
//
// With `active === -1` (closed sentinel) and `d === -1` (ArrowUp), for a 6-item list this
// evaluates to `(-1 + -1 + 6) % 6 === 4`, so the first ArrowUp from the closed state lands
// on index 4 (claude-opus) instead of index 5 (llama-3.1-70b). The fix captures whether
// the list was hidden BEFORE the just-opened branch and, in that case, lands on the ends
// (0 for ArrowDown, N-1 for ArrowUp) rather than folding through the modulo formula.
//
// The disposition (issue #2903, Group D KEIKO-0489) records "no automated test — manual"
// because design-system/*.html has no test harness co-located with it. This pin adds one:
// it loads inputs.html into jsdom, opens the combobox by focusing, closes it via Escape,
// dispatches an ArrowUp keydown, and asserts aria-activedescendant === "copt-5". Fails
// today; passes after the wasHidden special-case lands.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const inputsHtmlPath = resolve(repoRoot, "design-system", "inputs.html");

// The MODELS list from inputs.html — the last entry is the one ArrowUp-from-closed
// must land on.
const LAST_MODEL_INDEX = 5;
const LAST_MODEL_NAME = "llama-3.1-70b";

function loadInputsHtml() {
  const html = readFileSync(inputsHtmlPath, "utf8");
  // We only care about the combobox module, and inputs.html loads several external
  // stylesheets (font, tokens, ds.css) that jsdom would try to fetch. Strip <link> tags
  // and unrelated <script src=…> tags so the page is self-contained; the inline
  // <script> block that owns the combobox is preserved.
  const stripped = html
    .replaceAll(/<link[^>]*>/gu, "")
    .replaceAll(/<script src="[^"]*"><\/script>/gu, "");
  return new JSDOM(stripped, {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
}

function dispatchKey(input, key) {
  input.dispatchEvent(
    new input.ownerDocument.defaultView.KeyboardEvent("keydown", { key, bubbles: true }),
  );
}

describe("design-system/inputs.html — combobox ArrowUp-from-closed lands on the last option", () => {
  it("dispatches ArrowUp on a closed combobox and lands active on the last item", () => {
    const dom = loadInputsHtml();
    const { document } = dom.window;

    const combo = document.getElementById("combo-in");
    const list = document.getElementById("combo-list");
    expect(combo, "combo-in must exist in inputs.html").not.toBeNull();
    expect(list, "combo-list must exist in inputs.html").not.toBeNull();

    // Open the list (mirrors user focusing the input), then close via Escape.
    combo.focus();
    dispatchKey(combo, "Escape");
    expect(list.hidden, "Escape must close the list before the ArrowUp under test").toBe(true);

    // The regression: ArrowUp from the closed state.
    dispatchKey(combo, "ArrowUp");

    // The list must now be open with active pointing at the LAST option.
    expect(list.hidden, "ArrowUp must re-open the list").toBe(false);
    const activeDescendant = combo.getAttribute("aria-activedescendant");
    expect(activeDescendant, `aria-activedescendant must be copt-${LAST_MODEL_INDEX}`).toBe(
      `copt-${LAST_MODEL_INDEX}`,
    );

    const activeOption = list.querySelector(".c-combo-opt.active");
    expect(activeOption, "an option must carry the .active class").not.toBeNull();
    expect(activeOption?.textContent, `active option must be ${LAST_MODEL_NAME}`).toContain(
      LAST_MODEL_NAME,
    );

    dom.window.close();
  });

  it("ArrowDown from a closed combobox lands active on the first item (symmetry pin)", () => {
    const dom = loadInputsHtml();
    const { document } = dom.window;

    const combo = document.getElementById("combo-in");
    const list = document.getElementById("combo-list");

    combo.focus();
    dispatchKey(combo, "Escape");
    expect(list.hidden).toBe(true);

    dispatchKey(combo, "ArrowDown");

    expect(list.hidden).toBe(false);
    expect(combo.getAttribute("aria-activedescendant")).toBe("copt-0");

    dom.window.close();
  });
});
