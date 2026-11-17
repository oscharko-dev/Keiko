import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18N_STORAGE_KEY, I18nProvider, loadLocaleMessages } from "@/lib/i18n";
import type { GitMutationOutcome } from "./git-client-seam";
import { MutationOutcome } from "./git-client-ui";

const SIGNING_FAILURE: GitMutationOutcome = {
  schemaVersion: "1",
  actionKind: "commit",
  status: "recovery-required",
  executionErrorCode: "signature-failed",
};

describe("Git commit signing recovery (#4444)", () => {
  it.each([
    [
      "en",
      "recovery-required",
      /Git could not sign this commit.*signing key \(user\.signingKey\).*signing program.*click Commit again/u,
    ],
    [
      "de",
      "recovery-required",
      /Git konnte diesen Commit nicht signieren.*Signaturschlüssel \(user\.signingKey\).*Signaturprogramm.*erneut auf Commit/u,
    ],
    [
      "en",
      "failed",
      /Git could not sign this commit.*signing key \(user\.signingKey\).*signing program.*click Commit again/u,
    ],
    [
      "de",
      "failed",
      /Git konnte diesen Commit nicht signieren.*Signaturschlüssel \(user\.signingKey\).*Signaturprogramm.*erneut auf Commit/u,
    ],
  ] as const)(
    "announces signing setup and retry guidance in %s for %s",
    async (locale, status, copy) => {
      await loadLocaleMessages(locale);
      window.localStorage.setItem(I18N_STORAGE_KEY, locale);
      render(
        <I18nProvider>
          <MutationOutcome outcome={{ ...SIGNING_FAILURE, status }} error={null} />
        </I18nProvider>,
      );
      const guidance = await screen.findByText(copy);
      expect(guidance).toBeVisible();
      expect(guidance).toBe(screen.getByTestId("git-outcome-headline"));
      expect(guidance).toHaveRole(status === "failed" ? "alert" : "status");
      expect(screen.getByTestId("git-outcome")).not.toHaveTextContent("error: signature-failed");
    },
  );

  it.each([
    { actionKind: "push", status: "recovery-required", executionErrorCode: "signature-failed" },
    { actionKind: "commit", status: "succeeded", executionErrorCode: "signature-failed" },
    { actionKind: "commit", status: "approval-required", executionErrorCode: "signature-failed" },
    { actionKind: "commit", status: "blocked", executionErrorCode: "signature-failed" },
    { actionKind: "commit", status: "failed", executionErrorCode: "network-failure" },
  ] satisfies readonly Omit<GitMutationOutcome, "schemaVersion">[])(
    "preserves other mutation outcomes: $actionKind / $status / $executionErrorCode",
    (outcome) => {
      render(<MutationOutcome outcome={{ schemaVersion: "1", ...outcome }} error={null} />);
      expect(screen.getByTestId("git-outcome")).toHaveTextContent(
        `error: ${outcome.executionErrorCode}`,
      );
      expect(screen.getByTestId("git-outcome")).not.toHaveTextContent("signing key");
    },
  );

  it("keeps a transport error authoritative over a stale signing result", () => {
    render(<MutationOutcome outcome={SIGNING_FAILURE} error="Synthetic transport error" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Synthetic transport error");
    expect(screen.queryByText(/signing key/u)).toBeNull();
  });
});
