// RB-6 / ADR-0173 D5 — the chat error banner gains a copyable "Support ID: <id>" line whenever the
// underlying failure carried a correlation id, using the same "{feature}.supportId" i18n key
// pattern already proven at VoiceDictation.tsx, WorkspaceTrustSurfaces.tsx, TaskWorkspaceSwitcher.tsx.

import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import {
  I18N_STORAGE_KEY,
  I18nProvider,
  loadLocaleMessages,
  resetLoadedMessageCatalogs,
} from "@/lib/i18n";
import { ErrorNoticeFromError } from "./ErrorNotice";

afterEach(() => {
  window.localStorage.clear();
  resetLoadedMessageCatalogs();
});

function renderInLocale(error: unknown, locale: "en" | "de"): ReturnType<typeof render> {
  window.localStorage.setItem(I18N_STORAGE_KEY, locale);
  return render(
    <I18nProvider>
      <ErrorNoticeFromError error={error} fallback="Could not send message." />
    </I18nProvider>,
  );
}

describe("ErrorNoticeFromError — correlation support id", () => {
  it("renders the EN support id line for an ApiError carrying a correlationId", () => {
    const error = new ApiError("GATEWAY_TIMEOUT", "GATEWAY_TIMEOUT", 503);
    error.correlationId = "req-en-000123";
    renderInLocale(error, "en");

    expect(screen.getByText("Support ID: req-en-000123")).toBeInTheDocument();
  });

  it("renders the DE support id line for an ApiError carrying a correlationId", async () => {
    await loadLocaleMessages("de");
    const error = new ApiError("GATEWAY_TIMEOUT", "GATEWAY_TIMEOUT", 503);
    error.correlationId = "req-de-000456";
    renderInLocale(error, "de");

    expect(screen.getByText("Support-ID: req-de-000456")).toBeInTheDocument();
  });

  it("omits the support id line entirely when the ApiError carries none", () => {
    renderInLocale(new ApiError("GATEWAY_TIMEOUT", "GATEWAY_TIMEOUT", 503), "en");

    expect(screen.queryByText(/Support ID:/)).not.toBeInTheDocument();
  });

  it("has no axe violations with a support id line rendered", async () => {
    const error = new ApiError("GATEWAY_TIMEOUT", "GATEWAY_TIMEOUT", 503);
    error.correlationId = "req-axe-000789";
    const { container } = renderInLocale(error, "en");

    expect(await axe(container)).toHaveNoViolations();
  });

  // #3241 review — noticeKey used to omit correlationId, so dismissing a notice set a dismissedKey
  // that ALSO matched a later failure with the same title/message/code but a different support id,
  // hiding a genuinely new failure behind a stale dismissal.
  it("shows a later notice with a new correlation id after an identical-looking one was dismissed", () => {
    const first = new ApiError("GATEWAY_TIMEOUT", "GATEWAY_TIMEOUT", 503);
    first.correlationId = "req-dismiss-000111";
    const { rerender } = renderInLocale(first, "en");

    expect(screen.getByText("Support ID: req-dismiss-000111")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByText("Support ID: req-dismiss-000111")).not.toBeInTheDocument();

    const second = new ApiError("GATEWAY_TIMEOUT", "GATEWAY_TIMEOUT", 503);
    second.correlationId = "req-dismiss-000222";
    rerender(
      <I18nProvider>
        <ErrorNoticeFromError error={second} fallback="Could not send message." />
      </I18nProvider>,
    );

    expect(screen.getByText("Support ID: req-dismiss-000222")).toBeInTheDocument();
  });
});
