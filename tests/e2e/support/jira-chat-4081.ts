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
  readonly chats: Readonly<Record<"approval" | "revocation" | "unavailable", Chat>>;
  readonly jiraBaseUrl: string;
}
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
): Promise<Locator> {
  const state = fixture();
  const chat = state.chats[name];
  await page.addInitScript(
    ({ id, title }) => {
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
    { id: chat.id, title: chat.title },
  );
  const fragment = encodeCodingAppSessionPairingFragment(
    mintLauncherPairingAttestation({
      secret: state.secret,
      requestId: randomUUID(),
      issuedAtMs: Date.now(),
    }),
  );
  await page.goto(`/${fragment}`);
  const region = page.getByRole("region", { name: new RegExp(`Jira browser ${name}`, "u") });
  await expect(region.getByRole("textbox", { name: "Chat message", exact: true })).toBeVisible();
  return region;
}

export async function createAndConnect(page: Page, region: Locator, name: string): Promise<void> {
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  const hub = page.getByRole("region", { name: /Local Knowledge/u });
  await hub.getByRole("button", { name: "Create Jira Pod", exact: true }).click();
  const form = hub.getByTestId("acx-add-form");
  await form.getByLabel("Label", { exact: true }).fill(name);
  await form.getByLabel("Base URL", { exact: true }).fill(fixture().jiraBaseUrl);
  await form.getByLabel("API token", { exact: true }).fill("synthetic-jira-browser-fixture-pat");
  await form.getByRole("button", { name: "Save connector", exact: true }).click();
  const card = hub.getByTestId("acx-connector").filter({ hasText: name });
  await card.getByRole("button", { name: "Verify connection", exact: true }).click();
  await expect(card.locator('[data-status="ok"]')).toBeVisible();
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  await region.getByText("Jira connection", { exact: true }).click();
  await region.getByRole("combobox", { name: /^Jira Pod/u }).selectOption({ label: name });
  await region.getByRole("button", { name: "Apply Jira settings", exact: true }).click();
  await expect(region.getByText("Jira Pod connected by the server", { exact: true })).toBeVisible();
  await region.getByText("Jira connection", { exact: true }).click();
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
