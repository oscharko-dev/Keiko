import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JIRA_EXISTING_LINKS_MISSING_MESSAGE } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { JiraChatTools } from "./JiraChatTools";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";

// #4357 R08 (acceptance walk): the card of a write Keiko's own field check refused read the model's
// instruction ("The field named in fieldId is required: ... jira.create-fields ...") next to the closed
// sentence. A person reads the field by the name Jira shows, in their language; the model's sentence
// stays in the result for the model only.
const MODEL_SENTENCES = [
  "The field named in fieldId is required: send a value for it as jira.create-fields or jira.edit-fields lists it. This write was not made.",
  "The field named in fieldId cannot be set through Keiko: leave it out if it is optional. If it is required, tell the user the issue has to be created in Jira. This write was not made.",
  "The value sent for the field named in fieldId does not fit its type: send it as jira.create-fields or jira.edit-fields lists it. This write was not made.",
  "The operation sent for the field named in fieldId is not offered for it: use one the field list shows. This write was not made.",
] as const;
const REASONS = [
  "required-field",
  "unsupported-field",
  "invalid-field",
  "invalid-operation",
] as const;

function refused(
  tool: string,
  validation: (typeof REASONS)[number],
  fieldName: string | undefined,
): ChatToolExchange {
  const index = REASONS.indexOf(validation);
  return {
    call: { id: "refusal-1", name: tool, arguments: {} },
    result: {
      schemaVersion: 1,
      invocationId: "invocation-1",
      toolRef: null,
      projectionDigest: null,
      effectStarted: false,
      metrics: { inputBytes: 10, outputBytes: 10, resultCount: 0, durationMs: 20 },
      status: "failed",
      reason: "provider-reported-error",
      page: null,
      data: {
        outcome: "failed",
        reason: "field-validation",
        fieldId: "resolution",
        validation,
        ...(fieldName === undefined ? {} : { fieldName }),
        messages: [MODEL_SENTENCES[index] ?? ""],
        guidance: "Model-facing guidance that the person never reads.",
      },
    } as NonNullable<ChatToolExchange["result"]>,
  };
}

async function show(exchange: ChatToolExchange, locale: "en" | "de"): Promise<HTMLElement> {
  await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
  localStorage.setItem(I18N_STORAGE_KEY, locale);
  const { container } = render(
    <I18nProvider>
      <JiraChatTools
        transcript={{ schemaVersion: 1, exchanges: [exchange] }}
        turnState="completed"
      />
    </I18nProvider>,
  );
  return container;
}
function expectNoModelText(): void {
  const text = document.body.textContent;
  for (const leaked of [
    "fieldId",
    "jira.create-fields",
    "jira.edit-fields",
    "send a value",
    "Model-facing guidance",
    "field list shows",
  ])
    expect(text, leaked).not.toContain(leaked);
}

describe("a refusal of Keiko's own field check names the field, never a parameter or a tool", () => {
  const EN: Readonly<Record<(typeof REASONS)[number], string>> = {
    "required-field": "The Jira field “Resolution” is required, but no value was given for it.",
    "unsupported-field": "The Jira field “Resolution” cannot be filled from Keiko.",
    "invalid-field": "The value for the Jira field “Resolution” is not one Jira accepts.",
    "invalid-operation": "This change is not possible for the Jira field “Resolution”.",
  };
  const DE: Readonly<Record<(typeof REASONS)[number], string>> = {
    "required-field":
      "Das Jira-Feld „Resolution“ ist ein Pflichtfeld, aber es wurde kein Wert dafür angegeben.",
    "unsupported-field": "Das Jira-Feld „Resolution“ lässt sich von Keiko aus nicht ausfüllen.",
    "invalid-field": "Der Wert für das Jira-Feld „Resolution“ ist keiner, den Jira akzeptiert.",
    "invalid-operation": "Diese Änderung ist für das Jira-Feld „Resolution“ nicht möglich.",
  };

  it.each(REASONS)("names the field in English for %s", async (reason) => {
    await show(refused("jira_transition", reason, "Resolution"), "en");
    expect(screen.getByText(EN[reason])).toBeVisible();
    expect(screen.getByText("Nothing was sent to Jira.")).toBeVisible();
    expectNoModelText();
  });

  it.each(REASONS)("names the field in German for %s and passes axe", async (reason) => {
    const container = await show(refused("jira_transition", reason, "Resolution"), "de");
    expect(screen.getByText(DE[reason])).toBeVisible();
    expectNoModelText();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("covers the edit and the create tools the same way", async () => {
    for (const tool of ["jira_edit", "jira_create"]) {
      const { unmount } = render(<></>);
      unmount();
      await show(refused(tool, "required-field", "Resolution"), "en");
      expect(screen.getAllByText(EN["required-field"]).length).toBeGreaterThan(0);
      expectNoModelText();
      document.body.innerHTML = "";
    }
  });

  it("falls back to the closed sentence without a name, still without the model's text", async () => {
    await show(refused("jira_transition", "required-field", undefined), "en");
    expect(screen.getByText("A required Jira field was missing.")).toBeVisible();
    expectNoModelText();
  });
});

// #4357: a draft item that already exists without every requested link tells the person what to do,
// not the model's instruction to call jira.edit.
describe("an existing draft item that lacks a requested link", () => {
  function row(): ChatToolExchange {
    const base = refused("jira_draft", "required-field", undefined);
    const result = base.result as NonNullable<ChatToolExchange["result"]>;
    return {
      ...base,
      result: {
        ...result,
        data: {
          outcome: "partial",
          reason: "conflict",
          items: [
            {
              ref: "one",
              state: "failed",
              reason: "conflict",
              messages: [JIRA_EXISTING_LINKS_MISSING_MESSAGE],
            },
          ],
        },
      } as NonNullable<ChatToolExchange["result"]>,
    };
  }
  it("says it in English without the model's text", async () => {
    await show(row(), "en");
    expect(
      screen.getByText(
        "This issue was already created, but not every requested link is on it. Nothing was sent again. Add the missing links in Jira or ask Keiko to add them.",
      ),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain("jira.edit");
    expect(document.body.textContent).not.toContain("add only the missing links");
  });
  it("says it in German and passes axe", async () => {
    const container = await show(row(), "de");
    expect(
      screen.getByText(
        "Dieser Vorgang wurde schon angelegt, aber nicht alle gewünschten Verknüpfungen sind daran. Es wurde nichts noch einmal gesendet. Ergänze die fehlenden Verknüpfungen in Jira oder bitte Keiko darum.",
      ),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain("jira.edit");
    expect(await axe(container)).toHaveNoViolations();
  });
});
