import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { editorModifier, focusMonacoInput } from "./support/editor-chord.js";

const EVIDENCE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "docs",
  "design-system",
  "evidence",
  "1296",
  "editor",
);
const ARTIFACT_NAMES = [
  "dark-editor-agent.png",
  "light-editor-agent.png",
  "high-contrast-editor-agent.png",
  "manifest.json",
] as const;
const TOKEN_NAMES = [
  "--ed-agent-line",
  "--ed-agent-gutter",
  "--ed-agent-ghost",
  "--ed-agent-accept",
  "--ed-agent-reject",
  "--ed-agent-chip-bg",
  "--ed-agent-chip-line",
  "--ed-ghost",
] as const;

type ArtifactName = (typeof ARTIFACT_NAMES)[number];
type EditorAgentMode = "dark" | "light" | "high-contrast";

interface ModeDefinition {
  readonly mode: EditorAgentMode;
  readonly artifact: ArtifactName;
  readonly colorScheme: "dark" | "light";
  readonly contrast: "more" | "no-preference";
}

interface ModeEvidence {
  readonly mode: EditorAgentMode;
  readonly artifact: ArtifactName;
  readonly tokenValues: Record<string, string>;
  readonly monaco: Record<string, string>;
}

interface EvidenceManifest {
  readonly issue: 1296;
  readonly harness: "tests/e2e/config/playwright.issue-1296-editor-agent.config.ts";
  readonly appPath: "packaged-cli-ui";
  readonly route: "/";
  readonly workspace: "synthetic-temp-project";
  readonly evidencePath: "docs/design-system/evidence/1296/editor";
  readonly generatedAt: string;
  readonly designReference: "design-system/editor-agent.html";
  readonly productCss: "packages/keiko-ui/src/app/globals.css";
  readonly assertions: {
    readonly packagedAppBooted: true;
    readonly liveMonacoVisible: true;
    readonly liveInlineGhostVisible: true;
    readonly inlineCompletionRequests: number;
    readonly screenshotsCaptured: number;
  };
  readonly modes: readonly ModeEvidence[];
  readonly notes: readonly string[];
  readonly artifacts: readonly ArtifactName[];
}

const MODES: readonly ModeDefinition[] = [
  {
    mode: "dark",
    artifact: "dark-editor-agent.png",
    colorScheme: "dark",
    contrast: "no-preference",
  },
  {
    mode: "light",
    artifact: "light-editor-agent.png",
    colorScheme: "light",
    contrast: "no-preference",
  },
  {
    mode: "high-contrast",
    artifact: "high-contrast-editor-agent.png",
    colorScheme: "dark",
    contrast: "more",
  },
];

const tempProjects: string[] = [];

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #1296 editor evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!ARTIFACT_NAMES.includes(name))
    throw new Error("Unexpected Issue #1296 editor evidence artifact");
  const resolved = resolve(EVIDENCE_DIR, name);
  const rel = relative(EVIDENCE_DIR, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Issue #1296 editor evidence artifact escaped its directory");
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Issue #1296 editor evidence artifact path is a symlink");
  }
  return resolved;
}

function createProjectFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-1296-editor-"));
  tempProjects.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "AgentPlan.ts"),
    [
      "export async function shipAudit(): Promise<string> {",
      '  const plan = "issue-1296";',
      "  await agent.verifyEditorContext(plan);",
      "  return plan;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

async function seedLiveEditor(page: Page, root: string, mode: ModeDefinition): Promise<void> {
  await page.emulateMedia({ colorScheme: mode.colorScheme, contrast: mode.contrast });
  await page.addInitScript(
    ({ projectRoot, theme }) => {
      window.localStorage.setItem("keiko.theme", theme);
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: `issue-1296-editor-${theme}`,
            type: "editor",
            x: 32,
            y: 32,
            w: 920,
            h: 620,
            z: 10,
            cfg: { root: projectRoot, file: "src/AgentPlan.ts", openFiles: ["src/AgentPlan.ts"] },
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { projectRoot: root, theme: mode.colorScheme },
  );
  await page.goto("/");
}

async function installInlineCompletionRoute(page: Page): Promise<() => number> {
  let requestCount = 0;
  await page.route("**/api/editor/inline-completion", async (route) => {
    requestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "1",
        items: [{ insertText: "urn 42;" }],
        provenance: {
          sources: ["model-assisted"],
          modelMode: "as-you-type",
          modelId: "issue-1296-editor-agent",
          latencyClass: "fast",
          gatewayPolicyVersion: "editor-inline-completion/1",
          promptHash: "b".repeat(64),
        },
      }),
    });
  });
  await page.route("**/api/editor/inline-completion/telemetry", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  return () => requestCount;
}

async function openLiveEditor(page: Page): Promise<Locator> {
  const editorWindow = page
    .locator(".window[data-window-id]")
    .filter({ has: page.locator(".editor-workspace") })
    .first();
  await expect(editorWindow).toBeVisible();
  await expect(editorWindow.locator(".monaco-editor").first()).toBeVisible();
  await expect(editorWindow.getByTestId("editor-status-bar")).toBeVisible();
  await expect(
    editorWindow.locator(".view-line").filter({ hasText: "shipAudit" }).first(),
  ).toBeVisible();
  return editorWindow;
}

async function triggerLiveInlineGhost(page: Page, editorWindow: Locator): Promise<void> {
  // F6: a plain `.click()` on `.monaco-editor` lands focus on Chromium's EditContext surface but
  // can leave Firefox's fallback `textarea.inputarea` unfocused (support/editor-chord.ts
  // `focusMonacoInput`'s doc comment). An unfocused fallback means the select-all chord below
  // reaches nothing, and `insertText` then APPENDS instead of replacing — the same silent
  // corruption class `replaceEditorBuffer` was written to catch. Use the shared, engine-agnostic
  // focus helper instead of re-deriving a weaker click-only version of it here.
  await focusMonacoInput(editorWindow);
  const modifier = await editorModifier(page);
  await page.keyboard.press(`${modifier}+KeyA`);
  // Delete the selection with a REAL key event before inserting. `insertText` hands text to the
  // engine's input pipeline without key events, and whether that replaces an existing selection
  // is engine-dependent: Chromium replaces, Firefox inserts at the caret and LEAVES the selected
  // text in place — appending instead of replacing. Backspace on a selection is unambiguous in
  // both (same reason `replaceEditorBuffer` in support/editor-chord.ts does it).
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText("export function answer() {\n  ret");
  await expect(page.getByRole("alert").filter({ hasText: "urn 42;" }).first()).toBeVisible();
}

async function collectLiveEvidence(
  page: Page,
  editorWindow: Locator,
): Promise<{
  readonly tokenValues: Record<string, string>;
  readonly monaco: Record<string, string>;
}> {
  const tokenValues = await page.evaluate(
    (names) => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
    },
    [...TOKEN_NAMES],
  );
  const monaco = await editorWindow
    .locator(".monaco-editor")
    .first()
    .evaluate((element) => {
      const editor = element as HTMLElement;
      const line = editor.querySelector(".view-line");
      const gutter = editor.querySelector(".margin");
      return {
        backgroundColor: getComputedStyle(editor).backgroundColor,
        lineColor:
          line instanceof HTMLElement ? getComputedStyle(line).color : "missing-line-color",
        gutterBackground:
          gutter instanceof HTMLElement
            ? getComputedStyle(gutter).backgroundColor
            : "missing-gutter-background",
      };
    });
  for (const [name, value] of Object.entries({ ...tokenValues, ...monaco })) {
    expect(value, `${name} should resolve on the live packaged editor`).not.toMatch(/^missing|^$/u);
  }
  expect(tokenValues["--ed-agent-ghost"]).toBe(tokenValues["--ed-ghost"]);
  return { tokenValues, monaco };
}

async function captureMode(page: Page, root: string, mode: ModeDefinition): Promise<ModeEvidence> {
  await seedLiveEditor(page, root, mode);
  const editorWindow = await openLiveEditor(page);
  await triggerLiveInlineGhost(page, editorWindow);
  const evidence = await collectLiveEvidence(page, editorWindow);
  await editorWindow.screenshot({ path: artifactPath(mode.artifact) });
  return { mode: mode.mode, artifact: mode.artifact, ...evidence };
}

test.afterAll(() => {
  for (const project of tempProjects) rmSync(project, { recursive: true, force: true });
});

test("Issue #1296 records packaged editor-agent evidence", async ({ page }) => {
  test.setTimeout(300_000);
  ensureEvidenceDir();
  const inlineCompletionRequests = await installInlineCompletionRoute(page);
  const root = createProjectFixture();
  const modes: ModeEvidence[] = [];
  for (const mode of MODES) modes.push(await captureMode(page, root, mode));
  expect(inlineCompletionRequests()).toBeGreaterThan(0);

  const manifest: EvidenceManifest = {
    issue: 1296,
    harness: "tests/e2e/config/playwright.issue-1296-editor-agent.config.ts",
    appPath: "packaged-cli-ui",
    route: "/",
    workspace: "synthetic-temp-project",
    evidencePath: "docs/design-system/evidence/1296/editor",
    generatedAt: new Date().toISOString(),
    designReference: "design-system/editor-agent.html",
    productCss: "packages/keiko-ui/src/app/globals.css",
    assertions: {
      packagedAppBooted: true,
      liveMonacoVisible: true,
      liveInlineGhostVisible: true,
      inlineCompletionRequests: inlineCompletionRequests(),
      screenshotsCaptured: modes.length,
    },
    modes,
    notes: [
      "Screenshots capture the packaged CLI UI's running Monaco editor in Dark, Light, and High Contrast.",
      "The proof drives the live inline-completion route and verifies its editor ghost-text alert.",
      "Permissioned agent mutation flows remain separately governed by #1405.",
    ],
    artifacts: ARTIFACT_NAMES,
  };
  writeFileSync(artifactPath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
});
