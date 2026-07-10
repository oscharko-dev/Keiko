import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AxeViolation, formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";

// Documented baseline of pre-existing real-browser serious/critical violations that this gate does
// NOT own the fix for. Each entry must carry a reason and an owner. The gate fails on ANY
// serious/critical violation NOT on this list, so new regressions are still caught. Keep this list
// SHORT and shrinking — it is a to-fix ledger, not a mute button.
//
// Currently EMPTY: the sole prior residual (RB-14, .win-zpct color-contrast — the zoom-percentage
// badge rendered --text-tertiary under the zoom cluster's opacity:0.72, measuring 3.45:1 in a real
// browser) was fixed at the source in the SHA-pinned globals.css via the --win-zoom-pct token
// (dark 6.15:1 / light 4.97:1), so the gate now runs green with no allowlist entry.
const KNOWN_A11Y_ISSUES: readonly {
  readonly id: string;
  readonly selector: string;
  readonly reason: string;
}[] = [];

// Returns serious/critical violations after removing nodes explained by KNOWN_A11Y_ISSUES. A
// violation survives only if it has at least one node whose target is NOT covered by an allowlist
// entry for the same rule — so a color-contrast regression on a DIFFERENT element still fails.
function unexplainedViolations(violations: readonly AxeViolation[]): readonly AxeViolation[] {
  const survivors: AxeViolation[] = [];
  for (const violation of seriousOrCritical(violations)) {
    const unexplainedNodes = violation.nodes.filter(
      (node) =>
        !KNOWN_A11Y_ISSUES.some(
          (known) =>
            known.id === violation.id &&
            node.target.some((selector) => selector.includes(known.selector)),
        ),
    );
    if (unexplainedNodes.length > 0) {
      survivors.push({ ...violation, nodes: unexplainedNodes });
    }
  }
  return survivors;
}

// GEN-TEST-E2E-004 — the browser a11y estate was one coordinator-only axe suite (update-ui-1696,
// wired into no CI job) plus jsdom component axe. The W10 High-severity regressions (composer
// combobox semantics, roving tabindex, focus traps) are the kind that jsdom cannot see and only a
// real browser reveals. This spec runs axe over the two highest-value live surfaces — the desktop
// shell and a seeded chat window — and fails on any serious/critical WCAG 2.2 AA violation.

const CHAT_MODEL_ID = "e2e-chat-model";
const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" };
const tempProjects: string[] = [];

// Give the seeded floating window room to render fully inside the viewport for the axe scan.
test.use({ viewport: { width: 1280, height: 960 } });

interface ChatResponse {
  readonly chat: { readonly id: string; readonly title: string };
}

async function createChat(request: APIRequestContext): Promise<ChatResponse["chat"]> {
  const root = mkdtempSync(join(tmpdir(), "keiko-e2e-a11y-"));
  tempProjects.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "# a11y smoke fixture\n", "utf8");
  const project = await request.post("/api/projects", {
    headers: MUTATION_HEADERS,
    data: { path: root, name: "Keiko a11y E2E" },
  });
  if (!project.ok()) throw new Error(`Project setup failed (${String(project.status())})`);
  const create = await request.post("/api/chats", {
    headers: MUTATION_HEADERS,
    data: { projectPath: root, title: "E2E a11y chat", selectedModel: CHAT_MODEL_ID },
  });
  expect(create.status()).toBe(201);
  return ((await create.json()) as ChatResponse).chat;
}

async function seedChatWindow(page: Page, chat: ChatResponse["chat"]): Promise<void> {
  await page.addInitScript(
    ({ chatId, title }) => {
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "e2e-a11y-chat-window",
            type: "chat",
            x: 80,
            y: 60,
            w: 820,
            h: 660,
            z: 10,
            cfg: { chatId, title },
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { chatId: chat.id, title: chat.title },
  );
}

test.afterEach(() => {
  for (const root of tempProjects.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop shell has no serious/critical axe violations @smoke", async ({ page }) => {
  await page.goto("/");
  // The launcher/taskbar shell header is always present; wait for it before scanning.
  await expect(page.locator("header.header")).toBeVisible();
  const violations = unexplainedViolations(await runAxe(page, "body"));
  expect(violations.length, formatViolations(violations)).toBe(0);
});

test("seeded chat window has no serious/critical axe violations @smoke", async ({
  page,
  request,
}) => {
  const chat = await createChat(request);
  await seedChatWindow(page, chat);
  await page.goto("/");
  const chatWindow = page.getByRole("region", { name: "Chat — E2E a11y chat" });
  await expect(chatWindow).toBeVisible();
  await expect(chatWindow.getByRole("textbox", { name: "Chat message" })).toBeVisible();
  await chatWindow.locator(".chatw-empty").evaluate(async (element) => {
    await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
  });
  const violations = unexplainedViolations(
    await runAxe(page, '.window[data-window-id="e2e-a11y-chat-window"]'),
  );
  expect(violations.length, formatViolations(violations)).toBe(0);
});
