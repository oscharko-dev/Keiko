import { expect, test } from "@playwright/test";

async function createNamedChat(page: import("@playwright/test").Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.getByRole("textbox", { name: "Title" }).fill(title);
  await page.getByRole("button", { name: "Open Chat" }).click();
  await expect(page.getByRole("region", { name: `Chat — ${title}` })).toBeVisible();
}

test("New chat creates independent user-titled conversations", async ({ page }) => {
  await page.goto("/");

  await createNamedChat(page, "Lifecycle A");
  await createNamedChat(page, "Lifecycle B");

  await page.getByRole("button", { name: "Chat History", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Active 2" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Lifecycle A /u })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Lifecycle B /u })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rename Lifecycle A" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rename Lifecycle B" })).toBeVisible();
});
