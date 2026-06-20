import { expect, test, type Page } from "@playwright/test";

function collectPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return () => {
    expect(errors).toEqual([]);
  };
}

function chatModel(id: string): Record<string, unknown> {
  return {
    id,
    kind: "chat",
    contextWindow: 8192,
    maxOutputTokens: 1024,
    toolCalling: true,
    structuredOutput: true,
    streaming: true,
    supportsImageInput: false,
    supportsDocumentInput: true,
    workflowEligible: true,
    costClass: "low",
    latencyClass: "fast",
    throughputHint: "E2E dropdown tooltip fixture.",
    preferredUseCases: ["Dropdown tooltip regression"],
    knownLimitations: [],
  };
}

async function mockModelList(page: Page): Promise<void> {
  await page.route("**/api/models", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        models: [
          chatModel("e2e-chat-model"),
          chatModel("gpt-3.5-turbo-0125"),
          chatModel("gpt-4o-mini-search-preview-2025-03-11"),
          chatModel("gpt-4o-2024-08-06"),
        ],
      }),
    });
  });
}

async function openChatModelDropdown(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New chat" }).click();
  await page
    .getByRole("dialog", { name: "New Chat window" })
    .getByRole("button", { name: "Open Chat" })
    .click();
  const chatWindow = page.getByRole("region", { name: /Chat/u }).first();
  await expect(chatWindow).toBeVisible();

  const modelPicker = chatWindow.getByRole("combobox", { name: "Models" });
  await expect(modelPicker).toBeVisible();
  await modelPicker.click();
}

async function expectTooltipOffsetFromOption(page: Page, optionName: string): Promise<void> {
  const longOption = page.getByRole("option", { name: optionName });
  await expect(longOption).toBeVisible();
  await longOption.hover({ position: { x: 6, y: 6 } });
  await expect(page.getByRole("tooltip")).toHaveText(optionName, { timeout: 2_500 });

  const tooltipBox = await page.getByRole("tooltip").boundingBox();
  const optionBox = await longOption.boundingBox();
  expect(tooltipBox).not.toBeNull();
  expect(optionBox).not.toBeNull();
  if (tooltipBox !== null && optionBox !== null) {
    const horizontalGap = tooltipBox.x - (optionBox.x + optionBox.width);
    const verticalGap = optionBox.y - (tooltipBox.y + tooltipBox.height);
    expect(horizontalGap).toBeGreaterThanOrEqual(6);
    expect(verticalGap).toBeGreaterThanOrEqual(4);
  }
}

test("model dropdown overflow tooltips appear from row hover and clear consistently", async ({
  page,
}) => {
  const assertNoPageErrors = collectPageErrors(page);
  await mockModelList(page);
  await openChatModelDropdown(page);
  await expectTooltipOffsetFromOption(page, "gpt-4o-mini-search-preview-2025-03-11");

  const shortOption = page.getByRole("option", { name: "gpt-4o-2024-08-06" });
  await shortOption.hover({ position: { x: 6, y: 6 } });
  await expect(page.getByRole("tooltip")).toBeHidden();

  await expectTooltipOffsetFromOption(page, "gpt-4o-mini-search-preview-2025-03-11");

  await page.mouse.move(1, 1);
  await expect(page.getByRole("tooltip")).toBeHidden();
  assertNoPageErrors();
});
