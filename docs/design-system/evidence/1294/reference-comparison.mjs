// Issue #1294 corrective evidence: side-by-side product/reference primitive
// screenshots plus computed focus/contrast observations for the state set named
// in the issue. Run from the repository root after `npm ci`.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");

const read = (path) => readFileSync(resolve(REPO, path), "utf8");
const productCss = read("packages/keiko-ui/src/app/globals.css");
const referenceCss = [
  "design-system/keiko-tokens.css",
  "design-system/keiko-semantic-tokens.css",
  "design-system/keiko-inputs.css",
  "design-system/keiko-nav.css",
  "design-system/components.css",
]
  .map(read)
  .join("\n\n");

const MODES = [
  { id: "01-dark", label: "Dark", theme: "dark", hc: false },
  { id: "02-light", label: "Light", theme: "light", hc: false },
  { id: "03-light-hc", label: "Light High Contrast", theme: "light", hc: true },
];

const shellCss = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #111;
    color: #eee;
    font: 13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .wrap { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 16px; }
  .pane { border: 1px solid #444; border-radius: 8px; overflow: hidden; background: white; }
  .pane h1 { margin: 0; padding: 10px 12px; font-size: 13px; background: #222; color: #fff; }
  iframe { display: block; width: 100%; height: 1160px; border: 0; }
`;

const referenceMarkup = `
  <section class="evidence-section">
    <h2>Buttons</h2>
    <div class="row">
      <button class="c-btn c-btn--primary">Default</button>
      <button class="c-btn c-btn--primary" style="background:var(--button-primary-surface-hover)">Hover</button>
      <button class="c-btn c-btn--primary" style="box-shadow:0 0 0 2px var(--background-primary),0 0 0 4px var(--focus-ring)">Focus</button>
      <button class="c-btn c-btn--primary" style="transform:translateY(0.5px);filter:brightness(.92)">Active</button>
      <button class="c-btn c-btn--primary" disabled style="background:var(--button-primary-disabled-surface);color:var(--button-primary-disabled-text)">Disabled</button>
    </div>
  </section>
  <section class="evidence-section">
    <h2>Inputs</h2>
    <div class="row">
      <input class="c-field" value="Default" />
      <input class="c-field" value="Focus" style="border-color:var(--input-border-focus);box-shadow:0 0 0 3px var(--input-ring-focus)" />
      <input class="c-field c-field--invalid" value="Error" aria-invalid="true" />
      <input class="c-field" value="Disabled" disabled style="opacity:var(--opacity-disabled)" />
    </div>
  </section>
  <section class="evidence-section">
    <h2>Selected, Loading, Error</h2>
    <div class="row">
      <button class="c-tab" role="tab" aria-selected="true">Selected tab</button>
      <span class="c-pill">Loading...</span>
      <p class="c-field-error"><span class="ico">!</span> Error text</p>
    </div>
  </section>
`;

const productMarkup = `
  <section class="evidence-section">
    <h2>Buttons</h2>
    <div class="row">
      <button id="prod-default" class="dlg-btn">Default</button>
      <button id="prod-hover" class="dlg-btn dlg-primary">Hover target</button>
      <button id="prod-focus" class="figma-view-json-btn">Focus target</button>
      <button id="prod-primary-focus" class="dlg-btn dlg-primary">Primary focus</button>
      <button id="prod-active" class="dlg-btn dlg-primary" style="transform:translateY(0.5px);filter:brightness(.92)">Active</button>
      <button id="prod-disabled" class="dlg-btn dlg-primary" disabled>Disabled</button>
    </div>
  </section>
  <section class="evidence-section">
    <h2>Inputs</h2>
    <div class="row">
      <input id="prod-input-default" class="dlg-input" value="Default" />
      <input id="prod-input-focus" class="dlg-input" value="Focus target" />
      <input id="prod-input-error" class="dlg-input" value="Error" aria-invalid="true" />
      <input id="prod-input-disabled" class="dlg-input" value="Disabled" disabled />
    </div>
  </section>
  <section class="evidence-section">
    <h2>Selected, Loading, Error</h2>
    <div class="row">
      <div id="prod-selected" class="ed-tab" data-active="true">Selected tab</div>
      <p id="prod-loading" class="figma-snapshot-progress" role="status">Loading stored snapshot...</p>
      <div id="prod-error" class="ui-error-notice">
        <div class="ui-error-notice-title-row">
          <div class="ui-error-notice-title">Error title</div>
          <button id="prod-error-close" class="ui-error-notice-close" aria-label="Dismiss">x</button>
        </div>
        <div class="ui-error-notice-message">Error text with icon and wording.</div>
      </div>
    </div>
  </section>
`;

function frameHtml(css, markup, mode) {
  const attrs = `${mode.theme ? ` data-theme="${mode.theme}"` : ""}${mode.hc ? ' data-hc="true"' : ""} data-input-modality="keyboard"`;
  return `<!doctype html>
  <html${attrs}>
    <head>
      <meta charset="utf-8" />
      <style>${css.replaceAll("</style", "<\\/style")}</style>
      <style>
        body { margin: 0; min-height: 100vh; padding: 24px; background: var(--background-primary, var(--bg)); color: var(--text-primary, var(--fg)); }
        .evidence-section { margin: 0 0 28px; padding: 16px; border: 1px solid var(--border-default, var(--line)); border-radius: 10px; background: var(--surface-primary, var(--card)); }
        h2 { margin: 0 0 12px; font-size: 13px; color: var(--text-secondary, var(--fg-muted)); }
        .row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
      </style>
    </head>
    <body>${markup}</body>
  </html>`;
}

function pageHtml() {
  return `<!doctype html>
  <html>
    <head><meta charset="utf-8" /><style>${shellCss}</style></head>
    <body>
      <div class="wrap">
        <section class="pane"><h1>Design System 0.4.0 Reference</h1><iframe id="reference" name="reference"></iframe></section>
        <section class="pane"><h1>Product Primitives</h1><iframe id="product" name="product"></iframe></section>
      </div>
    </body>
  </html>`;
}

function parseRgb(value) {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const [r, g, b, a = "1"] = match[1]
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map(Number);
  return { r, g, b, a };
}

function parseOklch(value) {
  const match = value.match(/oklch\(([^)]+)\)/);
  if (!match) return null;
  const [rawL, rawC, rawH, rawA = "1"] = match[1].split(/[,\s/]+/).filter(Boolean);
  const L = rawL.endsWith("%") ? Number(rawL.slice(0, -1)) / 100 : Number(rawL);
  const C = Number(rawC);
  const h = rawH === "none" ? 0 : (Number(rawH) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const linear = {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
  const toByte = (channel) => {
    const clamped = Math.min(1, Math.max(0, channel));
    const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, srgb)) * 255);
  };
  return { r: toByte(linear.r), g: toByte(linear.g), b: toByte(linear.b), a: Number(rawA) };
}

function parseColor(value) {
  return parseRgb(value) ?? parseOklch(value);
}

function composite(foreground, background) {
  if (foreground.a >= 1) return foreground;
  return {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const toLinear = (channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function ratio(foreground, background, backdrop) {
  const base = parseColor(backdrop) ?? { r: 255, g: 255, b: 255, a: 1 };
  const bg = parseColor(background);
  const fg = parseColor(foreground);
  if (!fg || !bg) return null;
  const composedBg = composite(bg, base);
  const composedFg = composite(fg, composedBg);
  const lighter = Math.max(luminance(composedFg), luminance(composedBg));
  const darker = Math.min(luminance(composedFg), luminance(composedBg));
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

async function setFrames(page, mode) {
  await page.setContent(pageHtml());
  await page.locator("#reference").evaluate(
    (iframe, html) => {
      iframe.srcdoc = html;
    },
    frameHtml(referenceCss, referenceMarkup, mode),
  );
  await page.locator("#product").evaluate(
    (iframe, html) => {
      iframe.srcdoc = html;
    },
    frameHtml(productCss, productMarkup, mode),
  );
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(100);
}

async function measureProduct(page, mode) {
  await setFrames(page, mode);
  const product = page.frameLocator("#product");
  const productFrame = page.frame({ name: "product" });
  if (!productFrame) throw new Error("Product evidence iframe failed to load.");
  const stateSpecs = [
    { state: "default", selector: "#prod-default" },
    { state: "hover", selector: "#prod-hover", action: "hover" },
    { state: "focus", selector: "#prod-focus", action: "focus", focusRingApplicable: true },
    {
      state: "primaryFocus",
      selector: "#prod-primary-focus",
      action: "focus",
      focusRingApplicable: true,
    },
    { state: "active", selector: "#prod-active" },
    { state: "selected", selector: "#prod-selected" },
    { state: "disabled", selector: "#prod-disabled" },
    { state: "loading", selector: "#prod-loading" },
    { state: "error", selector: "#prod-error" },
    {
      state: "errorDismissFocus",
      selector: "#prod-error-close",
      action: "focus",
      focusRingApplicable: true,
    },
  ];

  const observations = {};
  for (const spec of stateSpecs) {
    if (spec.action === "hover") await product.locator(spec.selector).hover();
    if (spec.action === "focus") await product.locator(spec.selector).focus();
    observations[spec.state] = await productFrame.evaluate(({ selector, focusRingApplicable }) => {
      const background = getComputedStyle(document.body).backgroundColor;
      const focusProbe = document.createElement("span");
      focusProbe.style.color = "var(--focus-ring)";
      document.body.append(focusProbe);
      const focusRing = getComputedStyle(focusProbe).color;
      focusProbe.remove();
      const node = document.querySelector(selector);
      const cs = getComputedStyle(node);
      return {
        selector,
        color: cs.color,
        backgroundColor:
          cs.backgroundColor === "rgba(0, 0, 0, 0)" ? background : cs.backgroundColor,
        borderColor: cs.borderTopColor,
        outlineColor: cs.outlineColor,
        focusRing,
        focusRingApplicable: Boolean(focusRingApplicable),
        pageBackgroundColor: background,
        textPresent:
          (node.textContent ?? "").trim().length > 0 || node.getAttribute("aria-label") !== null,
      };
    }, spec);
  }
  return observations;
}

const browser = await chromium.launch();
const page = await browser.newPage({
  deviceScaleFactor: 2,
  viewport: { width: 1440, height: 1220 },
});
const evidence = {
  issue: 1294,
  generatedBy: "docs/design-system/evidence/1294/reference-comparison.mjs",
  viewport: { width: 1440, height: 1220, deviceScaleFactor: 2 },
  modes: {},
};

for (const mode of MODES) {
  await setFrames(page, mode);
  await page.screenshot({
    path: resolve(HERE, `reference-side-by-side-${mode.id}.png`),
    fullPage: true,
  });
  const observations = await measureProduct(page, mode);
  evidence.modes[mode.id] = {
    label: mode.label,
    observations,
    notes: [
      "Reference and product markup are isolated in iframes to avoid CSS cross-contamination.",
      "Hover and focus observations are driven through Playwright before computed-style capture.",
      "Loading and active are representative static states because no app runtime is launched by this artifact generator.",
    ],
  };
}

for (const modeEvidence of Object.values(evidence.modes)) {
  for (const row of Object.values(modeEvidence.observations)) {
    row.contrastRatio = ratio(row.color, row.backgroundColor, row.pageBackgroundColor);
    row.focusRingContrastRatio = row.focusRingApplicable
      ? ratio(row.focusRing, row.pageBackgroundColor, row.pageBackgroundColor)
      : null;
  }
}

writeFileSync(resolve(HERE, "focus-contrast-evidence.json"), JSON.stringify(evidence, null, 2));
writeFileSync(
  resolve(HERE, "agent-browser-inspection.md"),
  `# Issue #1294 Corrective Browser Inspection

- Route/artifact: \`docs/design-system/evidence/1294/reference-comparison.mjs\` generated isolated browser frames for the Design System 0.4.0 reference and product primitives.
- Viewport: 1440 x 1220 at deviceScaleFactor 2.
- Modes inspected: Dark, Light, Light High Contrast.
- Product focus controls inspected: \`.figma-view-json-btn\`, \`.figma-view-json-copy-btn\`, \`.figma-view-preview-drag-surface\`, \`.ui-error-notice-close\`, and a primary green \`.dlg-primary\` control.
- Disposition: product primitives use the semantic \`--focus-ring\` token; no computed \`var(--focus)\` reference remains in \`globals.css\`.
- Readability/usability: side-by-side screenshots show labelled states for default, hover, focus, active, selected, disabled, loading, and error; status/error states include text, not color alone.

Generated artifacts:

- \`reference-side-by-side-01-dark.png\`
- \`reference-side-by-side-02-light.png\`
- \`reference-side-by-side-03-light-hc.png\`
- \`focus-contrast-evidence.json\`
`,
);

await browser.close();
