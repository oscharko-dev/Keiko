import { expect, test, type Locator, type Page } from "@playwright/test";

// The proposed Jira draft is what the human approves, so every value of it must stay inspectable in
// a narrow panel (320 px is 400% zoom of a 1280 px window) and every control must be targetable.
// jsdom has no layout, so this measures the product component on the product styles in Chromium.
// The harness at tests/e2e/support/jira-draft-layout/ starts no Keiko server, model or Jira.
const HARNESS = `http://127.0.0.1:${process.env.KEIKO_E2E_DRAFT_PORT ?? "32384"}/`;
// The design system's component minimum: design-system/accessibility.html and
// docs/design-system/visual-qa-matrix.md.
const MIN_TARGET_PX = 24;

type Locale = "en" | "de";
type Shape = "shallow" | "nested" | "flattened" | "long";

interface Presentation {
  readonly name: string;
  readonly colorScheme: "light" | "dark";
  readonly contrast?: "more";
  readonly forcedColors?: "active";
}
const PRESENTATIONS: readonly Presentation[] = [
  { name: "light", colorScheme: "light" },
  { name: "dark", colorScheme: "dark" },
  { name: "prefers-contrast", colorScheme: "dark", contrast: "more" },
  { name: "forced-colors", colorScheme: "dark", forcedColors: "active" },
];

async function open(
  page: Page,
  options: { locale: Locale; shape: Shape; width: number; presentation: Presentation },
): Promise<Locator> {
  const { presentation } = options;
  await page.setViewportSize({ width: options.width, height: 900 });
  await page.emulateMedia({
    colorScheme: presentation.colorScheme,
    contrast: presentation.contrast ?? "no-preference",
    forcedColors: presentation.forcedColors ?? "none",
  });
  await page.goto(`${HARNESS}?locale=${options.locale}&shape=${options.shape}`);
  await page.evaluate((scheme) => {
    document.documentElement.dataset.theme = scheme;
  }, presentation.colorScheme);
  const draft = page.locator("fieldset");
  await expect(draft).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", options.locale);
  return draft;
}

/** Elements of the draft whose right edge lies outside the panel the human sees. */
async function clipped(draft: Locator): Promise<readonly string[]> {
  return draft.evaluate((element) => {
    const card = element.closest("[data-harness='card']") ?? element;
    const edge = card.getBoundingClientRect().right;
    return Array.from(element.querySelectorAll("*"))
      .filter((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.right > edge + 1;
      })
      .map((node) => `${node.tagName.toLowerCase()}:${node.textContent.slice(0, 40)}`);
  });
}

async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

for (const locale of ["en", "de"] as const) {
  for (const presentation of PRESENTATIONS) {
    const name = `${locale} / ${presentation.name}`;

    test(`nested opaque field values stay inside a 320 px panel (${name})`, async ({ page }) => {
      // 700 px is the wide control: the same values fit there, so only the narrow panel can fail.
      for (const width of [700, 320]) {
        for (const shape of ["shallow", "nested", "flattened"] as const) {
          const draft = await open(page, { locale, shape, width, presentation });
          const where = `${shape} at ${String(width)} px`;
          expect(await clipped(draft), `${where} fits the panel`).toEqual([]);
          expect(await pageOverflow(page), `${where} needs no horizontal scrolling`).toBe(0);
        }
      }
      // The approved leaf is rendered, not only reachable: it sits inside the visible panel.
      const draft = await open(page, { locale, shape: "flattened", width: 320, presentation });
      const leaf = draft.getByText("Ada", { exact: true });
      await expect(leaf).toBeVisible();
      const box = await leaf.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
    });

    test(`a long proposed value expands with a 24 px target (${name})`, async ({ page }) => {
      for (const width of [320, 1024]) {
        const draft = await open(page, { locale, shape: "long", width, presentation });
        const toggle = draft.locator("button[aria-expanded]");
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        const box = await toggle.boundingBox();
        expect(box?.width ?? 0).toBeGreaterThanOrEqual(MIN_TARGET_PX);
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TARGET_PX);
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(await clipped(draft), `expanded value fits at ${String(width)} px`).toEqual([]);
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
      }
    });
  }
}
