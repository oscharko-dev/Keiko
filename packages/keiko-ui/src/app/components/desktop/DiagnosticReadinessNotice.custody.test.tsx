// #4358: the workspace tells a person when the credentials stored on Windows may have been
// readable by another account (`exposed`) or could not be checked (`unattested`). The other
// closed states show nothing, and neither does a value that is not one of them.
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "jest-axe";
import { I18nProvider } from "@/lib/i18n";
import type { HealthSnapshot } from "@/lib/api";
import { DiagnosticReadinessNotice } from "./DiagnosticReadinessNotice";

function renderNotice(health: HealthSnapshot): ReturnType<typeof render> {
  return render(
    <I18nProvider>
      <DiagnosticReadinessNotice health={{ state: "loaded", health }} />
    </I18nProvider>,
  );
}

const healthy = { status: "ok", version: "1.2.3" } as const;

afterEach(() => {
  window.localStorage.removeItem("keiko.locale");
});

describe("DiagnosticReadinessNotice credential custody", () => {
  it.each([
    {
      locale: "en",
      state: "exposed",
      starts: "The key that protects your stored credentials was readable by another account",
      names: ["create a new Jira token", "replace the gateway key in Settings > Models"],
    },
    {
      locale: "de",
      state: "exposed",
      starts:
        "Der Schlüssel, der deine gespeicherten Zugangsdaten schützt, war für ein anderes Konto",
      names: ["Erstelle ein neues Jira-Token", "Gateway-Schlüssel unter Einstellungen > Modelle"],
    },
    {
      locale: "en",
      state: "unattested",
      starts: "Keiko could not check whether your stored credentials are protected",
      names: ["allow Windows PowerShell for your account", "restart Keiko"],
    },
    {
      locale: "de",
      state: "unattested",
      starts: "Keiko konnte nicht prüfen, ob deine gespeicherten Zugangsdaten",
      names: ["Windows PowerShell für dein Konto zuzulassen", "starte Keiko danach neu"],
    },
  ] as const)(
    "tells the person what happened and what to do for $state in $locale",
    async ({ locale, state, starts, names }) => {
      window.localStorage.setItem("keiko.locale", locale);
      const view = renderNotice({ ...healthy, credentialCustody: state });
      const notice = await screen.findByText((text) => text.startsWith(starts));
      for (const name of names) expect(notice).toHaveTextContent(name);
      // Closed text only: no path, account name or security identifier.
      expect(notice.textContent).not.toMatch(/[A-Za-z]:\\|S-1-5-|Users\\/u);
      expect(await axe(view.container)).toHaveNoViolations();
    },
  );

  it("never words `unattested` like a protected store", async () => {
    renderNotice({ ...healthy, credentialCustody: "unattested" });
    const notice = await screen.findByText((text) => text.startsWith("Keiko could not check"));
    expect(notice).not.toHaveTextContent(/are private|is private|attested/iu);
  });

  it.each([
    ["attested", { ...healthy, credentialCustody: "attested" }],
    ["protected", { ...healthy, credentialCustody: "protected" }],
    ["no custody value", healthy],
    ["a value outside the closed states", { ...healthy, credentialCustodyInvalid: true }],
  ] as const)("shows nothing for %s", (_label, health) => {
    const view = renderNotice(health);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("shows nothing for a custody value that bypassed the health reader", () => {
    const forged = {
      ...healthy,
      credentialCustody: "C:\\Users\\someone",
    } as unknown as HealthSnapshot;
    const view = renderNotice(forged);
    expect(view.container).toBeEmptyDOMElement();
  });
});
