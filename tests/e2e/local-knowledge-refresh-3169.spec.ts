import { expect, test } from "@playwright/test";

async function expectEmptyKnowledgeIndex(page: import("@playwright/test").Page): Promise<void> {
  const surface = page.getByRole("region", { name: "Local Knowledge" });
  await expect(surface.getByRole("heading", { name: "Knowledge Pods", level: 1 })).toBeVisible();
  await expect(surface.getByText("0 Knowledge Pods", { exact: true })).toBeVisible();
  await expect(surface.getByText("No Knowledge Pods yet", { exact: true })).toBeVisible();
  await expect(
    surface.getByRole("button", { name: "Create your first Knowledge Pod" }),
  ).toBeVisible();
}

test("reopening Local Knowledge reloads a truthful empty index", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  await expectEmptyKnowledgeIndex(page);

  await page.getByRole("button", { name: "Close Local Knowledge window" }).click();
  await page.getByRole("button", { name: "Local Knowledge", exact: true }).click();
  await expectEmptyKnowledgeIndex(page);
});
