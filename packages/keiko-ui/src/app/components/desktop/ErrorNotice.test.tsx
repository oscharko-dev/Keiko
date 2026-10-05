// RB-6 / ADR-0173 D5 — the chat error banner gains a copyable "Support ID: <id>" line whenever the
// underlying failure carried a correlation id, using the same "{feature}.supportId" i18n key
// pattern already proven at VoiceDictation.tsx and WorkspaceTrustSurfaces.tsx.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  I18N_STORAGE_KEY,
  I18nProvider,
  loadLocaleMessages,
  resetLoadedMessageCatalogs,
} from "@/lib/i18n";
import { canonicalSupportReportFixture } from "@/test-utils/support-report-fixture";
import * as reportApi from "@/lib/support-report-api";
import { resetSupportReportOutcomesForTests } from "./SupportReportButton";
import { ErrorNoticeFromError } from "./ErrorNotice";
import styles from "./ErrorNotice.module.css";

afterEach(() => {
  vi.restoreAllMocks();
  resetSupportReportOutcomesForTests();
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

function errorNoticeLayoutStyle(): HTMLStyleElement {
  const path = ["src/app/globals.css", "packages/keiko-ui/src/app/globals.css"]
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
  if (path === undefined) throw new Error("Missing production stylesheet");
  const css = readFileSync(path, "utf8");
  const start = css.indexOf(".ui-error-notice-title-row {");
  const end = css.indexOf(".ui-error-notice-close:hover", start);
  if (start < 0 || end < 0) throw new Error("Missing production notice layout rules");
  const localCss = readFileSync(
    resolve(dirname(path), "components/desktop/ErrorNotice.module.css"),
    "utf8",
  );
  const style = document.createElement("style");
  // Apply the real module rule with its loader-assigned class in the jsdom stylesheet.
  style.textContent = css.slice(start, end) + localCss.replaceAll(".cmpText", `.${styles.cmpText}`);
  document.head.append(style);
  return style;
}

describe("ErrorNoticeFromError — correlation support id", () => {
  it("prepares a direct download for the support id displayed in the chat error", async () => {
    const report = { fileName: "report.json", reportJson: "{}" };
    const create = vi.spyOn(reportApi, "createSupportReport").mockResolvedValue(report);
    const automaticClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    vi.spyOn(reportApi, "createSupportReportDownload").mockReturnValue({
      href: "blob:report",
      dispose: vi.fn(),
    });
    const error = new ApiError("CLARIFICATION_NEEDED", "Need more context", 400);
    error.correlationId = "chat-search-failed";
    renderInLocale(error, "en");
    fireEvent.click(screen.getByRole("button", { name: "Create error report" }));
    const link = await screen.findByRole("link", { name: "Download report" });
    expect(link).toHaveAttribute("download", report.fileName);
    expect(link).toHaveAttribute("href", "blob:report");
    expect(automaticClick).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith("chat-search-failed", expect.any(AbortSignal), {
      errorKind: "invalid-request",
      context: [],
      errorEvidence: { errorClass: "ApiError", frames: [], causeChain: [] },
    });
  });

  it("selects only the displayed client failure when no trusted Support ID exists", async () => {
    const report = await canonicalSupportReportFixture();
    const create = vi.spyOn(reportApi, "createSupportReport").mockResolvedValue(report);
    vi.spyOn(reportApi, "createSupportReportDownload").mockReturnValue({
      href: "blob:uncorrelated-report",
      dispose: vi.fn(),
    });
    renderInLocale(new ApiError("GATEWAY_TIMEOUT", "Gateway timeout", 503), "en");
    fireEvent.click(screen.getByRole("button", { name: "Create error report" }));
    await screen.findByRole("link", { name: "Download report" });
    expect(create).toHaveBeenCalledWith(
      undefined,
      expect.any(AbortSignal),
      {
        errorKind: "unavailable",
        context: [],
        errorEvidence: { errorClass: "ApiError", frames: [], causeChain: [] },
      },
      "client-only",
    );
  });

  it("isolates identical uncorrelated notices and disposes their own report on dismissal", async () => {
    const report = await canonicalSupportReportFixture();
    const create = vi.spyOn(reportApi, "createSupportReport").mockResolvedValue(report);
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    vi.spyOn(reportApi, "createSupportReportDownload")
      .mockReturnValueOnce({ href: "blob:first-notice", dispose: firstDispose })
      .mockReturnValueOnce({ href: "blob:second-notice", dispose: secondDispose });
    const first = new ApiError("GATEWAY_TIMEOUT", "Same message", 503);
    const second = new ApiError("GATEWAY_TIMEOUT", "Same message", 503);
    render(
      <I18nProvider>
        <ErrorNoticeFromError error={first} fallback="Failed" />
        <ErrorNoticeFromError error={second} fallback="Failed" />
      </I18nProvider>,
    );
    const notices = screen
      .getAllByRole("alert")
      .map((alert) => alert.closest<HTMLElement>(".ui-error-notice"));
    const firstNotice = notices[0];
    const secondNotice = notices[1];
    expect(firstNotice).toBeDefined();
    expect(secondNotice).toBeDefined();
    if (firstNotice == null || secondNotice == null) throw new Error("Missing notices");
    fireEvent.click(within(firstNotice).getByRole("button", { name: "Create error report" }));
    await within(firstNotice).findByRole("link", { name: "Download report" });
    expect(within(secondNotice).queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(within(secondNotice).getByRole("button", { name: "Create error report" }));
    expect(
      await within(secondNotice).findByRole("link", { name: "Download report" }),
    ).toHaveAttribute("href", "blob:second-notice");
    expect(create).toHaveBeenCalledTimes(2);
    fireEvent.click(within(firstNotice).getByRole("button", { name: "Dismiss error" }));
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Download report" })).toHaveAttribute(
      "href",
      "blob:second-notice",
    );
  });

  it("shows and prepares a new occurrence of the same uncorrelated failure after dismissal", async () => {
    const report = await canonicalSupportReportFixture();
    const create = vi.spyOn(reportApi, "createSupportReport").mockResolvedValue(report);
    const dispose = vi.fn();
    vi.spyOn(reportApi, "createSupportReportDownload").mockReturnValue({
      href: "blob:occurrence",
      dispose,
    });
    const view = renderInLocale(new ApiError("GATEWAY_TIMEOUT", "Same message", 503), "en");
    fireEvent.click(screen.getByRole("button", { name: "Create error report" }));
    await screen.findByRole("link", { name: "Download report" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    view.rerender(
      <I18nProvider>
        <ErrorNoticeFromError
          error={new ApiError("GATEWAY_TIMEOUT", "Same message", 503)}
          fallback="Could not send message."
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Create error report" }));
    await screen.findByRole("link", { name: "Download report" });
    expect(create).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("aborts an uncorrelated regeneration and disposes only its prior artifact on dismissal", async () => {
    const report = await canonicalSupportReportFixture();
    const create = vi.spyOn(reportApi, "createSupportReport").mockResolvedValueOnce(report);
    const dispose = vi.fn();
    vi.spyOn(reportApi, "createSupportReportDownload").mockReturnValue({
      href: "blob:prior-notice",
      dispose,
    });
    renderInLocale(new ApiError("GATEWAY_TIMEOUT", "Timeout", 503), "en");
    fireEvent.click(screen.getByRole("button", { name: "Create error report" }));
    await screen.findByRole("link", { name: "Download report" });
    let pendingSignal: AbortSignal | undefined;
    let finish: ((value: typeof report) => void) | undefined;
    create.mockImplementationOnce((_correlation, signal) => {
      pendingSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate report" }));
    await vi.waitFor(() => {
      expect(create).toHaveBeenCalledTimes(2);
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(pendingSignal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    finish?.(report);
    await vi.waitFor(() => {
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });
  });

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

it("announces error text separately from report and dismissal controls", async () => {
  const { container } = renderInLocale(new ApiError("BAD_REQUEST", "Invalid request", 400), "en");
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Invalid request");
  expect(alert.querySelector("button, a, output")).toBeNull();
  expect(screen.getByRole("button", { name: "Create error report" })).toBeVisible();
  expect(await axe(container)).toHaveNoViolations();
});

it("gives the text-only alert remaining row width before its sibling dismiss control", () => {
  const style = errorNoticeLayoutStyle();
  try {
    renderInLocale(new ApiError("BAD_REQUEST", "Invalid request", 400), "en");
    const alert = screen.getByRole("alert");
    const dismiss = screen.getByRole("button", { name: "Dismiss error" });
    const row = alert.parentElement;
    if (row === null) throw new Error("Missing notice row");
    expect(row).toHaveClass("ui-error-notice-title-row");
    expect(dismiss.parentElement).toBe(row);
    expect(window.getComputedStyle(row).display).toBe("flex");
    expect(window.getComputedStyle(alert).flexGrow).toBe("1");
    expect(window.getComputedStyle(alert).minWidth).toBe("0px");
    expect(alert.querySelector("button, a, output")).toBeNull();
    expect(row).not.toContainElement(screen.getByRole("button", { name: "Create error report" }));
  } finally {
    style.remove();
  }
});
