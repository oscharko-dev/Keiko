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

function createProjectFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-1295-editor-"));
  tempProjects.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeSourceFixture(root);
  writeMarkdownFixture(root);
  writePackageFixture(root);
  writeLargeFixture(root);
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
  await editorWindow.getByRole("button", { name: "Split src/App.tsx right" }).click();
  await expect(editorWindow.getByRole("button", { name: "Resize editor split" })).toBeVisible();
  await openEmbeddedPath(editorWindow, "README.md");
  await expect(editorWindow.getByRole("tab", { name: /README\.md/u })).toBeVisible();
  await expect(editorWindow.locator(".ed-pane")).toHaveCount(2);
  await expect(editorWindow.locator(".ed-pane-resizer")).toBeVisible();
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
  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    await resizer.hover();
    await editorWindow.page().mouse.down();
    await editorWindow.page().mouse.move(box.x + 72, box.y + box.height / 2);
    await editorWindow.page().mouse.up();
  }
  await expect(editorWindow.locator(".ed-pane")).toHaveCount(2);
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
