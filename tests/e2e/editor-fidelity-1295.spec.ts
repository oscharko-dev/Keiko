import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EVIDENCE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "design-system",
  "evidence",
  "1295",
  "editor",
);

const ARTIFACT_NAMES = [
  "dark-source.png",
  "dark-find.png",
  "dark-split-markdown.png",
  "dark-agent-ghost.png",
  "dark-resize.png",
  "dark-compact-overflow.png",
  "dark-large-buffer.png",
  "light-source.png",
  "light-find.png",
  "light-split-markdown.png",
  "light-agent-ghost.png",
  "high-contrast-source.png",
  "high-contrast-find.png",
  "high-contrast-split-markdown.png",
  "high-contrast-agent-ghost.png",
  "reduced-motion-focus.png",
  "manifest.json",
] as const;

type ArtifactName = (typeof ARTIFACT_NAMES)[number];
type ThemeMode = "dark" | "light" | "high-contrast" | "reduced-motion";

type ThemeScene = "source" | "find" | "agentGhost" | "splitMarkdown";
type EvidenceThemeMode = Extract<ThemeMode, "dark" | "light" | "high-contrast">;
type WindowResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface WorkspaceWindowSeed {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface EditorResizeViewportCase {
  readonly name: string;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
  };
  readonly window: WorkspaceWindowSeed;
}

const THEME_ARTIFACTS: Readonly<
  Record<EvidenceThemeMode, Readonly<Record<ThemeScene, ArtifactName>>>
> = {
  dark: {
    source: "dark-source.png",
    find: "dark-find.png",
    agentGhost: "dark-agent-ghost.png",
    splitMarkdown: "dark-split-markdown.png",
  },
  light: {
    source: "light-source.png",
    find: "light-find.png",
    agentGhost: "light-agent-ghost.png",
    splitMarkdown: "light-split-markdown.png",
  },
  "high-contrast": {
    source: "high-contrast-source.png",
    find: "high-contrast-find.png",
    agentGhost: "high-contrast-agent-ghost.png",
    splitMarkdown: "high-contrast-split-markdown.png",
  },
};

const TOKEN_NAMES = [
  "--ed-bg",
  "--ed-bg-gutter",
  "--ed-fg",
  "--ed-gutter-fg",
  "--ed-selection",
  "--ed-find-match",
  "--ed-find-match-active",
  "--ed-focus",
  "--ed-statusbar-bg",
  "--ed-statusbar-fg",
  "--ed-tab-active-bg",
  "--ed-tab-active-fg",
  "--ed-tab-inactive-fg",
  "--ed-ghost",
  "--ed-syn-keyword",
  "--ed-syn-string",
  "--ed-syn-comment",
  "--ed-syn-function",
  "--ed-syn-type",
] as const;

const EDITOR_RESIZE_OPEN_FILES = [
  "src/App.tsx",
  "README.md",
  "package.json",
  ".editorconfig",
  ".gitattributes",
  "eslint.config.js",
  "LICENSE",
  ".dependency-cruiser.cjs",
] as const;

const EDITOR_RESIZE_VIEWPORTS: readonly EditorResizeViewportCase[] = [
  {
    name: "desktop",
    viewport: { width: 1440, height: 900 },
    window: { x: 40, y: 36, w: 920, h: 620 },
  },
  {
    name: "laptop",
    viewport: { width: 1200, height: 760 },
    window: { x: 36, y: 32, w: 860, h: 580 },
  },
  {
    name: "compact",
    viewport: { width: 1024, height: 680 },
    window: { x: 28, y: 28, w: 760, h: 520 },
  },
  {
    name: "minimum-editor",
    viewport: { width: 760, height: 560 },
    window: { x: 24, y: 28, w: 660, h: 440 },
  },
] as const;

const WINDOW_RESIZE_STEPS: readonly {
  readonly handle: WindowResizeHandle;
  readonly dx: number;
  readonly dy: number;
  readonly label: string;
}[] = [
  { handle: "s", dx: 0, dy: 80, label: "extend down" },
  { handle: "s", dx: 0, dy: -180, label: "shrink height to minimum" },
  { handle: "e", dx: 60, dy: 0, label: "extend right" },
  { handle: "e", dx: -180, dy: 0, label: "shrink width to minimum" },
  { handle: "se", dx: 52, dy: 52, label: "extend southeast" },
  { handle: "nw", dx: 180, dy: 160, label: "shrink from northwest to minimum" },
  { handle: "ne", dx: 60, dy: -40, label: "extend northeast" },
  { handle: "sw", dx: 60, dy: 48, label: "resize southwest" },
  { handle: "n", dx: 0, dy: 48, label: "shrink from north" },
  { handle: "w", dx: 72, dy: 0, label: "shrink from west" },
] as const;

interface ThemeEvidence {
  readonly mode: ThemeMode;
  readonly dataTheme: string | null;
  readonly dataHc: string | null;
  readonly tokens: Record<string, string>;
  readonly monaco: Record<string, string>;
  readonly screenshots: readonly ArtifactName[];
}

interface ThemeSceneEvidence {
  readonly editorWindow: Locator;
  readonly evidence: ThemeEvidence;
}

interface EvidenceManifest {
  readonly issue: "#1295";
  readonly harness: "playwright.issue-1295-editor-fidelity.config.ts";
  readonly route: "/";
  readonly appPath: "packaged-cli-ui";
  readonly workspace: "synthetic-temp-project";
  readonly generatedAt: string;
  readonly themes: readonly ThemeEvidence[];
  readonly notes: readonly string[];
  readonly assertions: Record<string, boolean | number>;
  readonly artifacts: readonly ArtifactName[];
}

const tempProjects: string[] = [];

function isBenignMonacoCancellation(error: Error): boolean {
  if (error.message === "Canceled: Canceled") return true;
  if (error.message !== "Canceled") return false;
  return /\b(monaco|inline[-\s]?completion|suggest|editor)\b/iu.test(error.stack ?? "");
}

function collectPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    if (isBenignMonacoCancellation(error)) return;
    errors.push(error.message.slice(0, 160));
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text().slice(0, 160);
    if (/^\[vite\]/iu.test(text) || isBenignMonacoCancellation(new Error(text))) return;
    errors.push(text);
  });
  return () => {
    expect(errors).toEqual([]);
  };
}

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #1295 editor evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!ARTIFACT_NAMES.includes(name)) {
    throw new Error("Unexpected Issue #1295 editor evidence artifact");
  }
  const resolved = resolve(EVIDENCE_DIR, name);
  const rel = relative(EVIDENCE_DIR, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Issue #1295 editor evidence artifact escaped its directory");
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Issue #1295 editor evidence artifact path is a symlink");
  }
  return resolved;
}

function writeSourceFixture(root: string): void {
  writeFileSync(
    join(root, "src", "App.tsx"),
    [
      "import { useMemo, useState } from 'react';",
      "",
      "export const topEdgeHoverProbe =",
      "  missingEditorTopEdgeHoverSymbolThatMustOpenDownward;",
      "",
      "type AgentState = 'idle' | 'drafting' | 'reviewing';",
      "",
      "export function WorkspaceEditorPanel() {",
      "  const [agentState, setAgentState] = useState<AgentState>('drafting');",
      "  const summary = useMemo(() => ({ files: 3, markers: ['review', 'syntax'] }), []);",
      "",
      "  return (",
      '    <section aria-label="Keiko editor fidelity fixture">',
      "      <h1>Running editor fidelity</h1>",
      "      <p>{agentState} with {summary.files} files and {summary.markers.join(', ')}</p>",
      "      <button onClick={() => setAgentState('reviewing')}>Review state</button>",
      "    </section>",
      "  );",
      "}",
      "",
      "export const markerCount: number = 'intentional diagnostic';",
      "export const responsiveHoverProbe =",
      "  missingEnterpriseEditorTooltipRegressionSymbolThatMustWrapInsideTheEditorPane;",
      "",
    ].join("\n"),
    "utf8",
  );
}

function writeMarkdownFixture(root: string): void {
  writeFileSync(
    join(root, "README.md"),
    [
      "# Editor Fidelity Fixture",
      "",
      "- Markdown preview content",
      "- Running editor state",
      "",
      "```ts",
      "export const markdownCode = true;",
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
}

function writePackageFixture(root: string): void {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "keiko-editor-fidelity-fixture",
        type: "module",
        dependencies: { react: "latest" },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function writeLargeFixture(root: string): void {
  const largeLines = Array.from(
    { length: 10_050 },
    (_unused, index) => `export const generatedLine${String(index)} = ${String(index)};`,
  );
  writeFileSync(join(root, "src", "large.ts"), `${largeLines.join("\n")}\n`, "utf8");
}

function writeRootOverflowFixtures(root: string): void {
  writeFileSync(join(root, ".editorconfig"), "root = true\n[*]\nend_of_line = lf\n", "utf8");
  writeFileSync(join(root, ".gitattributes"), "* text=auto\n", "utf8");
  writeFileSync(
    join(root, "eslint.config.js"),
    "export default [{ rules: { semi: ['error', 'always'] } }];\n",
    "utf8",
  );
  writeFileSync(join(root, "LICENSE"), "MIT License\n", "utf8");
  writeFileSync(
    join(root, ".dependency-cruiser.cjs"),
    "module.exports = { forbidden: [], options: {} };\n",
    "utf8",
  );
}

function createProjectFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-1295-editor-"));
  tempProjects.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeSourceFixture(root);
  writeMarkdownFixture(root);
  writePackageFixture(root);
  writeLargeFixture(root);
  writeRootOverflowFixtures(root);
  return root;
}

async function replaceMonacoText(page: Page, editorWindow: Locator, text: string): Promise<void> {
  const editor = editorWindow.locator(".monaco-editor").first();
  await expect(editor).toBeVisible();
  await editor.click();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.keyboard.press("KeyA");
  await page.keyboard.up(modifier);
  await page.keyboard.insertText(text);
}

async function stubInlineCompletionRoutes(page: Page): Promise<{
  readonly inlineRequests: unknown[];
  readonly telemetryReports: unknown[];
}> {
  const inlineRequests: unknown[] = [];
  const telemetryReports: unknown[] = [];
  await page.route("**/api/editor/inline-completion", async (route) => {
    inlineRequests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        items: [{ insertText: "urn 42;" }],
        provenance: {
          sources: ["model-assisted"],
          modelMode: "as-you-type",
          modelId: "issue-1295-inline-fim",
          latencyClass: "fast",
          gatewayPolicyVersion: "editor-inline-completion/1",
          promptHash: "b".repeat(64),
        },
      }),
    });
  });
  await page.route("**/api/editor/inline-completion/telemetry", async (route) => {
    telemetryReports.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  return { inlineRequests, telemetryReports };
}

async function seedFilesWindow(page: Page, projectPath: string, mode: ThemeMode): Promise<void> {
  await page.addInitScript(
    ({ root, themeMode }) => {
      const theme = themeMode === "light" ? "light" : "dark";
      window.localStorage.setItem("keiko.theme", theme);
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: `issue-1295-editor-${themeMode}`,
            type: "files",
            x: 32,
            y: 32,
            w: 620,
            h: 640,
            z: 10,
            cfg: {
              root,
            },
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { root: projectPath, themeMode: mode },
  );
}

async function seedEditorWindow(
  page: Page,
  projectPath: string,
  mode: ThemeMode,
  seed: WorkspaceWindowSeed,
): Promise<void> {
  await page.addInitScript(
    ({ root, themeMode, windowSeed, openFiles }) => {
      const theme = themeMode === "light" ? "light" : "dark";
      window.localStorage.setItem("keiko.theme", theme);
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: `issue-1424-editor-resize-${themeMode}`,
            type: "editor",
            x: windowSeed.x,
            y: windowSeed.y,
            w: windowSeed.w,
            h: windowSeed.h,
            z: 10,
            cfg: {
              root,
              file: "src/App.tsx",
              openFiles,
            },
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    {
      root: projectPath,
      themeMode: mode,
      windowSeed: seed,
      openFiles: [...EDITOR_RESIZE_OPEN_FILES],
    },
  );
}

async function openTreePath(container: Locator, path: string): Promise<void> {
  const row = container.locator(`button.tr-row[data-path="${path}"]`);
  await expect(row).toBeVisible();
  await row.click();
}

async function openEditor(page: Page, projectPath: string, mode: ThemeMode): Promise<Locator> {
  await page.emulateMedia({
    contrast: mode === "high-contrast" ? "more" : "no-preference",
    reducedMotion: mode === "reduced-motion" ? "reduce" : "no-preference",
  });
  await seedFilesWindow(page, projectPath, mode);
  await page.goto("/");
  const filesWindow = page.getByRole("region", { name: /^Files/u });
  await expect(filesWindow).toBeVisible();
  await openTreePath(filesWindow, "src");
  await openTreePath(filesWindow, "src/App.tsx");
  await filesWindow.getByRole("button", { name: "Open in editor" }).click();
  const editorRegion = page.getByRole("region", { name: /Editor.*src\/App\.tsx/u });
  await expect(editorRegion).toBeVisible();
  await filesWindow.getByRole("button", { name: "Close Files window" }).click();
  await expect(filesWindow).toBeHidden();
  const editorWindow = page
    .locator(".window[data-window-id]")
    .filter({ has: page.locator(".editor-workspace") })
    .first();
  await expect(editorWindow.locator(".monaco-editor")).toBeVisible();
  await expect(
    editorWindow.locator(".view-line").filter({ hasText: "AgentState" }).first(),
  ).toBeVisible();
  await expect(editorWindow.getByRole("tab", { name: /src\/App\.tsx/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(editorWindow.getByTestId("editor-status-bar")).toBeVisible();
  return editorWindow;
}

async function openSeededEditor(
  page: Page,
  projectPath: string,
  viewportCase: EditorResizeViewportCase,
): Promise<Locator> {
  await page.setViewportSize(viewportCase.viewport);
  await page.emulateMedia({ contrast: "no-preference", reducedMotion: "no-preference" });
  await seedEditorWindow(page, projectPath, "dark", viewportCase.window);
  await page.goto("/");
  const editorWindow = page
    .locator(".window[data-window-id]")
    .filter({ has: page.locator(".editor-workspace") })
    .first();
  await assertEditorUsable(editorWindow);
  return editorWindow;
}

async function waitForAnimationFrames(page: Page, frames = 2): Promise<void> {
  for (let index = 0; index < frames; index += 1) {
    await page.evaluate(
      () =>
        new Promise<void>((resolvePromise) => {
          window.requestAnimationFrame(() => {
            resolvePromise();
          });
        }),
    );
  }
}

async function dragLocator(
  page: Page,
  locator: Locator,
  dx: number,
  dy: number,
  steps = 8,
): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) throw new Error("Expected draggable target to have a bounding box");
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps });
  await page.mouse.up();
  await waitForAnimationFrames(page);
}

async function assertEditorUsable(editorWindow: Locator): Promise<void> {
  await expect(editorWindow.locator(".editor-workspace")).toBeVisible();
  await expect(editorWindow.locator(".monaco-editor").first()).toBeVisible();
  await expect(editorWindow.getByTestId("editor-status-bar").first()).toBeVisible();
}

async function capture(editorWindow: Locator, name: ArtifactName): Promise<ArtifactName> {
  await editorWindow.screenshot({ path: artifactPath(name) });
  return name;
}

async function computedTokenEvidence(page: Page): Promise<ThemeEvidence["tokens"]> {
  const tokens = await page.evaluate(
    (names) => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
    },
    [...TOKEN_NAMES],
  );
  for (const [name, value] of Object.entries(tokens)) {
    expect(value, `${name} should resolve on the running editor host`).not.toBe("");
  }
  return tokens;
}

async function computedMonacoEvidence(editorWindow: Locator): Promise<Record<string, string>> {
  const values = await editorWindow
    .locator(".monaco-editor")
    .first()
    .evaluate((editor) => {
      const root = getComputedStyle(editor as HTMLElement);
      const line = editor.querySelector(".view-line");
      const gutter = editor.querySelector(".margin");
      const activeLine = editor.querySelector(".current-line");
      return {
        backgroundColor: root.backgroundColor,
        color: root.color,
        lineColor:
          line instanceof HTMLElement ? getComputedStyle(line).color : "missing-line-color",
        gutterBackground:
          gutter instanceof HTMLElement
            ? getComputedStyle(gutter).backgroundColor
            : "missing-gutter-background",
        activeLineBackground:
          activeLine instanceof HTMLElement
            ? getComputedStyle(activeLine).backgroundColor
            : "missing-active-line-background",
      };
    });
  for (const [name, value] of Object.entries(values)) {
    expect(value, `Monaco ${name} should be available`).not.toMatch(/^missing/u);
    expect(value, `Monaco ${name} should be non-empty`).not.toBe("");
  }
  return values;
}

async function openEmbeddedPath(editorWindow: Locator, path: string): Promise<void> {
  let current = "";
  for (const part of path.split("/")) {
    current = current.length === 0 ? part : `${current}/${part}`;
    const row = editorWindow.locator(`button.tr-row[data-path="${current}"]`);
    await expect(row).toBeVisible();
    await row.click();
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireTrimmedText(value: string | null, message: string): string {
  if (value === null) {
    throw new Error(message);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error(message);
  }
  return trimmed;
}

async function assertMonacoHoverCopyAffordance(
  page: Page,
  viewportCase: EditorResizeViewportCase,
): Promise<void> {
  const copyButton = page
    .locator(
      ".monaco-resizable-hover .hover-copy-button, .monaco-editor .monaco-hover .hover-copy-button",
    )
    .first();
  await expect(copyButton).toBeVisible();

  const restingStyles = await copyButton.evaluate((buttonElement) => {
    const button = buttonElement as HTMLElement;
    const icon = button.matches(".codicon") ? button : button.querySelector(".codicon");
    const buttonStyle = getComputedStyle(button);
    return {
      backgroundColor: buttonStyle.backgroundColor,
      borderRadius: buttonStyle.borderRadius,
      borderStyle: buttonStyle.borderStyle,
      boxShadow: buttonStyle.boxShadow,
      color: buttonStyle.color,
      cursor: buttonStyle.cursor,
      iconColor: icon instanceof HTMLElement ? getComputedStyle(icon).color : "",
      opacity: buttonStyle.opacity,
    };
  });
  expect(
    restingStyles.opacity,
    `Copy button should stay discoverable in ${viewportCase.name}`,
  ).toBe("1");
  expect(restingStyles.borderStyle).not.toBe("none");
  expect(restingStyles.borderRadius).not.toBe("0px");
  expect(restingStyles.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(restingStyles.boxShadow).toBe("none");
  expect(restingStyles.iconColor).toBe(restingStyles.color);

  await copyButton.hover({ force: true });
  const hoverStyles = await copyButton.evaluate((buttonElement) => {
    const style = getComputedStyle(buttonElement as HTMLElement);
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
      color: style.color,
    };
  });
  expect(
    hoverStyles.boxShadow,
    `Copy button hover should expose neutral Keiko feedback in ${viewportCase.name}`,
  ).not.toBe("none");
  expect(hoverStyles.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

  const copyTooltip = page.locator(".monaco-hover.workbench-hover").filter({ hasText: /^Copy$/u });
  await expect(copyTooltip.last()).toBeVisible();
  const tooltipStyles = await copyTooltip.last().evaluate((tooltipElement) => {
    const style = getComputedStyle(tooltipElement as HTMLElement);
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      borderStyle: style.borderStyle,
      boxShadow: style.boxShadow,
      color: style.color,
      width: (tooltipElement as HTMLElement).getBoundingClientRect().width,
    };
  });
  expect(tooltipStyles.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(tooltipStyles.borderStyle).not.toBe("none");
  expect(tooltipStyles.borderRadius).not.toBe("0px");
  expect(tooltipStyles.boxShadow).not.toBe("none");
  expect(tooltipStyles.color).not.toBe("");
  expect(
    tooltipStyles.width,
    `Copy tooltip should stay compact in ${viewportCase.name}`,
  ).toBeLessThanOrEqual(220);

  await page.mouse.down();
  const activeTransform = await copyButton.evaluate(
    (buttonElement) => getComputedStyle(buttonElement as HTMLElement).transform,
  );
  await page.mouse.move(0, 0);
  await page.mouse.up();
  expect(
    activeTransform,
    `Copy button active state should visibly respond in ${viewportCase.name}`,
  ).not.toBe("none");
}

async function exerciseResponsiveDiagnosticHover(
  page: Page,
  editorWindow: Locator,
  viewportCase: EditorResizeViewportCase,
  needle: string,
  shouldOpenBelowLine = false,
): Promise<void> {
  const host = editorWindow.locator(".ed-host").first();
  const diagnosticLine = editorWindow.locator(".view-line").filter({ hasText: needle }).first();
  if (!(await diagnosticLine.isVisible({ timeout: 2_000 }).catch(() => false))) {
    await editorWindow.locator(".monaco-editor").first().click();
    await page.keyboard.press("Control+F");
    if (
      !(await page
        .locator(".find-widget")
        .isVisible({ timeout: 1_000 })
        .catch(() => false))
    ) {
      await page.keyboard.press("Meta+F");
    }
    await page.keyboard.insertText(needle);
    await expect(diagnosticLine).toBeVisible();
    await page.keyboard.press("Escape");
    await waitForAnimationFrames(page);
  }
  await expect(diagnosticLine).toBeVisible();
  await expect(
    editorWindow
      .getByRole("status")
      .filter({ hasText: /Problems: [1-9]\d* errors/u })
      .first(),
  ).toBeVisible({ timeout: 60_000 });

  const hoverFrame = page
    .locator(".monaco-resizable-hover:has(.monaco-hover), .monaco-hover")
    .first();
  const diagnosticLineBox = await diagnosticLine.boundingBox();
  expect(
    diagnosticLineBox,
    `Diagnostic probe line should be measurable in ${viewportCase.name}`,
  ).not.toBeNull();
  if (diagnosticLineBox === null) {
    throw new Error("Expected diagnostic probe line to have a bounding box");
  }
  const hoverY = diagnosticLineBox.y + diagnosticLineBox.height / 2;
  for (const xOffset of [84, 132, 184, 236]) {
    await page.mouse.move(
      diagnosticLineBox.x + Math.min(xOffset, Math.max(8, diagnosticLineBox.width - 8)),
      hoverY,
    );
    if (await hoverFrame.isVisible({ timeout: 1_000 }).catch(() => false)) {
      break;
    }
  }
  await expect(hoverFrame).toBeVisible();
  await expect(hoverFrame).toContainText(new RegExp(escapeRegExp(needle), "u"));

  const hoverBox = await hoverFrame.boundingBox();
  const hostBox = await host.boundingBox();
  expect(hoverBox, `Diagnostic hover should be measurable in ${viewportCase.name}`).not.toBeNull();
  expect(hostBox, `Editor host should be measurable in ${viewportCase.name}`).not.toBeNull();
  if (hoverBox === null || hostBox === null) {
    throw new Error("Expected diagnostic hover and editor host to have bounding boxes");
  }

  const maxAllowedWidth =
    viewportCase.viewport.width <= 800
      ? Math.min(280, viewportCase.viewport.width - 128, Math.max(0, hostBox.width - 24))
      : Math.min(520, viewportCase.viewport.width - 24, Math.max(0, hostBox.width - 24));
  expect(
    hoverBox.width,
    `Diagnostic hover width should be capped in ${viewportCase.name}`,
  ).toBeLessThanOrEqual(maxAllowedWidth + 1);
  expect(
    hoverBox.x,
    `Diagnostic hover should not clip left in ${viewportCase.name}`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    hoverBox.y,
    `Diagnostic hover should not clip top in ${viewportCase.name}`,
  ).toBeGreaterThanOrEqual(hostBox.y);
  if (shouldOpenBelowLine) {
    expect(
      hoverBox.y,
      `Top-edge diagnostic hover should open below the line in ${viewportCase.name}`,
    ).toBeGreaterThanOrEqual(diagnosticLineBox.y + diagnosticLineBox.height - 2);
  }
  expect(
    hoverBox.x + hoverBox.width,
    `Diagnostic hover should remain inside the viewport in ${viewportCase.name}`,
  ).toBeLessThanOrEqual(viewportCase.viewport.width + 1);
  expect(
    hoverBox.y + hoverBox.height,
    `Diagnostic hover should remain inside the viewport vertically in ${viewportCase.name}`,
  ).toBeLessThanOrEqual(viewportCase.viewport.height + 1);

  const hoverStyles = await hoverFrame.evaluate((frameElement) => {
    const frame = frameElement as HTMLElement;
    const hover = frame.classList.contains("monaco-hover")
      ? frame
      : frame.querySelector(".monaco-hover");
    if (!(hover instanceof HTMLElement)) {
      throw new Error("Expected Monaco hover content inside hover frame");
    }
    const content =
      hover.querySelector(
        ".hover-contents, .monaco-hover-content, .hover-row-contents, .rendered-markdown",
      ) ?? hover;
    const actions = hover.querySelector(".hover-row .actions");
    const frameStyle = getComputedStyle(frame);
    const hoverStyle = getComputedStyle(hover);
    const contentStyle = getComputedStyle(content as HTMLElement);
    return {
      contentOverflowWrap: contentStyle.overflowWrap,
      contentWhiteSpace: contentStyle.whiteSpace,
      frameBorderRadius: frameStyle.borderRadius,
      frameBoxShadow: frameStyle.boxShadow,
      frameOverflowX: frameStyle.overflowX,
      hoverBackground: hoverStyle.backgroundColor,
      hoverColor: hoverStyle.color,
      actionsFlexWrap:
        actions instanceof HTMLElement ? getComputedStyle(actions).flexWrap : "missing",
    };
  });
  expect(hoverStyles.frameBorderRadius).not.toBe("0px");
  expect(hoverStyles.frameBoxShadow).not.toBe("none");
  expect(hoverStyles.frameOverflowX).toBe("hidden");
  expect(hoverStyles.hoverBackground).not.toBe("rgba(0, 0, 0, 0)");
  expect(hoverStyles.hoverColor).not.toBe("");
  expect(["normal", "pre-wrap"]).toContain(hoverStyles.contentWhiteSpace);
  expect(hoverStyles.contentOverflowWrap).toBe("anywhere");
  if (hoverStyles.actionsFlexWrap !== "missing") {
    expect(hoverStyles.actionsFlexWrap).toBe("wrap");
  }
  await assertMonacoHoverCopyAffordance(page, viewportCase);

  await page.keyboard.press("Escape");
  await waitForAnimationFrames(page);
}

async function triggerFindWidget(page: Page, editorWindow: Locator): Promise<void> {
  await editorWindow.locator(".monaco-editor").first().click();
  await page.keyboard.press("Control+F");
  if (
    !(await page
      .locator(".find-widget")
      .isVisible({ timeout: 1_000 })
      .catch(() => false))
  ) {
    await page.keyboard.press("Meta+F");
  }
  await page.keyboard.type("agentState");
  await expect(page.locator(".find-widget")).toBeVisible();
  await expect(page.locator(".findMatch").first()).toBeVisible();
}

async function makeSplitPane(editorWindow: Locator): Promise<void> {
  const splitRight = editorWindow.getByRole("button", { name: "Split src/App.tsx right" });
  await expect(splitRight).toHaveAttribute("data-tip", "Split right");
  await splitRight.click();
  await expect(editorWindow.getByRole("button", { name: "Resize editor split" })).toBeVisible();
  await openEmbeddedPath(editorWindow, "README.md");
  await expect(editorWindow.getByRole("tab", { name: /README\.md/u })).toBeVisible();
  await expect(editorWindow.locator(".ed-pane")).toHaveCount(2);
  await expect(editorWindow.locator(".ed-pane-resizer")).toBeVisible();
}

async function exerciseCompactOverflow(editorWindow: Locator): Promise<void> {
  const overflowFiles = [
    ".editorconfig",
    ".gitattributes",
    "eslint.config.js",
    "LICENSE",
    ".dependency-cruiser.cjs",
  ];
  for (const path of overflowFiles) {
    await openEmbeddedPath(editorWindow, path);
  }
  const summaryMenu = editorWindow.locator("details.ed-tab-summary-menu");
  const summary = summaryMenu.locator("summary.ed-tab-summary");
  await expect(summary).toBeVisible();
  await summary.hover();
  await expect(summary).toHaveAttribute("data-tip", /.+/u);
  await summary.click();
  await expect(summaryMenu).toHaveAttribute("open", "");
  const summaryPanel = summaryMenu.locator(".ed-tab-summary-panel");
  await expect(summaryPanel).toBeVisible();
  const hiddenItems = summaryPanel.locator(".ed-tab-summary-item");
  const hiddenCount = await hiddenItems.count();
  expect(hiddenCount).toBeGreaterThan(0);
  await expect(hiddenItems.first()).toBeVisible();
  const firstHiddenName = requireTrimmedText(
    await hiddenItems.first().locator(".ed-tab-summary-label").textContent(),
    "Expected the first hidden tab label to be present",
  );
  await expect(summary).toHaveAttribute(
    "data-tip",
    new RegExp(`^${escapeRegExp(firstHiddenName)}`, "u"),
  );
  await editorWindow.screenshot({ path: artifactPath("dark-compact-overflow.png") });
  const editorConfigItem = hiddenItems.filter({ hasText: ".editorconfig" }).first();
  const selectedHiddenItem =
    (await editorConfigItem.count()) > 0 ? editorConfigItem : hiddenItems.first();
  const selectedHiddenName = requireTrimmedText(
    await selectedHiddenItem.locator(".ed-tab-summary-label").textContent(),
    "Expected a hidden tab label to be present",
  );
  await selectedHiddenItem.click();
  const selectedTab = editorWindow
    .getByRole("tab", {
      name: new RegExp(escapeRegExp(selectedHiddenName), "u"),
    })
    .first();
  await expect(selectedTab).toBeVisible();
  await expect(selectedTab).toHaveAttribute("aria-selected", "true");
}

async function captureThemeScenes(
  page: Page,
  projectPath: string,
  mode: EvidenceThemeMode,
): Promise<ThemeSceneEvidence> {
  const editorWindow = await openEditor(page, projectPath, mode);
  const tokens = await computedTokenEvidence(page);
  const monaco = await computedMonacoEvidence(editorWindow);
  const screenshots: ArtifactName[] = [];
  const names = THEME_ARTIFACTS[mode];

  screenshots.push(await capture(editorWindow, names.source));
  await triggerFindWidget(page, editorWindow);
  screenshots.push(await capture(editorWindow, names.find));
  await page.keyboard.press("Escape");

  await replaceMonacoText(page, editorWindow, "export function answer() {\n  ret");
  await expect(page.getByRole("alert").filter({ hasText: "urn 42;" }).first()).toBeVisible();
  screenshots.push(await capture(editorWindow, names.agentGhost));

  await makeSplitPane(editorWindow);
  await editorWindow.getByRole("button", { name: "Resize editor split" }).hover();
  screenshots.push(await capture(editorWindow, names.splitMarkdown));

  return {
    editorWindow,
    evidence: {
      mode,
      dataTheme: mode === "light" ? "light" : "dark",
      dataHc: mode === "high-contrast" ? "more" : null,
      tokens,
      monaco,
      screenshots,
    },
  };
}

async function exerciseResize(editorWindow: Locator): Promise<void> {
  const resizer = editorWindow.getByRole("button", { name: "Resize editor split" });
  await expect(resizer).toHaveAttribute("data-tip", "Resize editor split");
  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    await resizer.hover();
    await editorWindow.page().mouse.down();
    await editorWindow.page().mouse.move(box.x + 72, box.y + box.height / 2);
    await editorWindow.page().mouse.up();
    await resizer.hover();
  }
  await expect(editorWindow.locator(".ed-pane")).toHaveCount(2);
}

async function exerciseWindowResizeMatrix(page: Page, editorWindow: Locator): Promise<void> {
  for (const step of WINDOW_RESIZE_STEPS) {
    await dragLocator(page, editorWindow.locator(`.wz-${step.handle}`), step.dx, step.dy);
    await assertEditorUsable(editorWindow);
    const box = await editorWindow.boundingBox();
    expect(box, `Editor window should remain measurable after ${step.label}`).not.toBeNull();
    if (box !== null) {
      expect(
        box.width,
        `Editor window should respect minimum width after ${step.label}`,
      ).toBeGreaterThanOrEqual(619);
      expect(
        box.height,
        `Editor window should respect minimum height after ${step.label}`,
      ).toBeGreaterThanOrEqual(379);
    }
  }
}

async function exerciseEditorInternalSizingMatrix(
  page: Page,
  editorWindow: Locator,
): Promise<void> {
  await makeSplitPane(editorWindow);

  const splitResizer = editorWindow.getByRole("button", { name: "Resize editor split" }).first();
  await dragLocator(page, splitResizer, 90, 0);
  await dragLocator(page, splitResizer, -180, 0);
  await splitResizer.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowLeft");
  await waitForAnimationFrames(page);
  await expect(editorWindow.locator(".ed-pane")).toHaveCount(2);

  const sidebarResizer = editorWindow.getByRole("button", { name: "Resize project tree" }).first();
  await dragLocator(page, sidebarResizer, 80, 0);
  await dragLocator(page, sidebarResizer, -180, 0);
  await sidebarResizer.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowLeft");
  await waitForAnimationFrames(page);
  await assertEditorUsable(editorWindow);
}

async function exerciseCompactTabChooser(editorWindow: Locator): Promise<void> {
  const summary = editorWindow.locator("summary.ed-tab-summary").first();
  await expect(summary).toBeVisible();
  await summary.hover();
  await expect(summary).toHaveAttribute("data-tip", /.+/u);
  await summary.click();

  const summaryPanel = editorWindow.locator(".ed-tab-summary-panel").first();
  await expect(summaryPanel).toBeVisible();
  const hiddenItems = summaryPanel.locator(".ed-tab-summary-item");
  expect(await hiddenItems.count()).toBeGreaterThan(0);
  await hiddenItems.first().click();
  await assertEditorUsable(editorWindow);
}

async function openLargeBuffer(editorWindow: Locator): Promise<void> {
  await openEmbeddedPath(editorWindow, "src/large.ts");
  await expect(editorWindow.getByRole("tab", { name: /src\/large\.ts/u })).toBeVisible();
  await expect(
    editorWindow
      .locator('[data-field="large-file"]')
      .filter({ hasText: "Large file mode" })
      .first(),
  ).toBeVisible();
  await expect(
    editorWindow
      .locator('[data-field="completions"]')
      .filter({ hasText: "Completions off" })
      .first(),
  ).toBeVisible();
}

async function capturePrimaryThemeEvidence(
  page: Page,
  projectPath: string,
): Promise<{
  readonly themes: ThemeEvidence[];
  readonly artifacts: ArtifactName[];
  readonly darkEditorWindow: Locator;
}> {
  const themes: ThemeEvidence[] = [];
  const artifacts: ArtifactName[] = [];
  const dark = await captureThemeScenes(page, projectPath, "dark");
  themes.push(dark.evidence);
  artifacts.push(...dark.evidence.screenshots);

  await exerciseResize(dark.editorWindow);
  artifacts.push(await capture(dark.editorWindow, "dark-resize.png"));
  await exerciseCompactOverflow(dark.editorWindow);
  artifacts.push("dark-compact-overflow.png");
  await openLargeBuffer(dark.editorWindow);
  artifacts.push(await capture(dark.editorWindow, "dark-large-buffer.png"));

  const light = await captureThemeScenes(page, projectPath, "light");
  themes.push(light.evidence);
  artifacts.push(...light.evidence.screenshots);

  const highContrast = await captureThemeScenes(page, projectPath, "high-contrast");
  themes.push(highContrast.evidence);
  artifacts.push(...highContrast.evidence.screenshots);
  return { themes, artifacts, darkEditorWindow: dark.editorWindow };
}

async function captureReducedMotionEvidence(
  page: Page,
  projectPath: string,
): Promise<ThemeEvidence> {
  const editorWindow = await openEditor(page, projectPath, "reduced-motion");
  await editorWindow.locator(".monaco-editor").first().click();
  await expect(editorWindow.locator(".monaco-editor.focused").first()).toBeVisible();
  return {
    mode: "reduced-motion",
    dataTheme: "dark",
    dataHc: null,
    tokens: await computedTokenEvidence(page),
    monaco: await computedMonacoEvidence(editorWindow),
    screenshots: [await capture(editorWindow, "reduced-motion-focus.png")],
  };
}

async function buildManifest(
  editorWindow: Locator,
  themes: readonly ThemeEvidence[],
  artifacts: readonly ArtifactName[],
  inlineCompletion: {
    readonly inlineRequests: readonly unknown[];
    readonly telemetryReports: readonly unknown[];
  },
): Promise<EvidenceManifest> {
  return {
    issue: "#1295",
    harness: "playwright.issue-1295-editor-fidelity.config.ts",
    route: "/",
    appPath: "packaged-cli-ui",
    workspace: "synthetic-temp-project",
    generatedAt: new Date().toISOString(),
    themes,
    notes: [
      "Corrective #1295 evidence only; full editor visual-regression baseline remains in #1300.",
      "The agent-adjacent scene uses the shipped inline-completion ghost-text UI. Formal agent state matrices remain in #1296/#1300 where not implemented.",
      "Dark-theme overflow evidence captures the compact hidden-tab chooser and hoverable resize chrome.",
    ],
    assertions: {
      realisticEditorContent: true,
      liveEditorHostTokenModes: themes.length,
      monacoVisible: true,
      syntaxAndDiagnosticsContentVisible: true,
      tabsVisible: true,
      embeddedFileIconsVisible: await editorWindow.locator(".fi-img, .fi-fallback").count(),
      findWidgetCaptured: true,
      splitPaneCaptured: true,
      resizeExercised: true,
      compactOverflowCaptured: true,
      largeBufferModeCaptured: true,
      statusBarCaptured: true,
      reducedMotionFocusCaptured: true,
      inlineGhostTextCaptured: true,
      inlineCompletionRequests: inlineCompletion.inlineRequests.length,
      inlineTelemetryReports: inlineCompletion.telemetryReports.length,
      pageErrors: 0,
    },
    artifacts,
  };
}

test.afterAll(() => {
  for (const project of tempProjects) {
    rmSync(project, { recursive: true, force: true });
  }
});

test("records Issue #1295 running-editor fidelity evidence", async ({ page }) => {
  test.setTimeout(300_000);
  ensureEvidenceDir();
  const projectPath = createProjectFixture();
  const assertNoPageErrors = collectPageErrors(page);
  const inlineCompletion = await stubInlineCompletionRoutes(page);
  const run = await capturePrimaryThemeEvidence(page, projectPath);
  const reducedMotion = await captureReducedMotionEvidence(page, projectPath);
  const themes = [...run.themes, reducedMotion];
  const artifacts = [...run.artifacts, ...reducedMotion.screenshots];
  const manifest = await buildManifest(run.darkEditorWindow, themes, artifacts, inlineCompletion);
  writeFileSync(artifactPath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assertNoPageErrors();
});

for (const viewportCase of EDITOR_RESIZE_VIEWPORTS) {
  test(`keeps Issue #1424 editor resize stable in the ${viewportCase.name} viewport`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const projectPath = createProjectFixture();
    const assertNoPageErrors = collectPageErrors(page);
    const editorWindow = await openSeededEditor(page, projectPath, viewportCase);

    await exerciseResponsiveDiagnosticHover(
      page,
      editorWindow,
      viewportCase,
      "missingEditorTopEdgeHoverSymbolThatMustOpenDownward",
      true,
    );
    await exerciseResponsiveDiagnosticHover(
      page,
      editorWindow,
      viewportCase,
      "missingEnterpriseEditorTooltipRegressionSymbol",
    );
    await exerciseWindowResizeMatrix(page, editorWindow);
    await exerciseEditorInternalSizingMatrix(page, editorWindow);
    await exerciseCompactTabChooser(editorWindow);

    assertNoPageErrors();
  });
}
