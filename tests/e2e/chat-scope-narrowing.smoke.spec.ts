import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatConnectedScope } from "@oscharko-dev/keiko-contracts/bff-wire";
import { connectedScopeFingerprint } from "../../packages/keiko-ui/src/app/components/desktop/hooks/workspaceScopeIdentity.js";
import { formatViolations, runAxe, seriousOrCritical } from "./support/axe.js";

const HEADERS = { "X-Keiko-CSRF": "1" };
const fixtureRoots: string[] = [];
test.use({ viewport: { width: 1800, height: 1000 } });
test.afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface ScopeChat {
  readonly id: string;
  readonly title: string;
  readonly connectedScopes: readonly ChatConnectedScope[];
}

async function createScopeChat(request: APIRequestContext): Promise<{
  readonly root: string;
  readonly chat: ScopeChat;
}> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-e2e-scope-")));
  fixtureRoots.push(root);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "guide.ts"), "export const first = true;\n");
  writeFileSync(join(root, "docs", "other.ts"), "export const second = true;\n");
  const project = await request.post("/api/projects", {
    headers: HEADERS,
    data: { path: root, name: "Connected scope smoke" },
  });
  expect(project.ok(), await project.text()).toBe(true);
  const created = await request.post("/api/chats", {
    headers: HEADERS,
    data: { projectPath: root, title: "Scope narrowing", selectedModel: "e2e-chat-model" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { chat } = (await created.json()) as { readonly chat: ScopeChat };
  const scope: ChatConnectedScope = {
    kind: "workspace-root",
    root,
    relativePaths: [],
    connectedAtMs: 1,
  };
  const bound = await request.patch(`/api/chats?id=${encodeURIComponent(chat.id)}`, {
    headers: HEADERS,
    data: { connectedScopes: [scope] },
  });
  expect(bound.ok(), await bound.text()).toBe(true);
  return { root, chat: ((await bound.json()) as { readonly chat: ScopeChat }).chat };
}

async function seedConnectedWindows(
  page: Page,
  root: string,
  chat: ScopeChat,
  chatSize = { width: 780, height: 820 },
): Promise<void> {
  const scope = chat.connectedScopes[0];
  if (scope === undefined) throw new TypeError("Missing acknowledged fixture scope");
  const fingerprint = connectedScopeFingerprint(scope);
  await page.addInitScript(
    ({ root, chat, fingerprint, chatSize }) => {
      if (localStorage.getItem("keiko.workspace.v4") !== null) return;
      localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "scope-files",
            type: "files",
            x: 24,
            y: 32,
            w: 550,
            h: 820,
            z: 10,
            cfg: { root, rootBinding: "coding-repository" },
            max: false,
          },
          {
            id: "scope-chat",
            type: "chat",
            x: 980,
            y: 32,
            w: chatSize.width,
            h: chatSize.height,
            z: 11,
            cfg: { chatId: chat.id, title: chat.title },
            max: false,
          },
        ]),
      );
      localStorage.setItem(
        "keiko.conns.v1",
        JSON.stringify([
          {
            id: "scope-edge",
            a: "scope-files",
            b: "scope-chat",
            boundChatWindowId: "scope-chat",
            boundScopeElided: true,
            boundScopeFingerprint: fingerprint,
          },
        ]),
      );
    },
    { root, chat, fingerprint, chatSize },
  );
}

async function storedScopes(
  request: APIRequestContext,
  root: string,
  chatId: string,
): Promise<readonly { readonly kind: string; readonly relativePaths: readonly string[] }[]> {
  const response = await request.get(`/api/chats?projectPath=${encodeURIComponent(root)}`);
  expect(response.ok(), await response.text()).toBe(true);
  const { chats } = (await response.json()) as { readonly chats: readonly ScopeChat[] };
  return (
    chats
      .find((chat) => chat.id === chatId)
      ?.connectedScopes.map((scope) => ({
        kind: scope.kind,
        relativePaths: scope.relativePaths,
      })) ?? []
  );
}

async function expectScope(
  request: APIRequestContext,
  root: string,
  chatId: string,
  kind: string,
  relativePaths: readonly string[],
): Promise<void> {
  await expect.poll(() => storedScopes(request, root, chatId)).toEqual([{ kind, relativePaths }]);
}

function scopeViews(page: Page): {
  readonly files: ReturnType<Page["getByRole"]>;
  readonly chatWindow: ReturnType<Page["getByRole"]>;
  readonly pill: ReturnType<Page["locator"]>;
} {
  const chatWindow = page.getByRole("region", { name: "Chat — Scope narrowing" });
  return {
    files: page.getByRole("region", { name: /^(?:Files|Dateien) — /u }),
    chatWindow,
    pill: chatWindow.locator(".scope-pill"),
  };
}

type ScopeFixture = Awaited<ReturnType<typeof createScopeChat>>;

async function openNarrowedPreview(
  page: Page,
  request: APIRequestContext,
  fixture: ScopeFixture,
  locale = "en",
): Promise<void> {
  const { root, chat } = fixture;
  const { files, chatWindow, pill } = scopeViews(page);
  await expect(pill).toHaveText(/Folder:|Ordner:/u);
  await expect(chatWindow.getByTestId("grounding-help")).toContainText(
    locale === "de" ? "Das Modell hat keine Datei-Werkzeuge" : "The model has no file tools",
  );
  await expectScope(request, root, chat.id, "workspace-root", []);
  await files.locator('.tr-dir-enter[data-path="docs"]').click();
  await expectScope(request, root, chat.id, "directory", ["docs"]);
  await expect(pill).toContainText("/docs");
  await expect(pill.locator("[title]").first()).toHaveAttribute("title", `${root}/docs`);
  await expect(page.locator(".conn-badge")).toContainText("docs");
  await files.locator('.tr-file[data-path="docs/guide.ts"]').click();
  await expectScope(request, root, chat.id, "files", ["docs/guide.ts"]);
  const fileLabel = locale === "de" ? "Datei: guide.ts" : "File: guide.ts";
  await expect(pill).toContainText(fileLabel);
  await expect(chatWindow.getByRole("status").filter({ hasText: fileLabel })).toHaveText(
    locale === "de"
      ? `Der verbundene Bereich wurde zu ${fileLabel} geändert.`
      : `The connected scope changed to ${fileLabel}.`,
  );
  await expect(
    chatWindow.locator('[role="status"][aria-live="polite"]').filter({ hasText: fileLabel }),
  ).toBeVisible();
  await expect(page.locator(".conn-badge")).toContainText("guide.ts");
  const violations = await runAxe(page, ".chat-scope-header");
  expect(seriousOrCritical(violations), formatViolations(violations)).toEqual([]);
}

async function expectStoredPin(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const windows = JSON.parse(localStorage.getItem("keiko.workspace.v4") ?? "[]") as readonly {
          readonly id: string;
          readonly cfg: { readonly keepFilesFolder?: boolean };
        }[];
        return windows.find((window) => window.id === "scope-chat")?.cfg.keepFilesFolder;
      }),
    )
    .toBe(true);
}

async function keepFolderAndPreviewAgain(
  page: Page,
  request: APIRequestContext,
  fixture: ScopeFixture,
): Promise<void> {
  const { root, chat } = fixture;
  const { files, chatWindow, pill } = scopeViews(page);
  await chatWindow.getByRole("button", { name: "Keep folder" }).click();
  await expectScope(request, root, chat.id, "directory", ["docs"]);
  await expect(pill).toContainText("/docs");
  await files.getByRole("button", { name: "Back to files", exact: true }).click();
  await files.locator('.tr-file[data-path="docs/other.ts"]').click();
  await expect(files.getByRole("region", { name: "File preview: other.ts" })).toBeVisible();
  await expectScope(request, root, chat.id, "directory", ["docs"]);
  await expect(pill).toContainText("/docs");
  await expect(pill).not.toContainText("File:");
  await expect(page.locator(".conn-badge")).toContainText("docs");
  await expectStoredPin(page);
}

async function verifyReloadedPin(
  page: Page,
  request: APIRequestContext,
  fixture: ScopeFixture,
): Promise<void> {
  await page.reload();
  const { files, chatWindow, pill } = scopeViews(page);
  await expect(pill).toContainText("/docs");
  await expectStoredPin(page);
  const folder = files.locator('.tr-dir-enter[data-path="docs"]');
  if (await folder.isVisible()) await folder.click();
  await files.locator('.tr-file[data-path="docs/guide.ts"]').click();
  await expect(files.getByRole("region", { name: "File preview: guide.ts" })).toBeVisible();
  await expectScope(request, fixture.root, fixture.chat.id, "directory", ["docs"]);
  await expect(pill).toContainText("/docs");
  await expect(pill).not.toContainText("File:");
  await expect(page.locator(".conn-badge")).toContainText("docs");
  await expect(chatWindow.locator(".scope-pill-detail")).toContainText("the connected folder");
}

test("Files navigation announces narrowing and keeps the folder on later previews @smoke", async ({
  page,
  request,
}, testInfo) => {
  const fixture = await createScopeChat(request);
  await seedConnectedWindows(page, fixture.root, fixture.chat);
  await page.goto("/");
  await openNarrowedPreview(page, request, fixture);
  await keepFolderAndPreviewAgain(page, request, fixture);
  await verifyReloadedPin(page, request, fixture);
  await page.screenshot({ path: testInfo.outputPath("scope-folder-kept.png") });
});

async function chatGeometry(chat: ReturnType<Page["getByRole"]>): Promise<{
  readonly headerHeight: number;
  readonly hintWidth: number;
  readonly availableWidth: number;
  readonly logHeight: number;
  readonly footerBottom: number;
  readonly windowBottom: number;
}> {
  return chat.evaluate((node) => {
    const measure = (selector: string): DOMRect => {
      const element = node.querySelector(selector);
      if (element === null) throw new TypeError(`Missing chat surface ${selector}`);
      return element.getBoundingClientRect();
    };
    const header = measure(".chat-scope-header");
    return {
      headerHeight: header.height,
      hintWidth: measure('[data-testid="grounding-help"]').width,
      availableWidth: header.width - 32,
      logHeight: measure(".chatw-scroll").height,
      footerBottom: measure(".chatw-foot").bottom,
      windowBottom: node.getBoundingClientRect().bottom,
    };
  });
}

function expectUsableConversation(geometry: Awaited<ReturnType<typeof chatGeometry>>): void {
  expect(geometry.hintWidth).toBeGreaterThanOrEqual(geometry.availableWidth - 1);
  expect(geometry.headerHeight, JSON.stringify(geometry)).toBeLessThan(220);
  expect(geometry.logHeight, JSON.stringify(geometry)).toBeGreaterThan(80);
  expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.windowBottom + 1);
}

for (const locale of ["en", "de"]) {
  test(`@smoke visible file-scope notice preserves usable conversation at 480px ${locale}`, async ({
    page,
    request,
  }, testInfo) => {
    const fixture = await createScopeChat(request);
    await seedConnectedWindows(page, fixture.root, fixture.chat, { width: 480, height: 480 });
    await page.addInitScript((value) => {
      localStorage.setItem("keiko.locale", value);
    }, locale);
    await page.goto("/");
    await openNarrowedPreview(page, request, fixture, locale);
    const { chatWindow } = scopeViews(page);
    const visible = await chatGeometry(chatWindow);
    await chatWindow.screenshot({ path: testInfo.outputPath("scope-notice-visible.png") });
    await chatWindow.getByRole("button", { name: "OK", exact: true }).click();
    await expectScope(request, fixture.root, fixture.chat.id, "files", ["docs/guide.ts"]);
    await expect(chatWindow.getByRole("status").filter({ hasText: "guide.ts" })).toHaveCount(0);
    await expect(chatWindow.locator(".scope-pill-disconnect")).toBeFocused();
    const dismissed = await chatGeometry(chatWindow);
    await testInfo.attach("scope-notice-layout", {
      body: JSON.stringify({ locale, visible, dismissed }),
      contentType: "application/json",
    });
    expectUsableConversation(dismissed);
    expect(dismissed.logHeight).toBeGreaterThan(visible.logHeight);
    expectUsableConversation(visible);
  });
}

test("@smoke file-scope notice keeps an unbroken filename readable without horizontal overflow", async ({
  page,
  request,
}) => {
  const fixture = await createScopeChat(request);
  const filename = "customeronboardingauthorizationvalidationevidenceguide.ts";
  const relativePath = `docs/${filename}`;
  writeFileSync(join(fixture.root, relativePath), "export const authorized = true;\n");
  await seedConnectedWindows(page, fixture.root, fixture.chat, { width: 480, height: 480 });
  await page.goto("/");
  const { files, chatWindow, pill } = scopeViews(page);
  await expectScope(request, fixture.root, fixture.chat.id, "workspace-root", []);
  await files.locator('.tr-dir-enter[data-path="docs"]').click();
  await expectScope(request, fixture.root, fixture.chat.id, "directory", ["docs"]);
  await files.locator(`.tr-file[data-path="${relativePath}"]`).click();
  await expectScope(request, fixture.root, fixture.chat.id, "files", [relativePath]);
  const status = chatWindow.locator('[data-scope-notice] [role="status"]');
  await expect(status).toHaveText(`The connected scope changed to File: ${filename}.`);
  await expect(pill).toContainText(filename);
  await expect(pill.locator("[title]").first()).toHaveAttribute(
    "title",
    `${fixture.root}/${relativePath}`,
  );
  for (const element of [status, chatWindow.locator(".chat-scope-header")]) {
    expect(
      await element.evaluate((node) => node.scrollWidth - node.clientWidth),
    ).toBeLessThanOrEqual(1);
  }
  await expect(chatWindow.getByRole("button", { name: "Keep folder", exact: true })).toBeVisible();
  await expect(chatWindow.getByRole("button", { name: "OK", exact: true })).toBeVisible();
  expectUsableConversation(await chatGeometry(chatWindow));
});

for (const size of [
  { width: 480, height: 480, locale: "en" },
  { width: 480, height: 480, locale: "de" },
  { width: 620, height: 640, locale: "en" },
  { width: 780, height: 820, locale: "en" },
]) {
  test(`@smoke connected grounding header preserves usable conversation at ${String(size.width)}px ${size.locale}`, async ({
    page,
    request,
  }) => {
    const fixture = await createScopeChat(request);
    await seedConnectedWindows(page, fixture.root, fixture.chat, size);
    await page.addInitScript((locale) => {
      localStorage.setItem("keiko.locale", locale);
    }, size.locale);
    await page.goto("/");
    const chat = page.getByRole("region", { name: "Chat — Scope narrowing" });
    const help = chat.getByTestId("grounding-help");
    await expect(help).toContainText(
      size.locale === "de"
        ? "kennzeichnet allgemeines Wissen als eigene Einschätzung"
        : "labels general knowledge as its own assessment",
    );
    await expect(chat.locator(".scope-grounding-select")).toBeVisible();
    await expect(chat.locator(".scope-pill")).toBeVisible();
    expectUsableConversation(await chatGeometry(chat));
    expect(await storedScopes(request, fixture.root, fixture.chat.id)).toEqual([
      { kind: "workspace-root", relativePaths: [] },
    ]);
  });
}
