// Issue #2245 (AC) — each closed verify status renders distinct, actionable copy and a tone; no raw
// provider error path exists (the component only accepts the closed union).

import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import { VerifyConnectionStatus } from "./VerifyConnectionStatus";
import { I18nProvider, loadLocaleMessages, type Locale } from "@/lib/i18n";
import { loadOptionalWidgetMessages } from "@/lib/optional-widget-i18n";
import {
  ATLASSIAN_CONNECTOR_VERIFY_STATUSES,
  type AtlassianConnectorVerifyStatus,
} from "@/lib/atlassian-connectors-api";

const EXPECTED: Record<
  AtlassianConnectorVerifyStatus,
  { readonly label: string; readonly tone: string }
> = {
  ok: { label: "Connection verified", tone: "ok" },
  "auth-failed": { label: "Authentication failed", tone: "danger" },
  "auth-unverified": { label: "Could not confirm", tone: "warning" },
  forbidden: { label: "Access forbidden", tone: "danger" },
  unreachable: { label: "Site unreachable", tone: "warning" },
  timeout: { label: "Connection timed out", tone: "warning" },
  "redirect-refused": { label: "Redirect refused", tone: "danger" },
  "invalid-response": { label: "Invalid Atlassian response", tone: "danger" },
  "unsupported-version": { label: "Unsupported Jira version", tone: "danger" },
  "tls-failed": { label: "Certificate verification failed", tone: "danger" },
};

describe("VerifyConnectionStatus", () => {
  it("renders each closed status with distinct label + tone", () => {
    const seen = new Set<string>();
    for (const status of ATLASSIAN_CONNECTOR_VERIFY_STATUSES) {
      const { unmount } = render(<VerifyConnectionStatus status={status} />);
      const el = screen.getByTestId("acx-verify-status");
      const expected = EXPECTED[status];
      expect(expected).toBeDefined();
      expect(el).toHaveAttribute("data-status", status);
      expect(el).toHaveAttribute("data-tone", expected?.tone ?? "");
      expect(el).toHaveTextContent(expected?.label ?? "");
      // `<output>` carries an implicit role="status" (a polite live region) — assert the a11y role
      // resolves rather than a literal attribute.
      expect(screen.getByRole("status")).toBe(el);
      seen.add(el.textContent ?? "");
      unmount();
    }
    // Every status produced a distinct rendered string.
    expect(seen.size).toBe(ATLASSIAN_CONNECTOR_VERIFY_STATUSES.length);
  });

  it("has no axe violations (light and dark)", async () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.setAttribute("data-theme", theme);
      const { container, unmount } = render(<VerifyConnectionStatus status="forbidden" />);
      expect(await axe(container)).toHaveNoViolations();
      unmount();
    }
  });
});

// #4358 AC3: a certificate failure the person cannot fix without a remedy is a dead end. The copy
// tells them what to change: the CA bundle variable, a restart and a new verification, and never to
// switch verification off. The sentence comes from the catalog key; the three facts are asserted on
// what is actually rendered, in both languages.
const TLS_COPY_KEY = "atlassianConnectors.verify.tls-failed.copy";
const TLS_REMEDY: Record<
  Locale,
  {
    readonly restart: RegExp;
    readonly verifyAgain: RegExp;
    readonly prohibition: RegExp;
    readonly disabling: RegExp;
  }
> = {
  en: {
    restart: /\brestart\b/iu,
    verifyAgain: /\bverify again\b/iu,
    prohibition: /\bnever turn certificate verification off\b/iu,
    disabling: /\b(?:disable|deactivate|bypass|ignore|skip|insecure|unsafe)\b/iu,
  },
  de: {
    restart: /\bstarte\b[^.]*\bneu\b/iu,
    verifyAgain: /\bverifiziere erneut\b/iu,
    prohibition: /\bschalte die zertifikatsprüfung niemals ab\b/iu,
    disabling: /(?<!\p{L})(?:deaktivier|umgeh|ignorier|überspring|unsicher)/iu,
  },
};

async function renderTlsFailed(locale: Locale): Promise<{
  readonly container: HTMLElement;
  readonly copy: string;
  readonly unmount: () => void;
}> {
  const catalog = await loadOptionalWidgetMessages(locale);
  await loadLocaleMessages(locale);
  window.localStorage.setItem("keiko.locale", locale);
  const { container, unmount } = render(
    <I18nProvider>
      <VerifyConnectionStatus status="tls-failed" />
    </I18nProvider>,
  );
  return { container, copy: catalog[TLS_COPY_KEY], unmount };
}

describe("VerifyConnectionStatus tls-failed remedy (#4358 AC3)", () => {
  it.each(["en", "de"] as const)(
    "renders the %s remedy: the CA bundle variable, a restart and a new verification, never turning verification off",
    async (locale) => {
      const { container, copy, unmount } = await renderTlsFailed(locale);
      try {
        const rule = TLS_REMEDY[locale];
        const text = screen.getByTestId("acx-verify-status").textContent ?? "";
        // Rendered from the catalog key, not from a copy kept here.
        expect(copy.length).toBeGreaterThan(0);
        expect(text).toContain(copy);
        const variable = text.indexOf("KEIKO_CA_BUNDLE_PATH");
        const restart = text.search(rule.restart);
        const verifyAgain = text.search(rule.verifyAgain);
        expect(variable).toBeGreaterThanOrEqual(0);
        expect(restart).toBeGreaterThan(variable);
        expect(verifyAgain).toBeGreaterThan(restart);
        expect(text).toMatch(rule.prohibition);
        expect(text).not.toMatch(rule.disabling);
        expect(await axe(container)).toHaveNoViolations();
      } finally {
        unmount();
        window.localStorage.removeItem("keiko.locale");
        document.documentElement.lang = "en";
      }
    },
  );
});
