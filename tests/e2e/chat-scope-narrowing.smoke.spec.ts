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
            cfg: { chatId: chat.id, title: chat.title, keepFilesFolder: true },
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
  await expect(chatWindow.getByTestId("grounding-help")).toHaveCount(0);
  await expect(
    chatWindow.getByText(locale === "de" ? "Wissensquellen" : "Sources", { exact: true }),
  ).toBeVisible();
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
  const announcement = chatWindow.getByTestId("connected-scope-announcer");
  await expect(announcement).toHaveText(
    locale === "de"
      ? "Verbundener Scope aktualisiert: 1 Quelle."
      : "Connected scope updated: 1 source.",
  );
  await expect(announcement).toHaveAttribute("aria-live", "polite");
  await expect(chatWindow.locator("[data-scope-notice]")).toHaveCount(0);
  await expect(pill.locator("[title]").first()).toHaveAttribute("title", `${root}/docs/guide.ts`);
  await expect(page.locator(".conn-badge")).toContainText("guide.ts");
  const violations = await runAxe(page, ".chat-scope-header");
  expect(seriousOrCritical(violations), formatViolations(violations)).toEqual([]);
}

async function expectRetiredPinRemoved(page: Page): Promise<void> {
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
    .toBeUndefined();
}

async function switchFilePreview(
  page: Page,
  request: APIRequestContext,
  fixture: ScopeFixture,
): Promise<void> {
  const { root, chat } = fixture;
  const { files, chatWindow, pill } = scopeViews(page);
  await expect(chatWindow.getByRole("button", { name: "Keep folder", exact: true })).toHaveCount(0);
  await expect(chatWindow.getByRole("button", { name: "OK", exact: true })).toHaveCount(0);
  await files.getByRole("button", { name: "Back to files", exact: true }).click();
  await expectScope(request, root, chat.id, "directory", ["docs"]);
  await expect(pill).toContainText("/docs");
  await files.locator('.tr-file[data-path="docs/other.ts"]').click();
  await expect(files.getByRole("region", { name: "File preview: other.ts" })).toBeVisible();
  await expectScope(request, root, chat.id, "files", ["docs/other.ts"]);
  await expect(pill).toContainText("File: other.ts");
  await expect(pill.locator("[title]").first()).toHaveAttribute("title", `${root}/docs/other.ts`);
  await expect(page.locator(".conn-badge")).toContainText("other.ts");
  await expectRetiredPinRemoved(page);
}

async function verifyReloadedVisibleScope(
  page: Page,
  request: APIRequestContext,
  fixture: ScopeFixture,
): Promise<void> {
  await page.reload();
  const { files, chatWindow, pill } = scopeViews(page);
  await expect(pill).toContainText("/docs");
  await expectRetiredPinRemoved(page);
  const folder = files.locator('.tr-dir-enter[data-path="docs"]');
  if (await folder.isVisible()) await folder.click();
  await files.locator('.tr-file[data-path="docs/guide.ts"]').click();
  await expect(files.getByRole("region", { name: "File preview: guide.ts" })).toBeVisible();
  await expectScope(request, fixture.root, fixture.chat.id, "files", ["docs/guide.ts"]);
  await expect(pill).toContainText("File: guide.ts");
  await expect(page.locator(".conn-badge")).toContainText("guide.ts");
  await expect(chatWindow.getByRole("button", { name: "Keep folder", exact: true })).toHaveCount(0);
}

test("Files navigation follows each visible selection and discards restored folder pins @smoke", async ({
  page,
  request,
}, testInfo) => {
  const fixture = await createScopeChat(request);
  await seedConnectedWindows(page, fixture.root, fixture.chat);
  await page.goto("/");
  await openNarrowedPreview(page, request, fixture);
  await switchFilePreview(page, request, fixture);
  await verifyReloadedVisibleScope(page, request, fixture);
  await page.screenshot({ path: testInfo.outputPath("scope-visible-selection.png") });
});

async function expectDraftRecoveryUsable(chat: ReturnType<Page["getByRole"]>): Promise<void> {
  const retry = chat.getByRole("button", {
    name: /Retry draft save|Erneut speichern/u,
  });
  await expect(retry).toBeVisible();
  const warning = chat.getByRole("alert").filter({
    hasText: /Draft not saved|Entwurf nicht gespeichert/u,
  });
  await expect(warning).toBeVisible();
  const geometry = await warning.evaluate((node) => {
    const action = node.querySelector("button")?.getBoundingClientRect();
    const window = node.closest(".window")?.getBoundingClientRect();
    const notice = node.getBoundingClientRect();
    return {
      overflowX: node.scrollWidth - node.clientWidth,
      overflowY: node.scrollHeight - node.clientHeight,
      actionHeight: action?.height ?? 0,
      actionVisible:
        action !== undefined && action.top >= notice.top && action.bottom <= notice.bottom,
      noticeVisible:
        window !== undefined && notice.top >= window.top && notice.bottom <= window.bottom,
    };
  });
  expect(geometry.overflowX).toBeLessThanOrEqual(1);
  expect(geometry.overflowY).toBeLessThanOrEqual(1);
  expect(geometry.actionHeight).toBeGreaterThanOrEqual(24);
  expect(geometry.actionVisible).toBe(true);
  expect(geometry.noticeVisible).toBe(true);
}

async function chatGeometry(chat: ReturnType<Page["getByRole"]>): Promise<{
  readonly headerHeight: number;
  readonly overflowX: number;
  readonly logHeight: number;
  readonly footerBottom: number;
  readonly windowBottom: number;
}> {
  await expectDraftRecoveryUsable(chat);
  return chat.evaluate((node) => {
    const measure = (selector: string): DOMRect => {
      const element = node.querySelector(selector);
      if (element === null) throw new TypeError(`Missing chat surface ${selector}`);
      return element.getBoundingClientRect();
    };
    const header = measure(".chat-scope-header");
    const content = node.querySelector(".chatw");
    if (content === null) throw new TypeError("Missing chat content");
    return {
      headerHeight: header.height,
      overflowX: content.scrollWidth - content.clientWidth,
      logHeight: measure(".chatw-scroll").height,
      footerBottom: measure(".chatw-foot").bottom,
      windowBottom: node.getBoundingClientRect().bottom,
    };
  });
}

function expectUsableConversation(geometry: Awaited<ReturnType<typeof chatGeometry>>): void {
  expect(geometry.overflowX).toBeLessThanOrEqual(1);
  expect(geometry.headerHeight, JSON.stringify(geometry)).toBeLessThan(220);
  expect(geometry.logHeight, JSON.stringify(geometry)).toBeGreaterThan(80);
  expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.windowBottom + 1);
}

for (const locale of ["en", "de"]) {
  test(`@smoke automatic file scope preserves usable conversation at 480px ${locale}`, async ({
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
    const geometry = await chatGeometry(chatWindow);
    await expect(chatWindow.getByRole("button", { name: "OK", exact: true })).toHaveCount(0);
    await expectScope(request, fixture.root, fixture.chat.id, "files", ["docs/guide.ts"]);
    const disconnect = chatWindow.locator(".scope-pill-disconnect");
    await disconnect.focus();
    await expect(disconnect).toBeFocused();
    await chatWindow.screenshot({ path: testInfo.outputPath("scope-automatic-layout.png") });
    await testInfo.attach("scope-automatic-layout", {
      body: JSON.stringify({ locale, geometry }),
      contentType: "application/json",
    });
    expectUsableConversation(geometry);
  });
}

test("@smoke file scope exposes a full unbroken path without horizontal overflow", async ({
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
  await expect(pill).toHaveText(/Folder:|Ordner:/u);
  await expect(chatWindow.getByTestId("grounding-help")).toContainText(
    "The model has no file tools",
  );
  await expectScope(request, fixture.root, fixture.chat.id, "workspace-root", []);
  await files.locator('.tr-dir-enter[data-path="docs"]').click();
  await expectScope(request, fixture.root, fixture.chat.id, "directory", ["docs"]);
  await files.locator(`.tr-file[data-path="${relativePath}"]`).click();
  await expectScope(request, fixture.root, fixture.chat.id, "files", [relativePath]);
  await expect(chatWindow.getByTestId("connected-scope-announcer")).toHaveText(
    "Connected scope updated: 1 source.",
  );
  await expect(pill).toContainText(filename);
  await expect(pill.locator("[title]").first()).toHaveAttribute(
    "title",
    `${fixture.root}/${relativePath}`,
  );
  for (const element of [pill, chatWindow.locator(".chat-scope-header")]) {
    expect(
      await element.evaluate((node) => node.scrollWidth - node.clientWidth),
    ).toBeLessThanOrEqual(1);
  }
  await expect(chatWindow.getByRole("button", { name: "Keep folder", exact: true })).toHaveCount(0);
  await expect(chatWindow.getByRole("button", { name: "OK", exact: true })).toHaveCount(0);
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
    await expect(chat.getByTestId("grounding-help")).toHaveCount(0);
    await expect(
      chat.getByText(size.locale === "de" ? "Wissensquellen" : "Sources", { exact: true }),
    ).toBeVisible();
    await expect(chat.locator(".scope-grounding-select")).toBeVisible();
    await expect(chat.locator(".scope-pill")).toBeVisible();
    expectUsableConversation(await chatGeometry(chat));
    expect(await storedScopes(request, fixture.root, fixture.chat.id)).toEqual([
      { kind: "workspace-root", relativePaths: [] },
    ]);
  });
}
