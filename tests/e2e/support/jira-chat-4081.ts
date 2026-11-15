import { workspaceStorageArgs } from "./workspace-storage.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type Locator } from "@playwright/test";
import type { Chat, ChatMessage } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { AtlassianCredentialPublicMetadata } from "@oscharko-dev/keiko-contracts";
import { encodeCodingAppSessionPairingFragment } from "@oscharko-dev/keiko-contracts/runtime/coding-app-session-pairing";
import { mintLauncherPairingAttestation } from "../../../packages/keiko-server/src/coding-app-session/launcherSessionPairingPort.js";

export interface JiraBrowserFixture {
  readonly secret: string;
  readonly projectPath: string;
  readonly chats: Readonly<
    Record<
      | "approval"
      | "revocation"
      | "pending-stop"
      | "unavailable"
      | "accessibility-en"
      | "accessibility-de"
      | "backlog"
      | "deadline"
      | "batch-reload-en"
      | "batch-reload-de",
      Chat
    >
  >;
  readonly jiraBaseUrl: string;
  readonly backlogPod: {
    readonly id: string;
    readonly name: string;
    readonly criteria: readonly string[];
  };
}
export type JiraBrowserLocale = "en" | "de";
export const JIRA_BROWSER_COPY = {
  en: {
    hub: "Local Knowledge",
    create: "Create Jira Pod",
    label: "Label",
    url: "Base URL",
    token: "API token",
    verify: "Verify connection",
    more: "More actions:",
    connectors: "Connectors",
    access: "Access",
    askForApproval: "Ask for approval",
    message: "Chat message",
    send: "Send message",
  },
  de: {
    hub: "Lokales Wissen",
    create: "Jira Pod erstellen",
    label: "Bezeichnung",
    url: "Basis-URL",
    token: "API-Token",
    verify: "Verbindung prüfen",
    more: "Weitere Aktionen:",
    connectors: "Konnektoren",
    access: "Zugriff",
    askForApproval: "Um Genehmigung bitten",
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
    ({ argument: { id, title, locale }, storageKeys }) => {
      window.localStorage.setItem("keiko.locale", locale);
      window.localStorage.setItem(
        storageKeys.workspace,
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
      window.localStorage.removeItem(storageKeys.connections);
    },
    await workspaceStorageArgs(page, { id: chat.id, title: chat.title, locale }),
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

async function assertCreatedPodVerified(
  page: Page,
  card: Locator,
  name: string,
  copy: (typeof JIRA_BROWSER_COPY)[JiraBrowserLocale],
  response: Awaited<ReturnType<Page["waitForResponse"]>>,
  activate: (control: Locator) => Promise<void>,
): Promise<void> {
  expect(response.status()).toBe(200);
  const verified = (await response.json()) as { readonly authRef: string; readonly status: string };
  expect(verified.status).toBe("ok");
  const result = await api(page, "/api/atlassian-connectors/credentials");
  expect(result.status).toBe(200);
  const { credentials } = result.body as {
    readonly credentials: readonly AtlassianCredentialPublicMetadata[];
  };
  const credential = credentials.find((item) => item.authRef === verified.authRef);
  expect(credential?.displayName).toBe(name);
  if (credential?.authScheme !== "bearer-pat" || credential.livePod === undefined) {
    throw new Error("Created Jira Pod is missing canonical verification metadata");
  }
  expect(credential.livePod.verificationStatus).toBe("ok");
  expect(credential.livePod.verificationRevision).toBeGreaterThan(0);
  expect(credential.livePod.verificationInProgress).toBe(false);
  // The healthy embedded card keeps its secondary Verify action in the menu, without a chip.
  await activate(card.getByRole("button", { name: `${copy.more} ${name}`, exact: true }));
  const verify = card.getByRole("menuitem", { name: copy.verify, exact: true });
  await expect(verify).toBeVisible();
  await verify.press("Escape");
  await expect(card.getByTestId("acx-pod-state")).toHaveCount(0);
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
  const verification = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /^\/api\/atlassian-connectors\/credentials\/[^/]+\/verify$/u.test(
        new URL(response.url()).pathname,
      ),
  );
  await activate(form.getByRole("button", { name: copy.create, exact: true }));
  const card = hub.getByTestId("acx-connector").filter({ hasText: name });
  await assertCreatedPodVerified(page, card, name, copy, await verification, activate);
  await activate(page.getByRole("button", { name: copy.hub, exact: true }));
  await activate(connectorsTrigger(region, options.locale ?? "en"));
  const pod = connectorsPanel(page, options.locale ?? "en").getByRole("switch", {
    name,
    exact: true,
  });
  await activate(pod);
  await expect(pod).toHaveAttribute("aria-checked", "true");
  await closeConnectors(region, options.locale ?? "en");
}

/** The composer's connector trigger; its name carries the active count once any is on. */
export function connectorsTrigger(region: Locator, locale: JiraBrowserLocale = "en"): Locator {
  return region.getByRole("button", {
    name: new RegExp(`^${JIRA_BROWSER_COPY[locale].connectors}(?::|$)`, "u"),
  });
}

/** The connector panel is portaled to the document body, outside the Chat window. */
export function connectorsPanel(page: Page, locale: JiraBrowserLocale = "en"): Locator {
  return page.getByRole("region", { name: JIRA_BROWSER_COPY[locale].connectors, exact: true });
}

/** Escape closes the panel and returns focus to its trigger. */
export async function closeConnectors(
  region: Locator,
  locale: JiraBrowserLocale = "en",
): Promise<void> {
  const trigger = connectorsTrigger(region, locale);
  if ((await trigger.getAttribute("aria-expanded")) === "true") {
    await trigger.press("Escape");
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
}

/**
 * Chat tool use defaults to Full access, where a Jira write runs without a card. Journeys that
 * prove the exact-action approval first select "Ask for approval", the mode that asks for writes.
 */
export async function selectAskForApproval(
  page: Page,
  region: Locator,
  locale: JiraBrowserLocale = "en",
  activate: (control: Locator) => Promise<void> = (control) => control.click(),
): Promise<void> {
  const copy = JIRA_BROWSER_COPY[locale];
  await activate(connectorsTrigger(region, locale));
  const ask = connectorsPanel(page, locale)
    .getByRole("radiogroup", { name: copy.access, exact: true })
    .getByRole("radio", { name: copy.askForApproval, exact: true });
  await activate(ask);
  await expect(ask).toHaveAttribute("aria-checked", "true");
  await closeConnectors(region, locale);
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
