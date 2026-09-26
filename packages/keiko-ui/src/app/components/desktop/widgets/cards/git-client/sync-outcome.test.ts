// Every settled sync/push result must reach the user as translated text with an honest severity.
// The taxonomies are read from the CONTRACT's own exported lists, so a member added there without a
// presentation row fails here rather than silently rendering a raw wire token in the success pill.

import { describe, expect, it } from "vitest";
import { GIT_SYNC_OUTCOMES } from "@oscharko-dev/keiko-contracts/runtime/git-sync";
import { translate, loadLocaleMessages, type I18nTranslate } from "@/lib/i18n";
import { DE_MESSAGES } from "@/lib/i18n-messages.de";
import type { GitDeliveryMutationStatus } from "@/lib/api";
import { pushOutcomePresentation, syncOutcomePresentation } from "./sync-outcome";

const MUTATION_STATUSES: readonly GitDeliveryMutationStatus[] = [
  "succeeded",
  "blocked",
  "approval-required",
  "failed",
  "recovery-required",
];

const OK_SYNC_OUTCOMES = new Set(["succeeded", "up-to-date"]);

// Every wire token in these taxonomies is either a single English word that reads as prose
// ("succeeded", "failed") or a hyphenated machine token. Only the hyphenated shape is unmistakably a
// leaked token, so that is what the rendered message must never contain.
const MACHINE_TOKEN = /\b[a-z]+(?:-[a-z]+)+\b/u;

function translator(locale: "en" | "de"): I18nTranslate {
  return (key, values) => translate(locale, key, values);
}

describe("syncOutcomePresentation", () => {
  const t = translator("en");

  it("renders every contract outcome as translated text, never as the wire token", () => {
    for (const outcome of GIT_SYNC_OUTCOMES) {
      const view = syncOutcomePresentation("Pull", outcome, t);
      expect(view.message.startsWith("Pull: ")).toBe(true);
      expect(view.message).not.toMatch(MACHINE_TOKEN);
      // A missing catalog entry would surface as the key itself.
      expect(view.message).not.toContain("gitClientWindow.");
    }
  });

  it("marks exactly the two settled-OK outcomes as not failed", () => {
    for (const outcome of GIT_SYNC_OUTCOMES) {
      expect(syncOutcomePresentation("Fetch", outcome, t).failed).toBe(
        !OK_SYNC_OUTCOMES.has(outcome),
      );
    }
  });

  it("translates the outcome into German as well", async () => {
    // The German catalog is loaded lazily; force it in before asserting on the German rendering.
    await loadLocaleMessages("de");
    const view = syncOutcomePresentation("Pullen", "remote-unavailable", translator("de"));
    expect(view.message).toContain(DE_MESSAGES["gitClientWindow.sync.result.remoteUnavailable"]);
    expect(view.failed).toBe(true);
  });
});

describe("pushOutcomePresentation", () => {
  const t = translator("en");

  function outcome(
    status: GitDeliveryMutationStatus,
    extra: Readonly<Record<string, string>> = {},
  ): Parameters<typeof pushOutcomePresentation>[1] {
    return { schemaVersion: "1", status, actionKind: "push", ...extra };
  }

  it("renders every mutation status as translated text, never as the wire token", () => {
    for (const status of MUTATION_STATUSES) {
      const view = pushOutcomePresentation("Push", outcome(status), t);
      expect(view.message).not.toMatch(MACHINE_TOKEN);
      expect(view.message).not.toContain("gitClientWindow.");
      expect(view.failed).toBe(status !== "succeeded");
    }
  });

  it("appends the rejection reason and the recovery hint for a rejected push", () => {
    const view = pushOutcomePresentation(
      "Push",
      outcome("failed", {
        publishRejectionReason: "remote-unavailable",
        recoveryDisposition: "retryable",
        recoveryActionHint: "retry",
      }),
      t,
    );
    expect(view.failed).toBe(true);
    expect(view.message).toContain("could not be reached");
    expect(view.message).toContain("Try again.");
    expect(view.message).not.toContain("remote-unavailable");
    expect(view.message).not.toContain("retry");
  });

  it("degrades an unknown rejection reason to the generic sentence instead of printing it", () => {
    const view = pushOutcomePresentation(
      "Push",
      outcome("failed", { publishRejectionReason: "some-future-reason" }),
      t,
    );
    expect(view.message).toContain("rejected the push");
    expect(view.message).not.toContain("some-future-reason");
  });

  it("drops an unrecognized recovery hint rather than leaking it", () => {
    const view = pushOutcomePresentation(
      "Push",
      outcome("failed", { recoveryActionHint: "reboot-the-universe" }),
      t,
    );
    expect(view.message).not.toContain("reboot-the-universe");
  });

  it("adds no rejection detail to a successful push", () => {
    const view = pushOutcomePresentation(
      "Push",
      outcome("succeeded", { publishRejectionReason: "non-fast-forward" }),
      t,
    );
    expect(view.failed).toBe(false);
    expect(view.message).toBe("Push: succeeded");
  });
});
