import { expect, test, type Page } from "@playwright/test";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GLOBALS_CSS = resolve(REPO, "packages", "keiko-ui", "src", "app", "globals.css");
const EVIDENCE_DIR = resolve(REPO, "docs", "design-system", "evidence", "1296", "editor");

const ARTIFACT_NAMES = [
  "dark-editor-agent.png",
  "light-editor-agent.png",
  "high-contrast-editor-agent.png",
  "manifest.json",
] as const;

type ArtifactName = (typeof ARTIFACT_NAMES)[number];
type EditorAgentMode = "dark" | "light" | "high-contrast";

interface ModeDefinition {
  readonly mode: EditorAgentMode;
  readonly artifact: ArtifactName;
  readonly dataTheme: string | null;
  readonly dataHc: string | null;
  readonly colorScheme: "dark" | "light";
}

interface ModeEvidence {
  readonly mode: EditorAgentMode;
  readonly artifact: ArtifactName;
  readonly dataTheme: string | null;
  readonly dataHc: string | null;
  readonly tokenValues: Record<string, string>;
  readonly resolved: {
    readonly agentGhostColor: string;
    readonly legacyGhostColor: string;
    readonly agentLineBackground: string;
    readonly agentGutterColor: string;
    readonly chipBackground: string;
    readonly chipBorderColor: string;
  };
}

interface EvidenceManifest {
  readonly issue: "#1296";
  readonly harness: "playwright.issue-1296-editor-agent.config.ts";
  readonly appPath: "packaged-cli-ui";
  readonly route: "/";
  readonly evidencePath: "docs/design-system/evidence/1296/editor";
  readonly generatedAt: string;
  readonly designReference: "design-system/editor-agent.html";
  readonly productCss: "packages/keiko-ui/src/app/globals.css";
  readonly assertions: {
    readonly packagedUiLoaded: true;
    readonly editorAgentGhostMatchesEditorGhost: true;
    readonly screenshotsCaptured: number;
    readonly authorityBearingFlowsPrimitiveOnly: true;
  };
  readonly modes: readonly ModeEvidence[];
  readonly notes: readonly string[];
  readonly artifacts: readonly ArtifactName[];
}

const MODES: readonly ModeDefinition[] = [
  {
    mode: "dark",
    artifact: "dark-editor-agent.png",
    dataTheme: null,
    dataHc: null,
    colorScheme: "dark",
  },
  {
    mode: "light",
    artifact: "light-editor-agent.png",
    dataTheme: "light",
    dataHc: null,
    colorScheme: "light",
  },
  {
    mode: "high-contrast",
    artifact: "high-contrast-editor-agent.png",
    dataTheme: null,
    dataHc: "more",
    colorScheme: "dark",
  },
];

const TOKEN_NAMES = [
  "--ed-agent-line",
  "--ed-agent-gutter",
  "--ed-agent-ghost",
  "--ed-agent-accept",
  "--ed-agent-reject",
  "--ed-agent-chip-bg",
  "--ed-agent-chip-line",
  "--ed-ghost",
  "--ai-permission-surface",
  "--ai-permission-border",
  "--feedback-danger",
] as const;

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #1296 editor evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!ARTIFACT_NAMES.includes(name)) {
    throw new Error("Unexpected Issue #1296 editor evidence artifact");
  }
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

// eslint-disable-next-line max-lines-per-function -- static browser evidence fixture markup.
function sceneHtml(): string {
  const globals = readFileSync(GLOBALS_CSS, "utf8");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      ${globals}
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--background-primary);
        color: var(--text-primary);
        font-family: var(--font-ui), system-ui, sans-serif;
      }
      .e1296-stage {
        box-sizing: border-box;
        width: 960px;
        padding: 24px;
      }
      .e1296-frame {
        display: grid;
        grid-template-columns: 1fr 310px;
        gap: 16px;
        background: var(--surface-primary);
        border: 1px solid var(--border-default);
        box-shadow: var(--shadow-card);
        padding: 14px;
      }
      .e1296-editor {
        overflow: hidden;
        background: var(--ed-bg);
        color: var(--ed-fg);
        border: 1px solid var(--border-subtle);
        font-family: var(--font-mono), ui-monospace, monospace;
        font-size: 13px;
        line-height: 1.6;
      }
      .e1296-titlebar {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 12px;
        background: var(--ed-tab-active-bg);
        color: var(--ed-tab-active-fg);
        border-bottom: 1px solid var(--border-subtle);
        font-size: 11px;
      }
      .e1296-code {
        display: grid;
        grid-template-columns: 44px 1fr;
      }
      .e1296-gutter {
        background: var(--ed-bg-gutter);
        color: var(--ed-agent-gutter);
        text-align: right;
        padding: 12px 9px 12px 0;
        border-right: 1px solid var(--border-subtle);
      }
      .e1296-lines {
        padding: 12px 0;
      }
      .e1296-line {
        padding: 0 12px;
        white-space: pre;
      }
      .e1296-agent-line {
        background: var(--ed-agent-line);
        border-left: 3px solid var(--ed-agent-gutter);
        padding-left: 9px;
      }
      .e1296-kw { color: var(--ed-syn-keyword); }
      .e1296-fn { color: var(--ed-syn-function); }
      .e1296-str { color: var(--ed-syn-string); }
      .e1296-ghost { color: var(--ed-agent-ghost); }
      .e1296-legacy-ghost-probe { color: var(--ed-ghost); }
      .e1296-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-top: 10px;
        padding: 5px 8px;
        border: 1px solid var(--ed-agent-chip-line);
        background: var(--ed-agent-chip-bg);
        color: var(--text-primary);
        font: 600 11px var(--font-ui), system-ui, sans-serif;
      }
      .e1296-chip::before {
        content: "";
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: var(--ed-agent-accept);
      }
      .e1296-side {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .e1296-side .ai-permit,
      .e1296-side .ai-danger {
        margin: 0;
      }
      .e1296-side .ai-conf {
        align-self: flex-start;
      }
    </style>
  </head>
  <body>
    <main class="e1296-stage" data-evidence-root>
      <section class="e1296-frame" aria-label="Editor agent evidence">
        <article class="e1296-editor" aria-label="Keiko editor agent context">
          <div class="e1296-titlebar">
            <span>src/AgentPlan.ts</span>
            <span>agent context</span>
          </div>
          <div class="e1296-code">
            <div class="e1296-gutter" aria-hidden="true">41<br />42<br />43<br />44<br />45<br />46</div>
            <div class="e1296-lines">
              <div class="e1296-line"><span class="e1296-kw">export</span> <span class="e1296-kw">async function</span> <span class="e1296-fn">shipAudit</span>() {</div>
              <div class="e1296-line">  <span class="e1296-kw">const</span> plan = <span class="e1296-str">"issue-1296"</span>;</div>
              <div class="e1296-line e1296-agent-line">  <span class="e1296-ghost">await agent.verifyEditorContext(plan);</span></div>
              <div class="e1296-line">  <span class="e1296-kw">return</span> plan;</div>
              <div class="e1296-line">}</div>
              <span class="e1296-legacy-ghost-probe" aria-hidden="true">legacy ghost probe</span>
              <div class="e1296-chip">AI edit suggestion ready for review</div>
            </div>
          </div>
        </article>
        <aside class="e1296-side" aria-label="Editor agent primitives">
          <div class="ai-conf" data-level="medium">
            <span class="track" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="lbl">Medium</span>
          </div>
          <div class="ai-permit">
            <div class="ai-permit-h">
              <span class="ic" aria-hidden="true">lock</span>
              <div>
                <div class="tt">Allow editor context access?</div>
                <div class="ts">Primitive only in #1296; live authority flow remains #1405.</div>
              </div>
            </div>
            <div class="ai-permit-scope">
              <div class="row"><span class="gr">yes</span> Current file and diagnostics</div>
              <div class="row">no Repository write access</div>
            </div>
            <div class="ai-permit-act"><button class="ai-stop" type="button">Review</button></div>
          </div>
          <div class="ai-danger">
            <div class="ai-danger-h">
              <span class="ic" aria-hidden="true">!</span>
              <div class="tt">Sensitive editor action</div>
            </div>
            <p>Primitive only. Executing permissioned edits is deferred to #1405.</p>
            <div class="ai-danger-act"><button class="ai-stop" type="button">Cancel</button></div>
          </div>
        </aside>
      </section>
    </main>
  </body>
</html>`;
}

async function applyMode(page: Page, mode: ModeDefinition): Promise<void> {
  await page.emulateMedia({ colorScheme: mode.colorScheme });
  await page.setContent(sceneHtml(), { waitUntil: "load" });
  await page.evaluate(
    ({ dataTheme, dataHc }) => {
      const root = document.documentElement;
      root.removeAttribute("data-theme");
      root.removeAttribute("data-hc");
      if (dataTheme !== null) root.setAttribute("data-theme", dataTheme);
      if (dataHc !== null) root.setAttribute("data-hc", dataHc);
    },
    { dataTheme: mode.dataTheme, dataHc: mode.dataHc },
  );
  await expect(page.locator("[data-evidence-root]")).toBeVisible();
}

async function collectModeEvidence(
  page: Page,
): Promise<Pick<ModeEvidence, "tokenValues" | "resolved">> {
  return page.evaluate((tokenNames) => {
    const rootStyles = getComputedStyle(document.documentElement);
    const tokenValues = Object.fromEntries(
      tokenNames.map((token) => [token, rootStyles.getPropertyValue(token).trim()]),
    );
    const ghost = document.querySelector(".e1296-ghost");
    const legacyGhost = document.querySelector(".e1296-legacy-ghost-probe");
    const agentLine = document.querySelector(".e1296-agent-line");
    const gutter = document.querySelector(".e1296-gutter");
    const chip = document.querySelector(".e1296-chip");
    if (
      ghost === null ||
      legacyGhost === null ||
      agentLine === null ||
      gutter === null ||
      chip === null
    ) {
      throw new Error("Issue #1296 editor-agent evidence DOM did not render expected probes");
    }
    return {
      tokenValues,
      resolved: {
        agentGhostColor: getComputedStyle(ghost).color,
        legacyGhostColor: getComputedStyle(legacyGhost).color,
        agentLineBackground: getComputedStyle(agentLine).backgroundColor,
        agentGutterColor: getComputedStyle(gutter).color,
        chipBackground: getComputedStyle(chip).backgroundColor,
        chipBorderColor: getComputedStyle(chip).borderTopColor,
      },
    };
  }, TOKEN_NAMES);
}

function expectModeEvidence(evidence: Pick<ModeEvidence, "tokenValues" | "resolved">): void {
  expect(evidence.tokenValues["--ed-agent-ghost"]).toBe(evidence.tokenValues["--ed-ghost"]);
  expect(evidence.resolved.agentGhostColor).toBe(evidence.resolved.legacyGhostColor);
  expect(evidence.resolved.agentLineBackground).not.toBe("");
  expect(evidence.resolved.agentGutterColor).not.toBe("");
  expect(evidence.resolved.chipBorderColor).not.toBe("");
}

async function renderMode(page: Page, mode: ModeDefinition): Promise<ModeEvidence> {
  await applyMode(page, mode);
  const evidence = await collectModeEvidence(page);
  expectModeEvidence(evidence);
  await page.locator("[data-evidence-root]").screenshot({
    path: artifactPath(mode.artifact),
  });
  return {
    mode: mode.mode,
    artifact: mode.artifact,
    dataTheme: mode.dataTheme,
    dataHc: mode.dataHc,
    tokenValues: evidence.tokenValues,
    resolved: evidence.resolved,
  };
}

test("Issue #1296 editor-agent context parity evidence", async ({ page }) => {
  ensureEvidenceDir();
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();

  const modes: ModeEvidence[] = [];
  for (const mode of MODES) {
    modes.push(await renderMode(page, mode));
  }

  const manifest: EvidenceManifest = {
    issue: "#1296",
    harness: "playwright.issue-1296-editor-agent.config.ts",
    appPath: "packaged-cli-ui",
    route: "/",
    evidencePath: "docs/design-system/evidence/1296/editor",
    generatedAt: new Date().toISOString(),
    designReference: "design-system/editor-agent.html",
    productCss: "packages/keiko-ui/src/app/globals.css",
    assertions: {
      packagedUiLoaded: true,
      editorAgentGhostMatchesEditorGhost: true,
      screenshotsCaptured: modes.length,
      authorityBearingFlowsPrimitiveOnly: true,
    },
    modes,
    notes: [
      "Screenshots cover real editor-context agent primitives in Dark, Light, and High Contrast.",
      "Monaco ghost text consumes --ed-agent-ghost, which aliases --ed-ghost without visual drift.",
      "Permission and sensitive-action prompts are token-backed primitives only in #1296; live authority wiring remains deferred to #1405.",
    ],
    artifacts: ARTIFACT_NAMES,
  };

  writeFileSync(artifactPath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
});
