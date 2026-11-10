import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import type { ChatToolTranscript } from "@oscharko-dev/keiko-contracts/bff-wire";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import { JiraChatTools } from "./JiraChatTools";

afterEach(() => localStorage.removeItem(I18N_STORAGE_KEY));

describe.each(["en", "de"] as const)("saved parent-type refusal in %s", (locale) => {
  it("renders the precise rule after reload without inventing an effect or a new approval", async () => {
    await Promise.all([loadLocaleMessages(locale), loadOptionalWidgetMessages(locale)]);
    localStorage.setItem(I18N_STORAGE_KEY, locale);
    const transcript: ChatToolTranscript = {
      schemaVersion: 1,
      exchanges: [
        {
          call: {
            id: "parent-type-refusal",
            name: "jira_create",
            arguments: { projectId: "10000", issueTypeId: "10003" },
          },
          mutationOutcome: "not-dispatched",
          result: {
            schemaVersion: 1,
            invocationId: "parent-type-refusal",
            toolRef: null,
            projectionDigest: null,
            effectStarted: false,
            metrics: { inputBytes: 0, outputBytes: 0, resultCount: 0, durationMs: 0 },
            status: "failed",
            reason: "provider-reported-error",
            page: null,
            data: {
              outcome: "rejected",
              reason: "field-validation",
              violations: [
                {
                  ruleId: "parent-type-mismatch",
                  subject: "parent: Task",
                  template: "SYN/Sub-task",
                },
              ],
            },
          },
        },
      ],
    };
    const restored = JSON.parse(JSON.stringify(transcript)) as ChatToolTranscript;
    const show = (): ReturnType<typeof render> =>
      render(
        <I18nProvider>
          <JiraChatTools transcript={restored} turnState="completed" />
        </I18nProvider>,
      );
    const first = show();
    const previous = first.container.textContent;
    first.unmount();
    const { container } = show();
    expect(container.textContent).toBe(previous);
    expect(
      screen.getByText(
        locale === "en"
          ? "The parent must have an allowed issue type (parent: Task)."
          : "Das übergeordnete Issue muss einen erlaubten Vorgangstyp haben (parent: Task).",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(locale === "en" ? "Not sent to Jira" : "Nicht an Jira gesendet"),
    ).toBeVisible();
    expect(container.querySelector("button, pre, a")).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });
});
