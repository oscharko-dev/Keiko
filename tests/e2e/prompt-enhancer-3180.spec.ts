import { expect, test } from "@playwright/test";

const AUDITED_DECISION_PROMPT =
  "Bereite eine belastbare Entscheidung über die Einführung eines Wissensmanagement-Tools vor. " +
  "Alternativen, Budget, Nutzerzahl, Entscheidungskriterien und Zeitrahmen sind noch unbekannt.";

const FACTUAL_DECISION_QUESTION =
  "Was war die Entscheidung über die Einführung eines Wissensmanagement-Tools?";

const TRAVEL_COMPOUND_PROMPT =
  "Plane eine Reise nach Japan; berücksichtige Alternativen und eine Entscheidungstabelle für das Budget.";

test.describe("Issue #3180 Prompt Enhancer intent boundaries", () => {
  test("keeps German decision, factual, and travel intents distinct in the real UI", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Prompt Enhancer", exact: true }).click();

    const draft = page.getByRole("textbox", { name: "Raw prompt" });
    const enhance = page.getByRole("button", { name: /Enhance prompt/u });
    const analysis = page.getByLabel("Prompt enhancement analysis");
    const rendered = page.locator(".pe-rendered");

    await draft.fill(AUDITED_DECISION_PROMPT);
    await enhance.click();
    await expect(analysis).toContainText("decision support");
    await expect(rendered).toContainText("You are a decision-support analyst.");
    await expect(rendered).not.toContainText(/travel planner|itinerary|lodging|visa|destination/iu);

    await draft.fill(FACTUAL_DECISION_QUESTION);
    await enhance.click();
    await expect(analysis).toContainText("factual qa");
    await expect(rendered).toContainText("You are a careful, accurate assistant.");
    await expect(rendered).not.toContainText("decision-support analyst");

    await draft.fill(TRAVEL_COMPOUND_PROMPT);
    await enhance.click();
    await expect(analysis).toContainText("decision support");
    await expect(rendered).toContainText("You are an expert travel planner.");
    await expect(rendered).not.toContainText("decision-support analyst");
  });
});
