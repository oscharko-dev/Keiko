import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { I18N_STORAGE_KEY, I18nProvider } from "@/lib/i18n";

import { FeedbackWindow } from "./FeedbackWindow";
import { FEEDBACK_DE_MESSAGES } from "./feedback-i18n-messages.de";
import { FEEDBACK_EN_MESSAGES } from "./feedback-i18n-messages.en";
import { translateFeedback } from "./feedback-i18n";

describe("feedback feature translations", () => {
  afterEach(() => {
    window.localStorage.removeItem(I18N_STORAGE_KEY);
  });

  it("keeps German keys exactly aligned with the English fallback catalog", () => {
    expect(Object.keys(FEEDBACK_DE_MESSAGES).sort()).toEqual(
      Object.keys(FEEDBACK_EN_MESSAGES).sort(),
    );
    expect(translateFeedback("de", "feedback.security.title")).toBe("Bevor du fortfaehrst");
    expect(translateFeedback("en", "feedback.preview.attachment", { ordinal: 2 })).toBe(
      "Attachment 2",
    );
    expect(translateFeedback("en", "feedback.public.popupBlocked")).toContain("blocked");
    expect(translateFeedback("de", "feedback.public.reservationStatus")).toContain("GitHub");
  });

  it("uses the current global locale when the lazy feedback window opens", () => {
    window.localStorage.setItem(I18N_STORAGE_KEY, "de");
    render(
      <I18nProvider>
        <FeedbackWindow />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Bevor du fortfaehrst" })).toBeVisible();
  });
});
