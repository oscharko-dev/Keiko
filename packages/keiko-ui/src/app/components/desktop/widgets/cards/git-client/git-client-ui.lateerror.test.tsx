import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import type { GitMutationOutcome } from "./git-client-seam";
import { MutationOutcome } from "./git-client-ui";

const LATE_ERROR: GitMutationOutcome = {
  schemaVersion: "1",
  actionKind: "commit",
  status: "succeeded",
  executionNote: "recorded-despite-late-error",
};

describe("Git commit recorded despite a late Git error", () => {
  it.each([
    ["en", /The commit was recorded, although Git reported a late error/u],
    ["de", /Der Commit wurde aufgezeichnet, obwohl Git einen späten Fehler gemeldet hat/u],
  ] as const)("tells the person in %s", async (locale, copy) => {
    await loadLocaleMessages(locale);
    window.localStorage.setItem(I18N_STORAGE_KEY, locale);
    render(
      <I18nProvider>
        <MutationOutcome outcome={LATE_ERROR} error={null} />
      </I18nProvider>,
    );
    expect(await screen.findByText(copy)).toBeVisible();
  });

  it("stays silent for an ordinary success", () => {
    render(
      <MutationOutcome
        outcome={{ schemaVersion: "1", actionKind: "commit", status: "succeeded" }}
        error={null}
      />,
    );
    expect(screen.getByTestId("git-outcome")).not.toHaveTextContent(/late error/iu);
  });
});
