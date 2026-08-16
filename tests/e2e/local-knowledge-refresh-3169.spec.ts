import { expect, test } from "@playwright/test";

async function expectEmptyKnowledgeIndex(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Knowledge Pods" })).toBeVisible();
  await expect(page.getByText("0 Knowledge Pods", { exact: true })).toBeVisible();
  await expect(page.getByText("No Knowledge Pods yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create your first Knowledge Pod" })).toBeVisible();
}

test("reopening Local Knowledge reloads a truthful empty index", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  await expectEmptyKnowledgeIndex(page);

  await page.getByRole("button", { name: "Close Local Knowledge window" }).click();
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  await expectEmptyKnowledgeIndex(page);
});

