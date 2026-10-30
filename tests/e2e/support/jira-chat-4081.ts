import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type Locator } from "@playwright/test";
import type { Chat, ChatMessage } from "@oscharko-dev/keiko-contracts/bff-wire";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session-pairing";
import { mintLauncherPairingAttestation } from "../../../packages/keiko-server/src/coding-app-session/launcherSessionPairingPort.js";

export interface JiraBrowserFixture {
  readonly secret: string;
  readonly projectPath: string;
  readonly chats: Readonly<
    Record<
      "approval" | "revocation" | "unavailable" | "accessibility-en" | "accessibility-de",
      Chat
    >
  >;
  readonly jiraBaseUrl: string;
}
export type JiraBrowserLocale = "en" | "de";
export const JIRA_BROWSER_COPY = {
  en: {
    hub: "Local Knowledge",
    create: "Create Jira Pod",
    label: "Label",
    url: "Base URL",
    token: "API token",
    save: "Save connector",
    verify: "Verify connection",
    connection: "Tool access",
    pod: "Jira Pod",
    apply: "Apply tool settings",
    connected: "Jira Pod connected by the server",
    message: "Chat message",
    send: "Send message",
  },
  de: {
    hub: "Lokales Wissen",
    create: "Jira-Pod erstellen",
    label: "Bezeichnung",
    url: "Basis-URL",
    token: "API-Token",
    save: "Connector speichern",
    verify: "Verbindung prüfen",
    connection: "Tool-Zugriff",
    pod: "Jira-Pod",
    apply: "Tool-Einstellungen anwenden",
    connected: "Jira-Pod vom Server verbunden",
    message: "Chatnachricht",
    send: "Nachricht senden",
  },
} as const;
export interface JiraFixtureCounts {
  readonly models: number;
  readonly jiraRequests: number;
  readonly projects: number;
  readonly writes: number;
  readonly confirmations: number;
  readonly denied: number;
  readonly leaks: number;
}
function statePath(file: string): string {
  const directory = process.env.KEIKO_E2E_JIRA_STATE;
  if (directory === undefined) throw new TypeError("Missing Jira browser fixture directory");
  return join(directory, file);
}
export function fixture(): JiraBrowserFixture {
  return JSON.parse(readFileSync(statePath("fixture.json"), "utf8")) as JiraBrowserFixture;
}
export function counts(): JiraFixtureCounts {
  return JSON.parse(readFileSync(statePath("metrics.json"), "utf8")) as JiraFixtureCounts;
}

export async function openJiraChat(
  page: Page,
  name: keyof JiraBrowserFixture["chats"],
  locale: JiraBrowserLocale = "en",
): Promise<Locator> {
  const state = fixture();
  const chat = state.chats[name];
  await page.addInitScript(
    ({ id, title, locale }) => {
      window.localStorage.setItem("keiko.locale", locale);
      window.localStorage.setItem(
        "keiko.workspace.v4",
        JSON.stringify([
          {
            id: "jira-fixture-chat",
            type: "chat",
            x: 32,
            y: 30,
            w: 1000,
            h: 900,
            z: 10,
            cfg: { chatId: id, title },
            max: false,
          },
        ]),
      );
      window.localStorage.removeItem("keiko.conns.v1");
    },
    { id: chat.id, title: chat.title, locale },
  );
  const fragment = encodeCodingAppSessionPairingFragment(
    mintLauncherPairingAttestation({
      secret: state.secret,
      requestId: randomUUID(),
      issuedAtMs: Date.now(),
    }),
  );
  await page.goto(`/${fragment}`);
  const region = page.locator('section.window[data-window-id="jira-fixture-chat"]');
  await expect(region).toHaveRole("region");
  await expect(region).toHaveAccessibleName(new RegExp(`Jira browser ${name}`, "u"));
  await expect(
    region.getByRole("textbox", { name: JIRA_BROWSER_COPY[locale].message, exact: true }),
  ).toBeVisible();
  return region;
}

interface CreateOptions {
  readonly locale?: JiraBrowserLocale;
  readonly activate?: (control: Locator) => Promise<void>;
  readonly inspectForm?: (form: Locator, hub: Locator) => Promise<void>;
}
export async function createAndConnect(
  page: Page,
  region: Locator,
  name: string,
  options: CreateOptions = {},
): Promise<void> {
  const copy = JIRA_BROWSER_COPY[options.locale ?? "en"];
  const activate = options.activate ?? ((control: Locator): Promise<void> => control.click());
  await activate(page.getByRole("button", { name: copy.hub, exact: true }));
  const hub = page.getByRole("region", { name: new RegExp(copy.hub, "u") });
  await activate(hub.getByRole("button", { name: copy.create, exact: true }));
  const form = hub.getByTestId("acx-add-form");
  await options.inspectForm?.(form, hub);
  await form.getByLabel(copy.label, { exact: true }).fill(name);
  await form.getByLabel(copy.url, { exact: true }).fill(fixture().jiraBaseUrl);
  await form.getByLabel(copy.token, { exact: true }).fill("synthetic-jira-browser-fixture-pat");
  await activate(form.getByRole("button", { name: copy.save, exact: true }));
  const card = hub.getByTestId("acx-connector").filter({ hasText: name });
  await activate(card.getByRole("button", { name: copy.verify, exact: true }));
  await expect(card.locator('[data-status="ok"]')).toBeVisible();
  await activate(page.getByRole("button", { name: copy.hub, exact: true }));
  const connection = region.getByTestId("jira-chat-connection").locator("summary");
  await expect(connection).toHaveAccessibleName(new RegExp(`^${copy.connection}`, "u"));
  await activate(connection);
  await region
    .getByRole("combobox", { name: new RegExp(`^${copy.pod}`, "u") })
    .selectOption({ label: name });
  await activate(region.getByRole("button", { name: copy.apply, exact: true }));
  await expect(region.getByText(copy.connected, { exact: true })).toBeVisible();
  await activate(connection);
}

export async function send(region: Locator, content: string): Promise<void> {
  await region.getByRole("textbox", { name: "Chat message", exact: true }).fill(content);
  await region.getByRole("button", { name: "Send message", exact: true }).click();
}

export async function api(
  page: Page,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const result = await page.evaluate(
    async ({ path: url, method: verb, body: payload }) => {
      const response = await fetch(url, {
        method: verb,
        headers: { "Content-Type": "application/json", "X-Keiko-CSRF": "1" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const value: unknown = await response.json();
      return { status: response.status, body: value };
    },
    { path, method, body },
  );
  return result;
}

export async function messages(page: Page, chatId: string): Promise<readonly ChatMessage[]> {
  const result = await api(
    page,
    `/api/chats/messages?chatId=${encodeURIComponent(chatId)}&projectPath=${encodeURIComponent(fixture().projectPath)}`,
  );
  expect(result.status).toBe(200);
  return (result.body as { messages: readonly ChatMessage[] }).messages;
}

export async function currentChat(page: Page, chatId: string): Promise<Chat> {
  const result = await api(
    page,
    `/api/chats?projectPath=${encodeURIComponent(fixture().projectPath)}&id=${encodeURIComponent(chatId)}`,
  );
  expect(result.status).toBe(200);
  const chat = (result.body as { chats: readonly Chat[] }).chats.find((item) => item.id === chatId);
  if (chat === undefined) throw new Error("Missing authoritative Chat snapshot");
  return chat;
}
