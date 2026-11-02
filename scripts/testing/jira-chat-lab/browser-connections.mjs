import assert from "node:assert/strict";

/** A Pod's status chip names its state; "Ready" is the verified, usable one. */
export function readyChip(card) {
  return card.getByTestId("acx-pod-state").filter({ hasText: /^Ready$/u });
}

/** The Chat composer's Access radios (owner decision 2026-11-02): one label per autonomy mode. */
const ACCESS_MODE_LABELS = Object.freeze({
  "governed-assist": "Ask for approval",
  "supervised-coding": "Supervised workspace",
  "autonomous-delivery": "Full access",
});

/** The composer's Connectors button; its name carries the active count once any is on. */
function connectorsTrigger(chat) {
  return chat.getByRole("button", { name: /^Connectors(?::|$)/u });
}

/** The panel is portalled to the document body, outside the Chat window. */
function connectorsPanel(page) {
  return page.getByRole("region", { name: "Connectors", exact: true });
}

export async function openConnectors(page, chat) {
  const trigger = connectorsTrigger(chat);
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  const panel = connectorsPanel(page);
  await panel.waitFor();
  return panel;
}

/** Escape closes the panel and returns focus to its trigger. */
export async function closeConnectors(chat) {
  const trigger = connectorsTrigger(chat);
  if ((await trigger.getAttribute("aria-expanded")) === "true") await trigger.press("Escape");
  await trigger.and(trigger.page().locator('[aria-expanded="false"]')).waitFor();
}

/** The Pod's switch is on only after the server confirmed the binding on the Chat. */
export function podSwitch(page, name) {
  return connectorsPanel(page).getByRole("switch", { name, exact: true });
}
export function checked(page, locator) {
  return locator.and(page.locator('[aria-checked="true"]'));
}

/** Switches the named Jira Pod on for this Chat and waits for the server-confirmed state. */
export async function connectPodFromPanel(page, chat, name) {
  await openConnectors(page, chat);
  const pod = podSwitch(page, name);
  if ((await pod.getAttribute("aria-checked")) !== "true") await pod.click();
  await checked(page, pod).waitFor();
  await closeConnectors(chat);
}

/** Selects the Chat's tool mode through the Access radios, as a person would. */
export async function selectAccessMode(page, chat, mode) {
  const label = ACCESS_MODE_LABELS[mode];
  assert.ok(label, "Unsupported Chat tool mode");
  await openConnectors(page, chat);
  const radio = connectorsPanel(page)
    .getByRole("radiogroup", { name: "Access", exact: true })
    .getByRole("radio", { name: label, exact: true });
  if ((await radio.getAttribute("aria-checked")) !== "true") await radio.click();
  await checked(page, radio).waitFor();
  await closeConnectors(chat);
}

/** Confirms, from the open panel, that the Pod is not offered as connected to this Chat. */
export async function assertPodNotConnected(page, chat, name) {
  await openConnectors(page, chat);
  const pod = podSwitch(page, name);
  assert.ok((await pod.count()) === 0 || (await pod.getAttribute("aria-checked")) !== "true");
  await closeConnectors(chat);
}

async function vacantWorkspacePoint(page) {
  return page.locator("main.workspace").evaluate((workspace) => {
    const rect = workspace.getBoundingClientRect();
    for (let y = rect.bottom - 160; y > rect.top + 40; y -= 80) {
      for (let x = rect.right - 160; x > rect.left + 40; x -= 80) {
        const target = globalThis.document.elementFromPoint(x, y);
        if (target?.closest("main.workspace") !== null && target?.closest(".window") === null)
          return { x: x - rect.left, y: y - rect.top };
      }
    }
    throw new TypeError("No visible workspace drop target");
  });
}

async function placeJiraNode(page, method) {
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  const hub = page.getByRole("region", { name: /Local Knowledge/ });
  const card = hub.getByTestId("acx-connector").filter({ hasText: "Browser Jira" });
  const source = card.getByRole("button", { name: "Add to workspace", exact: true });
  if (method === "keyboard") {
    await source.focus();
    await source.press("Enter");
  } else {
    await source.dragTo(page.locator("main.workspace"), {
      targetPosition: await vacantWorkspacePoint(page),
    });
  }
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  const node = page.locator(".window").filter({ hasText: "Live Jira tools" });
  await node.getByText("Verified Jira Pod", { exact: true }).waitFor();
  assert.equal(await node.count(), 1);
  return node;
}

async function arrangeNode(page, node) {
  const header = node.locator("[data-window-header]");
  await header.hover({ position: { x: 40, y: 12 } });
  await page.mouse.down();
  await page.mouse.move(1170, 210, { steps: 8 });
  await page.mouse.up();
}

/** Both accessible keyboard ports and native node dragging must use the same server acknowledgement. */
export async function requestWorkspaceJiraConnection(page, chat, method) {
  const node = await placeJiraNode(page, method);
  await arrangeNode(page, node);
  const from = node.getByRole("button", { name: /^Connect .* from right edge$/u });
  const to = chat.getByRole("button", { name: /^Connect .* from left edge$/u });
  await from.focus();
  await from.press("Enter");
  await chat.and(page.locator('[data-conn="valid"]')).waitFor();
  await to.focus();
  await to.press("Enter");
  // The lasso binds the Pod at once (owner decision 2026-11-02): no apply step remains, so the
  // server-confirmed binding is read from the Chat's own Connectors panel before the edge is checked.
  await openConnectors(page, chat);
  await checked(page, podSwitch(page, "Browser Jira")).waitFor();
  await closeConnectors(chat);
  return async () => {
    await page.locator(".conn-path:not(.conn-temp)").waitFor({ state: "attached" });
    assert.equal(await page.locator(".conn-path:not(.conn-temp)").count(), 1);
    const badges = page.locator(".conn-badge");
    if (await badges.count())
      assert.equal(await badges.getAttribute("aria-label"), "Remove connection: uses tools");
  };
}
