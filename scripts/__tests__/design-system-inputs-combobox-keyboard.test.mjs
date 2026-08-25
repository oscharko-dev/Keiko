// KEIKO-0489 regression pin: the combobox keyboard handler in design-system/inputs.html
// must land the first ArrowUp on the LAST option (and ArrowDown on the FIRST) whenever
// nothing is highlighted yet — whether the list was closed, was just opened by focus, or
// was just reset by typing. The naive fold:
//
//     active = (active + d + filtered.length) % filtered.length;
//
// with `active === -1` (nothing highlighted) and `d === -1` (ArrowUp), for a 6-item list
// evaluates to `(-1 + -1 + 6) % 6 === 4`, landing on index 4 (claude-opus) instead of
// index 5 (llama-3.1-70b, the actual last option).
//
// design-system/inputs.html is the canonical WAI-ARIA reference pattern for the shipped
// Combobox component in packages/keiko-ui — a bug here is copy-pasted into the real
// component and mis-announces the focused option to assistive technology.
//
// A prior fix branched nextActive() on `wasHidden` (was the list hidden right before this
// keypress?) instead of on the `active === -1` sentinel. That branch is FALSE on the real
// user path: the `focus` handler already calls openList(true) before the first keydown can
// ever fire, and the `input` handler leaves the list open too — so on the path a real user
// actually takes (tab into the field, press ArrowUp), the code silently fell through to the
// buggy modulo fold. A prior version of this pin only exercised Escape-then-ArrowUp, where
// the list really is hidden beforehand — that happens to take the correct branch and never
// catches the regression. The fix keys off `active === -1` directly, which is true on every
// path that must land on an end (closed, focus-opened, post-typing) and false once real
// navigation has begun (wrap-around then continues through the plain modulo fold).
//
// The disposition (issue #2903, Group D KEIKO-0489) records "no automated test — manual"
// because design-system/*.html has no test harness co-located with it. This pin covers the
// real paths: focus (no Escape) in both directions, Escape-then-ArrowUp (kept as a
// non-regression check on the adjacent path), typing then ArrowUp against the filtered set,
// and continued wrap-around once navigation is underway.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const inputsHtmlPath = resolve(repoRoot, "design-system", "inputs.html");

// The MODELS list from inputs.html — the last entry is the one ArrowUp-from-nothing-active
// must land on.
const LAST_MODEL_INDEX = 5;
const LAST_MODEL_NAME = "llama-3.1-70b";
// A query that filters MODELS down to a strict subset ("claude-sonnet", "claude-haiku",
// "claude-opus") — used to prove the fix also holds for the post-typing path, where the
// active option must land on the last of the FILTERED set, not the last of the full list.
const FILTER_QUERY = "claude";
const FILTERED_LAST_NAME = "claude-opus";

function loadInputsHtml() {
  const html = readFileSync(inputsHtmlPath, "utf8");
  // The page is handed to jsdom verbatim. `resources` is left at its default, under which
  // jsdom does NOT fetch external subresources — the `<link>` stylesheets and the
  // `<script src="ds-nav.js">` tag are parsed but never loaded, so no network access and no
  // unrelated script execution can happen. Only the inline `<script>` that owns the combobox
  // runs, which is exactly what this pin exercises. (Regex-stripping the tags instead would
  // be both unnecessary and unsound — HTML is not a regular language.)
  return new JSDOM(html, {
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

function dispatchInput(input, value) {
  input.value = value;
  input.dispatchEvent(new input.ownerDocument.defaultView.Event("input", { bubbles: true }));
}

describe("design-system/inputs.html — combobox lands on the correct end on the real user paths", () => {
  it("focus then ArrowUp with NO Escape lands active on the last option (the real user path)", () => {
    const dom = loadInputsHtml();
    const { document } = dom.window;

    const combo = document.getElementById("combo-in");
    const list = document.getElementById("combo-list");
    expect(combo, "combo-in must exist in inputs.html").not.toBeNull();
    expect(list, "combo-list must exist in inputs.html").not.toBeNull();

    // Tabbing into the field opens the list via the `focus` handler — this is the real
    // path, with no Escape in between.
    combo.focus();
    expect(list.hidden, "focus must open the list").toBe(false);

    dispatchKey(combo, "ArrowUp");

    expect(list.hidden).toBe(false);
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

  it("focus then ArrowDown with NO Escape lands active on the first option (symmetry pin)", () => {
    const dom = loadInputsHtml();
    const { document } = dom.window;

    const combo = document.getElementById("combo-in");
    const list = document.getElementById("combo-list");

    combo.focus();
    expect(list.hidden).toBe(false);

    dispatchKey(combo, "ArrowDown");

    expect(list.hidden).toBe(false);
    expect(combo.getAttribute("aria-activedescendant")).toBe("copt-0");

    dom.window.close();
  });

  it("Escape then ArrowUp still lands active on the last option (adjacent path, kept)", () => {
    const dom = loadInputsHtml();
    const { document } = dom.window;

    const combo = document.getElementById("combo-in");
    const list = document.getElementById("combo-list");

    combo.focus();
    dispatchKey(combo, "Escape");
    expect(list.hidden, "Escape must close the list before the ArrowUp under test").toBe(true);

    dispatchKey(combo, "ArrowUp");

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

  it("typing filters the list, then ArrowUp lands active on the last FILTERED option", () => {
    const dom = loadInputsHtml();
    const { document } = dom.window;

    const combo = document.getElementById("combo-in");
    const list = document.getElementById("combo-list");

    // Focus opens the list; typing fires the `input` handler, which resets active = -1
    // while leaving the list open — the third real path that must land on an end.
    combo.focus();
    dispatchInput(combo, FILTER_QUERY);

    // paintCombo() re-renders cl.innerHTML on every call (including from the ArrowUp
    // handler below), so the filtered count/last-index must be read now — the option
    // elements themselves are about to be discarded and rebuilt, but the filtered set
    // (driven by ci.value, which ArrowUp does not change) stays the same.
    const filteredCountBeforeNav = list.querySelectorAll(".c-combo-opt").length;
    expect(
      filteredCountBeforeNav,
      `typing "${FILTER_QUERY}" must filter the list down to the matching models`,
    ).toBeGreaterThan(0);
    const lastFilteredIndex = filteredCountBeforeNav - 1;

    dispatchKey(combo, "ArrowUp");

    expect(list.hidden).toBe(false);
    expect(
      combo.getAttribute("aria-activedescendant"),
      `aria-activedescendant must be copt-${lastFilteredIndex} (last of the FILTERED set)`,
    ).toBe(`copt-${lastFilteredIndex}`);
    const activeOption = list.querySelector(".c-combo-opt.active");
    expect(activeOption, "an option must carry the .active class").not.toBeNull();
    expect(activeOption?.id).toBe(`copt-${lastFilteredIndex}`);
    expect(activeOption?.textContent).toContain(FILTERED_LAST_NAME);

    dom.window.close();
  });

  it("wrap-around still works in both directions once navigation is underway", () => {
    const dom = loadInputsHtml();
    const { document } = dom.window;

    const combo = document.getElementById("combo-in");
    const list = document.getElementById("combo-list");

    combo.focus();
    dispatchKey(combo, "ArrowDown"); // -1 -> 0
    expect(combo.getAttribute("aria-activedescendant")).toBe("copt-0");

    dispatchKey(combo, "ArrowUp"); // 0 -> wraps back to the last option
    expect(combo.getAttribute("aria-activedescendant")).toBe(`copt-${LAST_MODEL_INDEX}`);

    dispatchKey(combo, "ArrowDown"); // last -> wraps forward to the first option
    expect(combo.getAttribute("aria-activedescendant")).toBe("copt-0");

    expect(list.hidden).toBe(false);
    dom.window.close();
  });
});
