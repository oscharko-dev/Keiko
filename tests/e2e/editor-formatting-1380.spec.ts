import { expect, test, type Page } from "@playwright/test";
import type { EditorBuiltinFormattingSource } from "@oscharko-dev/keiko-contracts";
import { editorBuiltinDocumentFormatting } from "@oscharko-dev/keiko-contracts/runtime/editor-builtin-capabilities";
import { inferEditorLanguageModeId } from "@oscharko-dev/keiko-contracts/runtime/editor-language-mode-map";
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
//   AC5 — the Format affordance reflects the registry-derived formatting source consistently:
//         enabled ("Format ready") for keiko-language-service (ts/js) and disabled
//         ("Format unavailable") for release-packaged "none" languages, including json/css.
//   AC3/AC4 — Format applies deterministic edits for TypeScript through the governed language
//         service, while a "none" language leaves the buffer byte-identical.
//
// This is a dedicated, NON-gating coordinator-evidence config (port 32203); the scenarios are tagged
// @formatting-1380 (NOT @smoke) so they can be filtered without joining the gating set.

const TAG = "@formatting-1380";
const tempProjects: string[] = [];
// Inserted as ONE undo unit by AC4 so its "buffer untouched" comparison is made against a live,
// dirty buffer instead of one that could have been silently re-read from disk. Absent from every
// fixture body, so finding it can only mean this test put it there.
const FORMAT_NOOP_WITNESS = "ZZ";

interface FixtureFile {
  readonly relativePath: string;
  readonly language: string;
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
  // Deliberately poorly spaced: the governed TypeScript service must return deterministic edits.
  content: "export const answer   =   42;\n",
};
const JSON_FILE: FixtureFile = {
  relativePath: "example.json",
  language: "JSON",
  content: '{"alpha":1,"beta":{"gamma":2}}\n',
};
const CSS_FILE: FixtureFile = {
  relativePath: "example.css",
  language: "CSS",
  content: ".panel{color:red;background:blue}\n",
};
const SCSS_FILE: FixtureFile = {
  relativePath: "example.scss",
  language: "SCSS",
  content: "$brand: #336699;\n.card { color: $brand; .inner { padding: 4px; } }\n",
};
const LESS_FILE: FixtureFile = {
  relativePath: "example.less",
  language: "Less",
  content: "@brand: #336699;\n.card { color: @brand; }\n",
};
const HTML_FILE: FixtureFile = {
  relativePath: "example.html",
  language: "HTML",
  content: '<section class="hero"><h1>Title</h1><p>Body</p></section>\n',
};
const MARKDOWN_FILE: FixtureFile = {
  relativePath: "example.md",
  language: "Markdown",
  content: "# Heading\n\nSome **bold** prose.\n",
};
const YAML_FILE: FixtureFile = {
  relativePath: "example.yaml",
  language: "YAML",
  content: "name: keiko\nvalues:\n  - one\n  - two\n",
};
const UNKNOWN_FILE: FixtureFile = {
  relativePath: "notes.unknownext",
  language: "Plain Text",
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

function formattingSource(file: FixtureFile): EditorBuiltinFormattingSource {
  const languageId = inferEditorLanguageModeId(file.relativePath);
  return languageId === null ? "none" : editorBuiltinDocumentFormatting(languageId);
}

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
  // Register the fixture root as a project before seeding the window. Without it the root carries no
  // server-validated trust grant, the Files tree lists nothing, and every scenario below fails at
  // "select the fixture file" on a window that never loaded. This mirrors the registration the
  // CI-covered editor suites already do (editor-debugging-2348); no lane runs this suite, so the
  // drift went unnoticed.
  const created = await page.request.post("/api/projects", {
    data: { name: "Issue 1380 formatting", path: projectPath },
    headers: { "x-keiko-csrf": "1" },
  });
  expect(created.ok(), await created.text()).toBe(true);
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
  // Match on the row class only: file rows are rendered as a `div[role="treeitem"]`, not a button
  // (a button owned by role="tree" is an invalid owned child — the aria-required-children fix).
  // The old `button.tr-file` selector matched nothing, so every scenario here failed at file select.
  const row = filesWindow.locator(`.tr-file[data-path="${relativePath}"]`);
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
  // The explicit Format Document action button in the editor toolbar (EditorRuntimeWidget.tsx),
  // carrying a dynamic `aria-disabled` driven by the registry-derived `formattingAvailable` value
  // (ADR-0068 D3/D4). Resolved by accessible name — the same locator the CI-covered editor suites
  // use. The former `data-tip="Format document"` attribute no longer exists, so that selector
  // matched nothing and every Format assertion here failed on a missing element.
  return editorWindow.getByRole("button", { name: "Format", exact: true });
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
// keybinding belt-and-braces. The caller first waits until the Format affordance is ready, which is
// the editor-tier signal that the governed language-service formatter is reachable.
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

test(`AC1 syntax highlighting produces token spans (scss/css/html not flat plaintext) ${TAG}`, async ({
  page,
}) => {
  const projectPath = createFormattingFixture();
  await seedFilesWindow(page, projectPath);
  const assertNoPageErrors = collectPageErrors(page);

  // For each grammar-bearing language, real content must tokenise into MULTIPLE `.mtk*` token spans
  // instead of one undifferentiated plaintext run. Do not require multiple colour classes: the
  // active theme may deliberately map distinct HTML token kinds to the same colour. The separate
  // spans are the stable browser proof that the basic-languages grammar is registered (ADR-0068 D5).
  for (const file of [SCSS_FILE, CSS_FILE, HTML_FILE]) {
    const editorWindow = await openInEditor(page, file);
    const tokenSpans = editorWindow.locator(".monaco-editor .view-line span[class*='mtk']");
    await expect
      .poll(() => tokenSpans.count(), {
        message: `${file.language} must render as multiple grammar token spans`,
        timeout: 20_000,
      })
      .toBeGreaterThan(1);
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

  // Derive the expected source from the production registry. Release packaging deliberately carries
  // no rich Monaco workers, so TypeScript is ready and JSON/CSS/HTML/etc. are unavailable.
  for (const file of ALL_FIXTURE_FILES) {
    const editorWindow = await openInEditor(page, file);
    const available = formattingSource(file) !== "none";
    await expect(statusBar(editorWindow).locator('[data-field="formatting"]')).toHaveText(
      available ? "Format ready" : "Format unavailable",
    );
    await expect(formatButton(editorWindow)).toHaveAttribute(
      "aria-disabled",
      available ? "false" : "true",
    );
  }

  assertNoPageErrors();
});

test(`AC3 Format applies deterministic edits to TypeScript ${TAG}`, async ({ page }) => {
  const projectPath = createFormattingFixture();
  await seedFilesWindow(page, projectPath);
  const assertNoPageErrors = collectPageErrors(page);

  const editorWindow = await openInEditor(page, TS_FILE);
  // Close the Files window so neither the tree nor the FilePreview pane can overlap the editor when
  // we click inside it to trigger Format.
  await closeFilesWindow(page);
  // Sanity-check the pre-format buffer is the unformatted single line.
  expect((await readEditorBuffer(editorWindow)).replace(/\s+$/u, "")).toBe(TS_FILE.content.trim());

  // Wait until the Format affordance reports ready — this is the signal that the governed
  // TypeScript language-service formatter is reachable.
  await expect(statusBar(editorWindow).locator('[data-field="formatting"]')).toHaveText(
    "Format ready",
  );
  await triggerFormat(page, editorWindow);

  await expect
    .poll(async () => readEditorBuffer(editorWindow), {
      timeout: 30_000,
    })
    .not.toContain("   ");
  const formatted = await readEditorBuffer(editorWindow);
  expect(formatted).not.toBe(TS_FILE.content.trim());
  expect(formatted.replace(/\s+/gu, "")).toBe(TS_FILE.content.replace(/\s+/gu, ""));

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
  //  - For a "none"-source language (json/css/markdown/…) NO in-browser document formatter is reachable, so
  //    invoking Format cannot change the buffer. That is the deterministic, content-only browser proof
  //    we assert here. JSON is deliberate: ADR-0042 D3.6 excludes the rich JSON worker from the
  //    release artifact, so advertising or applying its formatter would be packaging drift.
  const projectPath = createFormattingFixture();
  await seedFilesWindow(page, projectPath);
  const assertNoPageErrors = collectPageErrors(page);

  const editorWindow = await openInEditor(page, JSON_FILE);
  // Close the Files window so nothing overlaps the editor when we focus it for the keybinding.
  await closeFilesWindow(page);

  // The status + button agree that no formatter is reachable for this "none" source (ADR-0068 D3/D4).
  await expect(statusBar(editorWindow).locator('[data-field="formatting"]')).toHaveText(
    "Format unavailable",
  );
  await expect(formatButton(editorWindow)).toHaveAttribute("aria-disabled", "true");

  const before = await readEditorBuffer(editorWindow);
  // Issue Monaco's native Format Document shortcut directly: with no provider registered for JSON
  // it is a no-op, so the buffer must remain byte-identical (the browser-observable failure-safe path).
  await editorWindow.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Shift+Alt+KeyF");

  // "The buffer did not change" holds the instant the key goes down, so it says nothing until the
  // formatting opportunity has demonstrably passed. Bound it on observable editor state rather than
  // on a fixed wait.
  const saveField = statusBar(editorWindow).locator('[data-field="save"]');

  // WITNESS — a one-shot edit this test owns, inserted as a single undo unit. It makes the buffer
  // differ from what is on disk, so the comparison at the end cannot be satisfied by a buffer that
  // was quietly re-read from disk rather than kept live: that is the failure mode which would turn
  // this whole assertion into a tautology.
  await page.keyboard.insertText(FORMAT_NOOP_WITNESS);
  await expect(saveField).toHaveText("Unsaved");

  // WINDOW — one complete editor → BFF → editor round trip on this very document: persist the
  // witness and wait for the editor's own save status to settle back to "Saved". Keiko's formatting
  // bridge answers over that same BFF hop (ADR-0068), so a formatter that was going to resolve for
  // this buffer had at least as long as this round trip took. The document is never left, so nothing
  // cancels work already in flight for it — which a tab switch would.
  await editorWindow.getByRole("button", { name: "Save", exact: true }).click();
  await expect(saveField).toHaveText("Saved");

  const after = await readEditorBuffer(editorWindow);
  // The witness is present, so this is the live buffer and not a fresh read of the file …
  expect(after).toContain(FORMAT_NOOP_WITNESS);
  // … and taking the witness back out must leave the pre-Format buffer byte for byte: the ONLY
  // change to this document across the whole window was the one the test made itself. A formatter
  // that had reflowed the JSON would leave its own edits behind here.
  expect(after.replace(FORMAT_NOOP_WITNESS, "")).toBe(before);

  assertNoPageErrors();
});
