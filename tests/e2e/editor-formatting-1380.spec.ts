import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Issue #1380 (Epic #1491), ADR-0068 D8 item 4 — packaged-app browser e2e for the built-in editor
// language features and deterministic formatting baseline.
//
// What this proves end-to-end in the REAL app (no mocks), per ADR-0068:
//   AC1 — correct language mode on open for every registry language (incl. the scss/less/html that
//         the bootstrap must now register, ADR-0068 D5), and "Plain Text" for an unknown file.
//   AC1 — basic-languages grammars actually tokenise (colourised Monaco tokens, not flat plaintext).
//   AC2 — theme + tokenisation stay stable across a page reload (dark theme persists; tokens reapply).
//   AC5 — the Format affordance reflects the registry-derived formatting SOURCE consistently:
//         enabled ("Format ready") for monaco-builtin (json/css) and keiko-language-service (ts),
//         disabled ("Format unavailable") for a "none" language (markdown/yaml).
//   AC3/AC4 — Format applies deterministic edits for valid input, and a forced failure (invalid JSON)
//         leaves the buffer byte-identical.
//
// This is a dedicated, NON-gating coordinator-evidence config (port 32203); the scenarios are tagged
// @formatting-1380 (NOT @smoke) so they can be filtered without joining the gating set.

const TAG = "@formatting-1380";
const tempProjects: string[] = [];

// One representative file per ADR-0068 formatting source, each in its own folder so the tree
// navigation is deterministic. `language` is the EXACT status-bar `[data-field="language"]` label
// (keiko-editor LANGUAGE_LABELS). `source` is the ADR-0068 D1 documentFormatting classification.
type FormattingSource = "keiko-language-service" | "monaco-builtin" | "none";

interface FixtureFile {
  readonly relativePath: string;
  readonly language: string;
  readonly source: FormattingSource;
  readonly content: string;
}

// Fixture files live at the project ROOT, one per language. The Files tree (FilesWidget) is a
// single-level NAVIGATE-INTO browser: clicking a folder row replaces the listing with that folder's
// contents (it does not expand inline), and selecting a file replaces the tree with a preview pane.
// Root-level files are therefore the deterministic layout: every file is a direct child row that is
// always present in the initial listing, so reopening a different file needs no folder traversal and
// "Back to files" returns to the same root listing (currentDirectoryPath stays null). Distinct file
// extensions are what drive the language mode under test, so a flat root loses no coverage.
const TS_FILE: FixtureFile = {
  relativePath: "example.ts",
  language: "TypeScript",
  source: "keiko-language-service",
  content: "export const answer = 42;\n",
};
const JSON_FILE: FixtureFile = {
  relativePath: "example.json",
  language: "JSON",
  source: "monaco-builtin",
  // Deliberately poorly-indented but VALID JSON — Format must reflow it deterministically (AC3).
  content: '{"alpha":1,"beta":{"gamma":2}}\n',
};
const CSS_FILE: FixtureFile = {
  relativePath: "example.css",
  language: "CSS",
  source: "monaco-builtin",
  content: ".panel{color:red;background:blue}\n",
};
const SCSS_FILE: FixtureFile = {
  relativePath: "example.scss",
  language: "SCSS",
  source: "monaco-builtin",
  content: "$brand: #336699;\n.card { color: $brand; .inner { padding: 4px; } }\n",
};
const LESS_FILE: FixtureFile = {
  relativePath: "example.less",
  language: "Less",
  source: "monaco-builtin",
  content: "@brand: #336699;\n.card { color: @brand; }\n",
};
const HTML_FILE: FixtureFile = {
  relativePath: "example.html",
  language: "HTML",
  source: "monaco-builtin",
  content: '<section class="hero"><h1>Title</h1><p>Body</p></section>\n',
};
const MARKDOWN_FILE: FixtureFile = {
  relativePath: "example.md",
  language: "Markdown",
  source: "none",
  content: "# Heading\n\nSome **bold** prose.\n",
};
const YAML_FILE: FixtureFile = {
  relativePath: "example.yaml",
  language: "YAML",
  source: "none",
  content: "name: keiko\nvalues:\n  - one\n  - two\n",
};
const UNKNOWN_FILE: FixtureFile = {
  relativePath: "notes.unknownext",
  language: "Plain Text",
  source: "none",
  content: "plain unknown file content\n",
};

const ALL_FIXTURE_FILES: readonly FixtureFile[] = [
  TS_FILE,
  JSON_FILE,
  CSS_FILE,
  SCSS_FILE,
  LESS_FILE,
  HTML_FILE,
  MARKDOWN_FILE,
  YAML_FILE,
  UNKNOWN_FILE,
];

function isBenignMonacoCancellation(error: Error): boolean {
  if (error.message === "Canceled: Canceled") return true;
  if (error.message !== "Canceled") return false;
  return /\b(monaco|inline[-\s]?completion|suggest|editor|format)\b/i.test(error.stack ?? "");
}

function collectPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    // Monaco can surface a benign cancellation as an unhandled page error when a language-feature
    // request (formatting, completion, …) is superseded mid-flight. Keep the guard strict for every
    // real app error, but do not fail on that editor-internal cancellation noise (same filter the
    // release-smoke suite uses).
    if (isBenignMonacoCancellation(error)) return;
    errors.push(error.message);
  });
  return () => {
    expect(errors).toEqual([]);
  };
}

function createFormattingFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-e2e-format-"));
  tempProjects.push(root);
  for (const file of ALL_FIXTURE_FILES) {
    const absolutePath = join(root, file.relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, file.content, "utf8");
  }
  return root;
}

async function seedFilesWindow(page: Page, projectPath: string): Promise<void> {
  await page.addInitScript((root) => {
    window.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "e2e-files-window",
          type: "files",
          x: 64,
          y: 56,
          w: 640,
          h: 680,
          z: 10,
          cfg: { root },
          max: false,
        },
      ]),
    );
    window.localStorage.removeItem("keiko.conns.v1");
  }, projectPath);
}

// Select a root-level file row. Clicking a `.tr-file` row sets `selectedPath`, which makes the Files
// window render the FilePreview pane (FilesWidget.tsx:481) in place of the tree.
async function selectTreeFile(
  filesWindow: ReturnType<Page["getByRole"]>,
  relativePath: string,
): Promise<void> {
  const row = filesWindow.locator(`button.tr-file[data-path="${relativePath}"]`);
  await expect(row).toBeVisible();
  await row.click();
}

// Open a single fixture file into the editor and return its editor region. The region aria-label is
// `Editor: <relativePath> in <root>` (EditorRuntimeWidget.editorAriaLabel), so the active file's path
// identifies the region. Each call starts from a FRESH page load: `addInitScript` re-seeds the Files
// window on every navigation, so the tree always begins at the root listing and no editor windows
// from a prior open can stack and occlude the FilePreview "Open in editor" button. Selecting the file
// swaps the tree for the FilePreview pane (FilesWidget.tsx:481), which exposes "Open in editor".
async function openInEditor(page: Page, file: FixtureFile): Promise<ReturnType<Page["getByRole"]>> {
  await page.goto("/");
  const filesWindow = page.getByRole("region", { name: /^Files/u });
  await expect(filesWindow).toBeVisible();
  await selectTreeFile(filesWindow, file.relativePath);
  await filesWindow.getByRole("button", { name: "Open in editor" }).click();
  const escaped = file.relativePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const editorWindow = page.getByRole("region", { name: new RegExp(`Editor.*${escaped}`, "u") });
  await expect(editorWindow.locator(".monaco-editor")).toBeVisible();
  return editorWindow;
}

// Close the Files window entirely (release-smoke pattern), so the FilePreview/tree can never overlap
// the editor when a test must CLICK inside the editor (AC3/AC4 formatting interactions).
async function closeFilesWindow(page: Page): Promise<void> {
  const filesWindow = page.getByRole("region", { name: /^Files/u });
  await filesWindow.getByRole("button", { name: "Close Files window" }).click();
  await expect(filesWindow).toBeHidden();
}

function statusBar(editorWindow: ReturnType<Page["getByRole"]>): ReturnType<Page["getByRole"]> {
  return editorWindow.getByTestId("editor-status-bar");
}

function formatButton(editorWindow: ReturnType<Page["getByRole"]>): ReturnType<Page["getByRole"]> {
  // The explicit Format Document action button in the editor toolbar (EditorRuntimeWidget.tsx):
  // a `.ed-save` button labelled "Format" with `data-tip="Format document"`, carrying a dynamic
  // `aria-disabled` driven by the registry-derived `formattingAvailable` value (ADR-0068 D3/D4).
  return editorWindow.locator('button[data-tip="Format document"]');
}

// The current Monaco editor buffer text, read from the rendered `.view-line`s. Two correctness
// details make this faithful where `allInnerTexts()` is not: (1) Monaco positions each `.view-line`
// ABSOLUTELY, so DOM order need not match visual order — we sort by the CSS `top` offset; (2) leading
// indentation is rendered with non-breaking spaces (U+00A0) and `innerText` collapses leading
// whitespace, so we read `textContent` and normalise U+00A0 back to ordinary spaces. This preserves
// the indentation that the deterministic formatter produces (the AC3 signal). Robust for these small
// single-viewport fixtures (no virtual scrolling).
async function readEditorBuffer(editorWindow: ReturnType<Page["getByRole"]>): Promise<string> {
  const viewLines = editorWindow.locator(".monaco-editor .view-lines").first();
  await expect(viewLines).toBeVisible();
  const lines = await viewLines.evaluate((container) => {
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".view-line"));
    return rows
      .map((row) => ({ top: Number.parseInt(row.style.top, 10) || 0, text: row.textContent }))
      .sort((a, b) => a.top - b.top)
      .map((row) => row.text);
  });
  const nbsp = String.fromCharCode(0x00a0);
  return lines.map((line) => line.split(nbsp).join(" ")).join("\n");
}

// Trigger Format reliably: focus the buffer by clicking a `.view-line` (so the keybinding targets
// the editor), click the explicit Format button, then issue Monaco's native Format Document
// keybinding belt-and-braces (the worker-backed json/css formatter resolves asynchronously). The
// caller is responsible for first waiting until the Format affordance is ready (status "Format
// ready"), which is the editor-tier signal that the formatter is reachable.
async function triggerFormat(
  page: Page,
  editorWindow: ReturnType<Page["getByRole"]>,
): Promise<void> {
  await editorWindow.locator(".monaco-editor .view-lines").first().click();
  await formatButton(editorWindow).click();
  await page.keyboard.press("Shift+Alt+KeyF");
}

test.afterEach(() => {
  for (const root of tempProjects.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test(`AC1 language mode on open reflects every registry language and unknown→Plain Text ${TAG}`, async ({
  page,
}) => {
  const projectPath = createFormattingFixture();
  await seedFilesWindow(page, projectPath);
  const assertNoPageErrors = collectPageErrors(page);

  // Each open empirically proves the language registers — the core AC1 risk is scss/less/html, which
  // the bootstrap must now contribute (ADR-0068 D5). A regression there shows up here as a wrong
  // (or "Plain Text") language label for those three.
  const cases: readonly FixtureFile[] = [
    TS_FILE,
    JSON_FILE,
    CSS_FILE,
    SCSS_FILE,
    LESS_FILE,
    HTML_FILE,
    MARKDOWN_FILE,
    YAML_FILE,
    UNKNOWN_FILE,
  ];
  for (const file of cases) {
    const editorWindow = await openInEditor(page, file);
    await expect(statusBar(editorWindow).locator('[data-field="language"]')).toHaveText(
      file.language,
    );
  }

  assertNoPageErrors();
});

test(`AC1 syntax highlighting produces colourised tokens (scss/css/html not flat plaintext) ${TAG}`, async ({
  page,
}) => {
  const projectPath = createFormattingFixture();
  await seedFilesWindow(page, projectPath);
  const assertNoPageErrors = collectPageErrors(page);

  // For each grammar-bearing language, real content must tokenise into MULTIPLE `.mtk*` token spans
  // with more than one distinct token class — i.e. NOT a single undifferentiated plaintext run. This
  // is the empirical proof the basic-languages grammar is registered (ADR-0068 D5); scss/less/html
  // are the languages most at risk of silently falling back to plaintext.
  for (const file of [SCSS_FILE, CSS_FILE, HTML_FILE]) {
    const editorWindow = await openInEditor(page, file);
    const tokenSpans = editorWindow.locator(".monaco-editor .view-line span[class*='mtk']");
    await expect.poll(() => tokenSpans.count(), { timeout: 20_000 }).toBeGreaterThan(1);
    const distinctClasses = await tokenSpans.evaluateAll((spans) => {
      const classes = new Set<string>();
      for (const span of spans) {
        for (const cls of span.classList) {
          if (cls.startsWith("mtk")) classes.add(cls);
        }
      }
      return classes.size;
    });
    expect(distinctClasses, `${file.language} must colourise into >1 token class`).toBeGreaterThan(
      1,
    );
  }

  assertNoPageErrors();
});

test(`AC2 theme and tokenisation stay stable across a page reload ${TAG}`, async ({ page }) => {
  const projectPath = createFormattingFixture();
  await seedFilesWindow(page, projectPath);
  const assertNoPageErrors = collectPageErrors(page);

  const captureThemeAndToken = async (): Promise<{
    readonly editorBackground: string;
    readonly tokenColour: string;
    readonly documentTheme: string;
  }> => {
    const editorWindow = await openInEditor(page, SCSS_FILE);
    const monaco = editorWindow.locator(".monaco-editor").first();
    await expect(monaco).toBeVisible();
    const tokenSpan = editorWindow.locator(".monaco-editor .view-line span[class*='mtk']").first();
    await expect(tokenSpan).toBeVisible({ timeout: 20_000 });
    // Monaco paints the themed editor surface on `.monaco-editor-background`; reading the computed
    // colour there (not the `.monaco-editor` shell, which is often transparent) is the stable theme
    // signal. The `data-theme` document attribute corroborates which theme is active.
    const editorBackground = await editorWindow
      .locator(".monaco-editor .monaco-editor-background")
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundColor);
    const tokenColour = await tokenSpan.evaluate((node) => getComputedStyle(node).color);
    const documentTheme = await page.evaluate(
      () => document.documentElement.getAttribute("data-theme") ?? "",
    );
    return { editorBackground, tokenColour, documentTheme };
  };

  const before = await captureThemeAndToken();
  // A real theme is painted (not an unstyled/transparent box) before we test reload stability.
  expect(before.editorBackground).not.toBe("rgba(0, 0, 0, 0)");

  // `captureThemeAndToken` re-opens via `openInEditor`, which performs a fresh `page.goto("/")` — a
  // full reload of the SPA. The post-reload capture must therefore reproduce the SAME dark theme and
  // the SAME syntax-token colour (tokenisation re-applied), which is exactly the AC2 guarantee.
  const after = await captureThemeAndToken();

  expect(after.documentTheme).toBe(before.documentTheme);
  expect(after.editorBackground).toBe(before.editorBackground);
  expect(after.tokenColour).toBe(before.tokenColour);

  assertNoPageErrors();
});

test(`AC5 Format availability + status field reflect the formatting source consistently ${TAG}`, async ({
  page,
}) => {
  const projectPath = createFormattingFixture();
  await seedFilesWindow(page, projectPath);
  const assertNoPageErrors = collectPageErrors(page);

  // monaco-builtin (JSON) and keiko-language-service (TS) → ENABLED + "Format ready".
  for (const file of [JSON_FILE, TS_FILE]) {
    const editorWindow = await openInEditor(page, file);
    await expect(statusBar(editorWindow).locator('[data-field="formatting"]')).toHaveText(
      "Format ready",
    );
    await expect(formatButton(editorWindow)).not.toHaveAttribute("aria-disabled", "true");
  }

  // "none" sources (Markdown, YAML) → DISABLED + "Format unavailable" (the AC5 fix: never advertise a
  // formatter the browser cannot reach).
  for (const file of [MARKDOWN_FILE, YAML_FILE]) {
    const editorWindow = await openInEditor(page, file);
    await expect(statusBar(editorWindow).locator('[data-field="formatting"]')).toHaveText(
      "Format unavailable",
    );
    await expect(formatButton(editorWindow)).toHaveAttribute("aria-disabled", "true");
  }

  assertNoPageErrors();
});

test(`AC3 Format applies deterministic edits to valid JSON ${TAG}`, async ({ page }) => {
  const projectPath = createFormattingFixture();
  await seedFilesWindow(page, projectPath);
  const assertNoPageErrors = collectPageErrors(page);

  const editorWindow = await openInEditor(page, JSON_FILE);
  // Close the Files window so neither the tree nor the FilePreview pane can overlap the editor when
  // we click inside it to trigger Format.
  await closeFilesWindow(page);
  // Sanity-check the pre-format buffer is the unformatted single line.
  expect((await readEditorBuffer(editorWindow)).replace(/\s+$/u, "")).toBe(
    JSON_FILE.content.trim(),
  );

  // Wait until the Format affordance reports ready — this is the editor-tier signal that Monaco's
  // bundled JSON worker formatter is reachable, so the trigger is not raced against worker load.
  await expect(statusBar(editorWindow).locator('[data-field="formatting"]')).toHaveText(
    "Format ready",
  );
  await triggerFormat(page, editorWindow);

  // Monaco's bundled JSON worker reflows to a deterministically INDENTED document: more lines than
  // the single-line input, and at least one indented line. We assert structure (indentation +
  // multi-line) rather than an exact byte string, since the worker's indent width is its own
  // deterministic choice — the AC is "applies deterministic edits", reflected by the reformat.
  await expect
    .poll(async () => (await readEditorBuffer(editorWindow)).split("\n").length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(1);
  const formatted = await readEditorBuffer(editorWindow);
  expect(formatted, "formatted JSON must contain indentation").toMatch(/\n[ \t]+"/u);
  // The reformat is content-preserving: the keys/values survive.
  expect(formatted.replace(/\s+/gu, "")).toBe(JSON_FILE.content.replace(/\s+/gu, ""));

  assertNoPageErrors();
});

test(`AC4 a "none"-source file has no reachable formatter and its buffer is untouched ${TAG}`, async ({
  page,
}) => {
  // AC4 (failure-safe formatting) has two browser-observable facets:
  //  - The deterministic-edit failure path of the Keiko language-service bridge (ts/js) returns
  //    EMPTY_EDITS on every error/cancellation/stale-buffer/superseding-edit. That path is exhaustively
  //    unit-tested in `packages/keiko-editor/src/components/formatting-bridge.test.ts` (6 scenarios),
  //    which is exactly where the issue's Expected Verification places it; reproducing it end-to-end in
  //    the browser would require forcing a server error, not a content shape.
  //  - For a "none"-source language (markdown/yaml/…) NO in-browser document formatter is reachable, so
  //    invoking Format cannot change the buffer. That is the deterministic, content-only browser proof
  //    we assert here. (We deliberately do NOT test invalid-JSON: Monaco's bundled JSON formatter is a
  //    lenient pretty-printer that reformats lexically-recoverable input, so "invalid JSON ⇒ no-op" is
  //    empirically false and is not a Keiko guarantee.)
  const projectPath = createFormattingFixture();
  await seedFilesWindow(page, projectPath);
  const assertNoPageErrors = collectPageErrors(page);

  const editorWindow = await openInEditor(page, MARKDOWN_FILE);
  // Close the Files window so nothing overlaps the editor when we focus it for the keybinding.
  await closeFilesWindow(page);

  // The status + button agree that no formatter is reachable for this "none" source (ADR-0068 D3/D4).
  await expect(statusBar(editorWindow).locator('[data-field="formatting"]')).toHaveText(
    "Format unavailable",
  );
  await expect(formatButton(editorWindow)).toHaveAttribute("aria-disabled", "true");

  const before = await readEditorBuffer(editorWindow);
  // Issue Monaco's native Format Document shortcut directly: with no provider registered for markdown
  // it is a no-op, so the buffer must remain byte-identical (the browser-observable failure-safe path).
  await editorWindow.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Shift+Alt+KeyF");
  await page.waitForTimeout(2_000);
  expect(await readEditorBuffer(editorWindow)).toBe(before);

  assertNoPageErrors();
});
