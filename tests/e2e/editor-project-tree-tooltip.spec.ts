import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
// Keep this safely beyond the 175 px project-tree label width across Linux, macOS, and Windows
// reference fonts. A real but only moderately long repository filename made the truncation premise
// platform-dependent, so CI could correctly render it without overflow and invalidate the test.
const LONG_FILE =
  "this-is-an-intentionally-long-project-tree-filename-that-must-overflow-across-linux-macos-and-windows-reference-font-metrics-without-depending-on-a-specific-glyph-width.ts";
const SHORT_FILE = "NOTICE";
const ACTIVE_FILE = LONG_FILE;
const tempProjects: string[] = [];
// Virtual-time budgets for the tooltip window. `TOOLTIP_BELOW_DELAY_MS` must stay UNDER the
// FilesWidget hover delay (it is the point at which a correctly delayed tooltip is still absent)
// and `TOOLTIP_DRAIN_MS` comfortably over it, so a drain leaves no tooltip timer pending. Both are
// virtual milliseconds, so neither costs wall-clock time nor depends on machine load.
const TOOLTIP_BELOW_DELAY_MS = 500;
const TOOLTIP_DRAIN_MS = 2_000;

function createTooltipFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-e2e-tooltip-"));
  tempProjects.push(root);
  writeFileSync(join(root, LONG_FILE), "module.exports = {};\n", "utf8");
  writeFileSync(join(root, SHORT_FILE), "Keiko tooltip fixture\n", "utf8");
  return root;
}

function collectPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return () => {
    expect(errors).toEqual([]);
  };
}

async function ensureProject(page: Page, projectPath: string): Promise<void> {
  const response = await page.request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: projectPath, name: "Editor tooltip fixture" },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function seedEditorWindow(page: Page, projectPath: string): Promise<void> {
  await page.addInitScript(
    ({ root, activeFile }) => {
      window.localStorage.setItem("keiko.theme", "dark");
      window.localStorage.setItem("keiko.view", JSON.stringify({ zoom: 1, x: 0, y: 0 }));
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "editor-project-tree-tooltip",
            type: "editor",
            x: 32,
            y: 32,
            w: 900,
            h: 620,
            z: 10,
            cfg: {
              root,
              file: activeFile,
              openFiles: [activeFile],
              layout: {
                sidebarCollapsed: false,
                sidebarWidth: 175,
                tree: { type: "pane", paneId: "root" },
                panes: {
                  root: {
                    id: "root",
                    file: activeFile,
                    openFiles: [activeFile],
                  },
                },
              },
            },
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { root: projectPath, activeFile: ACTIVE_FILE },
  );
}

test.afterEach(() => {
  for (const root of tempProjects.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("editor project-tree filenames use delayed Keiko tooltip only when truncated @smoke", async ({
  page,
}) => {
  const assertNoPageErrors = collectPageErrors(page);
  const projectPath = createTooltipFixture();
  await ensureProject(page, projectPath);
  await seedEditorWindow(page, projectPath);

  // Both tooltip claims below are about a DELAYED affordance: one row must never produce a
  // tooltip, the other must not produce one YET. A wall-clock sleep can only ever assume the
  // schedule window elapsed; the virtual clock lets the test DRAIN it. With time frozen at
  // install, `runFor` executes exactly the timers that come due in the window it advances, so
  // "no tooltip after the drain" means the row's timer demonstrably ran or was never scheduled —
  // not merely that a hard-coded number of milliseconds went by on a possibly-loaded machine.
  await page.clock.install();

  await page.goto("/");
  const editorWindow = page
    .locator(".window[data-window-id]")
    .filter({ has: page.locator(".editor-workspace") })
    .first();
  await expect(editorWindow).toBeVisible();
  await expect(editorWindow.locator(".monaco-editor")).toBeVisible();

  const longRow = editorWindow.locator(`.ed-sidebar .tr-row[data-path="${LONG_FILE}"]`);
  const shortRow = editorWindow.locator(`.ed-sidebar .tr-row[data-path="${SHORT_FILE}"]`);
  await expect(longRow).toBeVisible();
  await expect(shortRow).toBeVisible();

  const longRowState = await longRow.evaluate((row) => {
    const name = row.querySelector<HTMLElement>(".tr-name");
    return {
      dataTip: row.getAttribute("data-tip"),
      title: row.getAttribute("title"),
      truncated: name !== null && name.scrollWidth > name.clientWidth + 1,
    };
  });
  expect(longRowState).toEqual({ dataTip: null, title: null, truncated: true });

  const tooltip = page.locator(".files-tree-tooltip");

  // A NON-truncated row must never schedule a tooltip at all. Draining far past the row's delay
  // is what closes the window: had pointer-enter armed a timer, `runFor` would have fired it and
  // the tooltip would be mounted here.
  await shortRow.hover();
  await page.clock.runFor(TOOLTIP_DRAIN_MS);
  await expect(tooltip).toHaveCount(0);

  // A truncated row does schedule one, behind a delay. Advancing less than that delay and finding
  // nothing is an exact statement rather than a race: no other virtual time has passed since
  // pointer-enter, so a tooltip present at this point would mean the delay had been dropped and
  // the tooltip now fires on hover. Draining the rest then proves it does still arrive.
  await longRow.hover();
  await page.clock.runFor(TOOLTIP_BELOW_DELAY_MS);
  await expect(tooltip).toHaveCount(0);
  await page.clock.runFor(TOOLTIP_DRAIN_MS);
  await expect(tooltip).toHaveText(LONG_FILE);

  await page.mouse.move(20, 20);
  await expect(tooltip).toHaveCount(0);
  assertNoPageErrors();
});
