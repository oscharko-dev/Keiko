import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as i18n from "./i18n";
import type { OptionalWidgetTranslate } from "./optional-widget-i18n";
import * as diagnostics from "./client-diagnostics";
const { setClientDiagnosticWriter, resetClientDiagnosticWriter } = diagnostics;

// Keep the mounted provider and freshly imported widget hook on the same context instance.
vi.doMock("./i18n", () => i18n);
vi.doMock("./client-diagnostics", () => diagnostics);

afterEach(() => {
  vi.doUnmock("./i18n-messages.optional.de");
  resetClientDiagnosticWriter();
});

function Counter({ t }: { readonly t: OptionalWidgetTranslate }): ReactNode {
  const [count, setCount] = useState(0);
  const setLocale = i18n.useSetLocale();
  return (
    <>
      <button type="button" onClick={() => setCount(count + 1)}>
        {t("memoria.approve")}
      </button>
      <output aria-label="Clicks">{count}</output>
      <button type="button" onClick={() => setLocale("de")}>
        German
      </button>
      <button type="button" onClick={() => setLocale("en")}>
        English
      </button>
    </>
  );
}

describe("optional widget locale recovery", () => {
  it("records one closed failure per shared load and permits a later mounted retry", async () => {
    vi.resetModules();
    vi.doMock("./i18n-messages.optional.de", () => {
      throw new TypeError("private import URL /customer/private?token=secret");
    });
    const widget = await import("./optional-widget-i18n");
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    const first = widget.loadOptionalWidgetMessages("de");
    expect(widget.loadOptionalWidgetMessages("de")).toBe(first);
    await first;
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith("widget-locale-load-failed", {
      kind: "other",
      errorEvidence: { errorClass: "Error", causeChain: ["TypeError"], frames: [] },
    });
    expect(JSON.stringify(writer.mock.calls)).not.toMatch(/customer|private|token|secret/u);
    vi.doUnmock("./i18n-messages.optional.de");
    expect(widget.loadOptionalWidgetMessages("de")).not.toBe(first);
    await widget.loadOptionalWidgetMessages("de");
    expect(widget.translateOptionalWidget("de", "memoria.approve")).toBe("Akzeptieren");
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("keeps mounted English controls and state usable through a failed German load", async () => {
    vi.resetModules();
    vi.doMock("./i18n-messages.optional.de", () => {
      throw new TypeError("private import URL");
    });
    const widget = await import("./optional-widget-i18n");
    const writer = vi.fn();
    setClientDiagnosticWriter(writer);
    function Probe(): ReactNode {
      return <Counter t={widget.useOptionalWidgetTranslate()} />;
    }
    render(
      <i18n.I18nProvider>
        <Probe />
      </i18n.I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "German" }));
    await waitFor(() => expect(writer).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Clicks")).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByLabelText("Clicks")).toHaveTextContent("2");
    vi.doUnmock("./i18n-messages.optional.de");
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    fireEvent.click(screen.getByRole("button", { name: "German" }));
    const recovered = await screen.findByRole("button", { name: "Akzeptieren" });
    expect(screen.getByLabelText("Clicks")).toHaveTextContent("2");
    fireEvent.click(recovered);
    expect(screen.getByLabelText("Clicks")).toHaveTextContent("3");
  });
});

describe("optional translator identity", () => {
  it("updates delayed German labels without restarting effects that depend on the translator", async () => {
    vi.resetModules();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.doMock("./i18n-messages.optional.de", async (importOriginal) => {
      await gate;
      return importOriginal<typeof import("./i18n-messages.optional.de")>();
    });
    const widget = await import("./optional-widget-i18n");
    const effect = vi.fn();
    function Probe(): ReactNode {
      const t = widget.useOptionalWidgetTranslate();
      useEffect(effect, [t]);
      return <Counter t={t} />;
    }
    window.localStorage.setItem("keiko.locale", "en");
    render(
      <i18n.I18nProvider>
        <Probe />
      </i18n.I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "German" }));
    await waitFor(() => expect(document.documentElement.lang).toBe("de"));
    expect(effect).toHaveBeenCalledTimes(2);
    await act(async () => {
      release();
      await gate;
    });
    await screen.findByRole("button", { name: "Akzeptieren" });
    expect(effect).toHaveBeenCalledTimes(2);
  });
});
