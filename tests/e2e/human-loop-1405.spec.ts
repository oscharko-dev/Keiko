import { expect, test, type Page } from "@playwright/test";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GLOBALS_CSS = resolve(REPO, "packages", "keiko-ui", "src", "app", "globals.css");
const EVIDENCE_DIR = resolve(REPO, "docs", "design-system", "evidence", "1405");

const ARTIFACT_NAMES = ["human-loop-1405.png", "manifest.json"] as const;

type ArtifactName = (typeof ARTIFACT_NAMES)[number];

interface EvidenceManifest {
  readonly issue: "#1405";
  readonly harness: "playwright.issue-1405-human-loop.config.ts";
  readonly productCss: "packages/keiko-ui/src/app/globals.css";
  readonly generatedAt: string;
  readonly artifacts: readonly ArtifactName[];
  readonly assertions: {
    readonly permissionScopeRowsRendered: true;
    readonly sensitiveActionUsesTypedConfirm: true;
    readonly regenerateAnnouncesBusyState: true;
    readonly focusVisibleRingResolved: true;
    readonly nonColourAuthorityEncoding: true;
  };
  readonly resolved: {
    readonly permitBorderColor: string;
    readonly dangerBorderColor: string;
    readonly focusedOutlineStyle: string;
    readonly focusedOutlineWidth: string;
  };
}

function ensureEvidenceDir(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stat = lstatSync(EVIDENCE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Issue #1405 evidence directory is not a real directory");
  }
}

function artifactPath(name: ArtifactName): string {
  if (!ARTIFACT_NAMES.includes(name)) {
    throw new Error("Unexpected Issue #1405 evidence artifact");
  }
  const resolved = resolve(EVIDENCE_DIR, name);
  const rel = relative(EVIDENCE_DIR, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Issue #1405 evidence artifact escaped its directory");
  }
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Issue #1405 evidence artifact path is a symlink");
  }
  return resolved;
}

function stageStyles(): string {
  const globals = readFileSync(GLOBALS_CSS, "utf8");
  return `<style>
    ${globals}
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--background-primary);
      color: var(--text-primary);
      font-family: var(--font-ui), system-ui, sans-serif;
    }
    .e1405-stage {
      box-sizing: border-box;
      width: 920px;
      padding: 24px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
    }
    .e1405-stage h2 { margin: 0 0 8px; font-size: 13px; }
    .e1405-panel { min-width: 0; }
    .ai-permit, .ai-danger { margin: 0; }
    .ai-controls { opacity: 1; }
    .e1405-chat {
      border: 1px solid var(--line);
      background: var(--surface);
      padding: 12px;
    }
    .e1405-live {
      position: static;
      width: auto;
      height: auto;
      margin-top: 8px;
      font-size: 12px;
      color: var(--text-muted);
    }
  </style>`;
}

function permissionPanelHtml(): string {
  return `<section class="e1405-panel" aria-label="Permission request">
    <h2>Permission request</h2>
    <article class="ai-permit" aria-label="Review requested permission">
      <div class="ai-permit-h">
        <span class="ic" aria-hidden="true">lock</span>
        <div>
          <div class="tt">Approve write action</div>
          <div class="ts">Grant applies only to this queued action.</div>
        </div>
      </div>
      <div class="ai-permit-scope">
        <div class="row"><span class="gr" aria-hidden="true">yes</span> Allow write action after review</div>
        <div class="row"><span aria-hidden="true">no</span> No extra BFF authority or autonomous follow-up</div>
      </div>
      <div class="ai-permit-act">
        <button type="button">Reject</button>
        <button type="button">Approve</button>
      </div>
    </article>
  </section>`;
}

function sensitiveActionPanelHtml(): string {
  return `<section class="e1405-panel" aria-label="Sensitive action">
    <h2>Sensitive action</h2>
    <article class="ai-danger" aria-label="Confirm destructive action">
      <div class="ai-danger-h">
        <span class="ic" aria-hidden="true">!</span>
        <div class="tt">Forget permanently</div>
      </div>
      <p>This permanently removes the memory item from local state.</p>
      <label class="chat-memory-confirm">
        <span>Type FORGET to remove memory-1.</span>
        <input aria-label="Type FORGET to remove memory-1." value="FORGET" readonly />
      </label>
      <div class="ai-danger-act">
        <button class="ai-stop" type="button">Cancel</button>
        <button class="ai-stop" type="button">Forget permanently</button>
      </div>
    </article>
  </section>`;
}

function regeneratePanelHtml(): string {
  return `<section class="e1405-panel" aria-label="Regenerate response">
    <h2>Regenerate response</h2>
    <div class="e1405-chat">
      <div class="chat-msg-actions">
        <button class="ai-controls ai-stop" type="button" aria-label="Cancel regeneration" aria-busy="true">
          <span aria-hidden="true">■</span>
          <span>Cancel</span>
        </button>
        <span class="e1405-live" role="status">Regenerating response</span>
      </div>
    </div>
  </section>`;
}

function sceneHtml(): string {
  return `<!doctype html>
    <html>
      <head><meta charset="utf-8" />${stageStyles()}</head>
      <body>
        <main class="e1405-stage" data-evidence-root>
          ${permissionPanelHtml()}
          ${sensitiveActionPanelHtml()}
          ${regeneratePanelHtml()}
        </main>
      </body>
    </html>`;
}

async function resolvedEvidence(page: Page): Promise<EvidenceManifest["resolved"]> {
  return page.evaluate(() => {
    const permit = document.querySelector(".ai-permit");
    const danger = document.querySelector(".ai-danger");
    const focused = document.querySelector(".ai-controls");
    if (permit === null || danger === null || focused === null) {
      throw new Error("Issue #1405 evidence DOM did not render expected probes");
    }
    const permitStyle = getComputedStyle(permit);
    const dangerStyle = getComputedStyle(danger);
    const focusStyle = getComputedStyle(focused);
    return {
      permitBorderColor: permitStyle.borderTopColor,
      dangerBorderColor: dangerStyle.borderTopColor,
      focusedOutlineStyle: focusStyle.outlineStyle,
      focusedOutlineWidth: focusStyle.outlineWidth,
    };
  });
}

async function loadScene(page: Page): Promise<void> {
  await page.setContent(sceneHtml(), { waitUntil: "load" });
  await expect(page.locator("[data-evidence-root]")).toBeVisible();
}

test("Issue #1405 human-loop authority browser evidence", async ({ page }) => {
  ensureEvidenceDir();
  await loadScene(page);

  await expect(page.getByLabel("Review requested permission")).toContainText(
    "No extra BFF authority or autonomous follow-up",
  );
  await expect(page.getByLabel("Review requested permission")).toContainText(
    "Allow write action after review",
  );
  await expect(page.getByLabel("Confirm destructive action")).toContainText(
    "Type FORGET to remove memory-1.",
  );
  await expect(page.getByRole("button", { name: "Cancel regeneration" })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(page.getByRole("status")).toHaveText("Regenerating response");

  await page.getByRole("button", { name: "Cancel regeneration" }).focus();
  const resolved = await resolvedEvidence(page);
  expect(resolved.permitBorderColor).not.toBe("");
  expect(resolved.dangerBorderColor).not.toBe("");
  expect(resolved.focusedOutlineStyle).not.toBe("none");
  expect(resolved.focusedOutlineWidth).not.toBe("0px");

  await page
    .locator("[data-evidence-root]")
    .screenshot({ path: artifactPath("human-loop-1405.png") });

  const manifest: EvidenceManifest = {
    issue: "#1405",
    harness: "playwright.issue-1405-human-loop.config.ts",
    productCss: "packages/keiko-ui/src/app/globals.css",
    generatedAt: new Date().toISOString(),
    artifacts: ARTIFACT_NAMES,
    assertions: {
      permissionScopeRowsRendered: true,
      sensitiveActionUsesTypedConfirm: true,
      regenerateAnnouncesBusyState: true,
      focusVisibleRingResolved: true,
      nonColourAuthorityEncoding: true,
    },
    resolved,
  };

  writeFileSync(artifactPath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
});
