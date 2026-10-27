import assert from "node:assert/strict";

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
  await chat.getByRole("button", { name: "Apply Jira settings", exact: true }).waitFor();
  assert.equal(await page.locator(".conn-path:not(.conn-temp)").count(), 0);
  const selected = await chat.getByRole("combobox", { name: /^Jira Pod/u }).inputValue();
  assert.ok(selected.length > 0);
  return async () => {
    await page.locator(".conn-path:not(.conn-temp)").waitFor({ state: "attached" });
    assert.equal(await page.locator(".conn-path:not(.conn-temp)").count(), 1);
    const badges = page.locator(".conn-badge");
    if (await badges.count())
      assert.equal(await badges.getAttribute("aria-label"), "Remove connection: uses tools");
  };
}
