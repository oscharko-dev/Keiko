// Shared mechanics for owned, local design-system fixtures. No product data is accepted here.
async function setFixtureTheme(page, mode) {
  await page.evaluate(
    ({ theme, hc }) => {
      for (const [name, value] of Object.entries({ theme, hc })) {
        if (value) globalThis.document.documentElement.dataset[name] = value;
        else globalThis.document.documentElement.removeAttribute("data-" + name);
      }
    },
    { theme: mode.theme, hc: mode.hc },
  );
}

export async function loadHtmlFixture(page, html, mode, media) {
  await page.emulateMedia(media);
  await page.setContent(html, { waitUntil: "load" });
  await setFixtureTheme(page, mode);
}

export function renderedFixtureColours(input) {
  const canvas = Object.assign(globalThis.document.createElement("canvas"), {
    width: 1,
    height: 1,
  });
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("Fixture colour context is unavailable");
  const pixel = (colour) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = colour;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data.join(",");
  };
  if (input.kind === "tokens") {
    const root = globalThis.getComputedStyle(globalThis.document.documentElement);
    return Object.fromEntries(
      input.tokens.map((token) => {
        const element = globalThis.document.querySelector(`[data-tok="${token}"]`);
        return [
          token,
          {
            rgba:
              element === null ? "__MISSING__" : pixel(globalThis.getComputedStyle(element).color),
            defined: root.getPropertyValue(token).trim() !== "",
          },
        ];
      }),
    );
  }
  return Object.fromEntries(
    input.probes.map(([selector, properties]) => {
      const element = globalThis.document.querySelector(selector);
      if (element === null) return [selector, "__MISSING__"];
      const style = globalThis.getComputedStyle(element);
      return [
        selector,
        Object.fromEntries(properties.map((property) => [property, pixel(style[property])])),
      ];
    }),
  );
}

export function rgbaClose(left, right, tolerance = 1) {
  if (left === "__MISSING__" || right === "__MISSING__") return left === right;
  const a = left.split(",").map(Number),
    b = right.split(",").map(Number);
  return (
    a.length === 4 &&
    b.length === 4 &&
    a.every((value, index) => Math.abs(value - b[index]) <= tolerance)
  );
}

export function compareColourProbes(reference, product, probes, mode) {
  const missing = probes
    .map(([selector]) => selector)
    .filter(
      (selector) => reference[selector] === "__MISSING__" || product[selector] === "__MISSING__",
    );
  const absent = new Set(missing);
  const rows = probes.flatMap(([selector]) =>
    absent.has(selector)
      ? []
      : Object.keys(product[selector]).map((prop) => ({
          mode,
          selector,
          prop,
          reference: reference[selector]?.[prop],
          product: product[selector][prop],
        })),
  );
  return {
    total: rows.length,
    missing,
    differences: rows.filter((row) => !rgbaClose(row.reference, row.product)),
  };
}

export async function fixtureMediaProbe(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [
        ["reducedMotion", "(prefers-reduced-motion: reduce)"],
        ["forcedColors", "(forced-colors: active)"],
        ["prefersContrast", "(prefers-contrast: more)"],
      ].map(([name, query]) => [name, globalThis.matchMedia(query).matches]),
    ),
  );
}

export async function captureResponsiveFixture(context, html, viewport, path) {
  const page = await context.newPage();
  try {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize(viewport);
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path, fullPage: true });
  } finally {
    await page.close();
  }
}

export function measureFixtureScroll(selectors) {
  const scroll = globalThis.document.querySelector(selectors.scrollSelector);
  const rowCount = globalThis.document.querySelectorAll(selectors.rowSelector).length;
  const header = globalThis.document.querySelector(selectors.headerSelector);
  if (!(scroll instanceof globalThis.HTMLElement) || !(header instanceof globalThis.HTMLElement)) {
    return { ok: false, reason: "missing bounded-row smoke elements" };
  }
  const start = globalThis.performance.now();
  scroll.scrollTop = scroll.scrollHeight;
  const afterScrollTop = scroll.scrollTop;
  const positions = [header, scroll].map((element) => element.getBoundingClientRect().top);
  scroll.scrollTop = 0;
  scroll.scrollTop = scroll.scrollHeight / 2;
  const durationMs = globalThis.performance.now() - start;
  return {
    ok: true,
    rowCount,
    durationMs,
    afterScrollTop,
    scrollHeight: scroll.scrollHeight,
    clientHeight: scroll.clientHeight,
    stickyHeaderDeltaPx: Math.abs(positions[0] - positions[1]),
  };
}
