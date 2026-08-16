import vm from "node:vm";
import { axe } from "jest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_BOOT_RECOVERY_BOOTSTRAP, LOCALE_BOOTSTRAP } from "./layout";

const RECOVERY_KEY = "keiko.app-boot-recovery-reload-count";

interface ScriptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function makeStorage(initial: Record<string, string> = {}): ScriptStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      values.set(key, value);
    },
  };
}

function runLocaleScript(
  storage: ScriptStorage,
  browserLanguage = "en-US",
): {
  readonly lang: string;
  readonly locale: string;
} {
  const documentElement = {
    lang: "en",
    dataset: {} as Record<string, string>,
  };

  vm.runInNewContext(LOCALE_BOOTSTRAP, {
    document: { documentElement },
    localStorage: storage,
    navigator: { language: browserLanguage },
    String,
  });

  return { lang: documentElement.lang, locale: documentElement.dataset["locale"] ?? "" };
}

function bootDocument(options: {
  readonly hasWorkspace: boolean;
  readonly hasBootShell: boolean;
  readonly locale?: "de" | "en";
}): Document {
  document.body.replaceChildren();
  document.documentElement.lang = options.locale ?? "en";
  if (options.hasWorkspace) {
    const workspace = document.createElement("main");
    workspace.className = "workspace";
    document.body.append(workspace);
  }
  if (options.hasBootShell) {
    const app = document.createElement("div");
    app.className = "app";
    app.setAttribute("aria-hidden", "true");
    const boot = document.createElement("div");
    boot.className = "app-boot";
    app.append(boot);
    document.body.append(app);
  }
  return document;
}

function runBootRecoveryScript(options: {
  readonly hasWorkspace: boolean;
  readonly hasBootShell: boolean;
  readonly locale?: "de" | "en";
  readonly storage?: ScriptStorage;
}): {
  readonly document: Document;
  readonly reload: ReturnType<typeof vi.fn>;
} {
  const recoveryDocument = bootDocument(options);
  const reload = vi.fn();

  vm.runInNewContext(APP_BOOT_RECOVERY_BOOTSTRAP, {
    document: recoveryDocument,
    location: { reload },
    sessionStorage: options.storage ?? makeStorage(),
    setTimeout,
  });

  return { document: recoveryDocument, reload };
}

describe("APP_BOOT_RECOVERY_BOOTSTRAP", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.lang = "en";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reloads when the prerender boot shell remains stranded", () => {
    const storage = makeStorage();
    const { reload } = runBootRecoveryScript({
      hasWorkspace: false,
      hasBootShell: true,
      storage,
    });

    vi.advanceTimersByTime(8000);

    expect(reload).toHaveBeenCalledOnce();
    expect(storage.getItem(RECOVERY_KEY)).toBe("1");
  });

  it("does not reload once the workspace has mounted", () => {
    const { document: recoveryDocument, reload } = runBootRecoveryScript({
      hasWorkspace: true,
      hasBootShell: true,
    });

    vi.advanceTimersByTime(8000);

    expect(reload).not.toHaveBeenCalled();
    expect(recoveryDocument.querySelector("main.workspace")).not.toBeNull();
    expect(recoveryDocument.querySelector("[role='alert']")).toBeNull();
  });

  it("allows one more recovery navigation when the first attempt was too early", () => {
    const storage = makeStorage({ [RECOVERY_KEY]: "1" });
    const { reload } = runBootRecoveryScript({
      hasWorkspace: false,
      hasBootShell: true,
      storage,
    });

    vi.advanceTimersByTime(8000);

    expect(reload).toHaveBeenCalledOnce();
    expect(storage.getItem(RECOVERY_KEY)).toBe("2");
  });

  it("replaces the inert boot placeholder with an accessible localized recovery after retries exhaust", async () => {
    const storage = makeStorage({ [RECOVERY_KEY]: "2" });
    const { document: recoveryDocument, reload } = runBootRecoveryScript({
      hasWorkspace: false,
      hasBootShell: true,
      locale: "de",
      storage,
    });

    vi.advanceTimersByTime(8000);

    expect(reload).not.toHaveBeenCalled();
    expect(recoveryDocument.querySelector(".app")?.hasAttribute("aria-hidden")).toBe(false);
    expect(recoveryDocument.querySelector(".app-boot-logo")).toBeNull();
    const alert = recoveryDocument.querySelector<HTMLElement>("[role='alert']");
    const retry = recoveryDocument.querySelector<HTMLButtonElement>("button");
    expect(alert?.textContent).toContain("Keiko konnte den lokalen Dienst nicht erreichen.");
    expect(retry?.textContent).toBe("Erneut laden");
    expect(retry).toBe(recoveryDocument.activeElement);
    vi.useRealTimers();
    expect(await axe(recoveryDocument.body)).toHaveNoViolations();

    retry?.click();

    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("LOCALE_BOOTSTRAP", () => {
  it("applies the supported browser locale before hydration when no preference is stored", () => {
    expect(runLocaleScript(makeStorage(), "de-DE")).toEqual({
      lang: "de",
      locale: "de",
    });
  });

  it("applies the stored German locale before hydration", () => {
    expect(runLocaleScript(makeStorage({ "keiko.locale": "de-DE" }))).toEqual({
      lang: "de",
      locale: "de",
    });
  });

  it("falls back to English for unsupported locale values", () => {
    expect(runLocaleScript(makeStorage({ "keiko.locale": "fr-FR" }), "de-DE")).toEqual({
      lang: "en",
      locale: "en",
    });
  });
});
