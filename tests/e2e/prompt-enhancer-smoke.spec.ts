// Prompt Enhancer browser smoke (Epic #1307, Issue #1314). Drives the real app path end-to-end:
//   1. the governed BFF route POST /api/prompt-enhancement through the running server, and
//   2. the UI workflow — open the Prompt Enhancer tool window from the palette, enter a draft, run
//      enhancement, and review every governed section (sections, grounding plan, safety, candidate
//      scorecards) plus the model-routing status. The result is reviewed, never executed (AC5).
//
// Tagged @smoke so the Studio browser quality gate exercises it. The default path is
// deterministic-only; model-assisted refinement is covered by package-level tests.

import { expect, test, type Page, type TestInfo } from "@playwright/test";

const MUTATION_HEADERS = { "X-Keiko-CSRF": "1" } as const;

// Every governed Enhanced Prompt section the panel must render for review (AC2).
const GOVERNED_SECTIONS = [
  "Role",
  "Objective",
  "Steps",
  "Constraints",
  "Output schema",
  "Quality criteria",
  "Safety rules",
  "Grounding plan",
  "Safety",
  "Candidate scorecards",
  "Rendered prompt",
] as const;

async function assertGovernedSections(page: Page): Promise<void> {
  for (const heading of GOVERNED_SECTIONS) {
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
  }
  await expect(page.getByText(/Decision:/u).first()).toBeVisible();
}

async function captureEvidence(page: Page, testInfo: TestInfo): Promise<void> {
  const shotPath = process.env.KEIKO_PE_SHOT;
  const shot = await page.screenshot({
    fullPage: true,
    ...(shotPath === undefined ? {} : { path: shotPath }),
  });
  await testInfo.attach("prompt-enhancer-panel", { body: shot, contentType: "image/png" });
}

function collectPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return () => {
    expect(errors).toEqual([]);
  };
}

test.describe("Prompt Enhancer @smoke", () => {
  test("BFF route returns a governed, content-light enhancement", async ({ request }) => {
    const response = await request.post("/api/prompt-enhancement", {
      headers: MUTATION_HEADERS,
      data: { text: "Summarize the quarterly revenue report into three bullet points." },
    });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      schemaVersion: string;
      enhancedPrompt: { role: string; safetyRules: string[] };
      candidates: { scorecards: unknown[] };
      safety: { decision: string };
      modelRouting: { availability: string };
      groundingReadiness: { status: string };
      evidence: { status: string; manifestUrl?: string };
      renderedPrompt: string;
    };
    expect(body.schemaVersion).toBe("1");
    expect(body.enhancedPrompt.role.length).toBeGreaterThan(0);
    expect(body.enhancedPrompt.safetyRules.length).toBeGreaterThan(0);
    expect(body.candidates.scorecards.length).toBeGreaterThan(0);
    expect(["accepted", "requires-human-review", "rejected"]).toContain(body.safety.decision);
    expect(body.modelRouting.availability).toBe("not-requested");
    expect(body.groundingReadiness.status).toBeTruthy();
    expect(body.evidence.status).toBe("recorded");
    expect(body.evidence.manifestUrl).toContain("/api/prompt-enhancement/evidence/");
    expect(body.renderedPrompt).toContain("## Role");
  });

  test("UI workflow: enhance a prompt and review every governed section", async ({
    page,
  }, testInfo) => {
    const assertNoPageErrors = collectPageErrors(page);
    await page.goto("/");

    // Launch the Prompt Enhancer tool window from its Left Rail button (a real product surface).
    await page.getByRole("button", { name: "Prompt Enhancer", exact: true }).click();

    // The first screen is the workflow itself.
    const draft = page.getByRole("textbox", { name: "Raw prompt" });
    await expect(draft).toBeVisible();
    await draft.fill("Design a REST API for a todo application with auth and pagination.");

    await page.getByRole("button", { name: /Enhance prompt/u }).click();

    // Every required governed section renders for review, with a visible safety decision.
    await assertGovernedSections(page);
    await expect(page.getByTestId("pe-grounding-readiness")).toBeVisible();
    await expect(page.getByTestId("pe-evidence")).toContainText(/Manifest:/u);
    await captureEvidence(page, testInfo);

    assertNoPageErrors();
  });
});

test.describe("Prompt Enhancer large prompt @smoke", () => {
  test("UI workflow handles a large prompt without page errors", async ({ page }) => {
    const assertNoPageErrors = collectPageErrors(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Prompt Enhancer", exact: true }).click();
    const draft = page.getByRole("textbox", { name: "Raw prompt" });
    await draft.fill(
      `Summarize this implementation plan.\n${"Scope and constraints. ".repeat(1800)}`,
    );
    await page.getByRole("button", { name: /Enhance prompt/u }).click();
    await assertGovernedSections(page);
    await expect(page.getByTestId("pe-evidence")).toBeVisible();
    assertNoPageErrors();
  });
});
