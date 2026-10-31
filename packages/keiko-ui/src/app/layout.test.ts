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
  readonly window: EventTarget;
} {
  const recoveryDocument = bootDocument(options);
  const reload = vi.fn();
  const recoveryWindow = new EventTarget();

  vm.runInNewContext(APP_BOOT_RECOVERY_BOOTSTRAP, {
    document: recoveryDocument,
    window: recoveryWindow,
    clearTimeout,
    location: { reload },
    sessionStorage: options.storage ?? makeStorage(),
    setTimeout,
  });

  return { document: recoveryDocument, reload, window: recoveryWindow };
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

  it("does not spend recovery retries while initial resources are still progressing", () => {
    let readyState: DocumentReadyState = "loading";
    vi.spyOn(document, "readyState", "get").mockImplementation(() => readyState);
    const storage = makeStorage();
    const {
      document: recoveryDocument,
      reload,
      window: recoveryWindow,
    } = runBootRecoveryScript({
      hasWorkspace: false,
      hasBootShell: true,
      storage,
    });
    const initialScript = recoveryDocument.createElement("script");
    initialScript.src = "/_next/static/chunks/synthetic-initial-resource.js";
    recoveryDocument.body.append(initialScript);

    vi.advanceTimersByTime(6000);
    readyState = "interactive";
    recoveryDocument.dispatchEvent(new Event("readystatechange"));
    vi.advanceTimersByTime(2000);

    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(RECOVERY_KEY)).toBeNull();

    vi.advanceTimersByTime(2000);
    initialScript.dispatchEvent(new Event("load"));
    readyState = "complete";
    recoveryWindow.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(1000);
    const workspace = recoveryDocument.createElement("main");
    workspace.className = "workspace";
    recoveryDocument.body.append(workspace);
    vi.advanceTimersByTime(8000);

    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(RECOVERY_KEY)).toBeNull();
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

  it("gives a loaded document the full hydration window and settles racing signals once", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const { window: recoveryWindow, reload } = runBootRecoveryScript({
      hasWorkspace: false,
      hasBootShell: true,
    });
    vi.advanceTimersByTime(58000);
    expect(reload).not.toHaveBeenCalled();
    recoveryWindow.dispatchEvent(new Event("load"));
    recoveryWindow.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(7999);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60000);
    recoveryWindow.dispatchEvent(new Event("load"));
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "bounds resources that never settle with mounted workspace=%s",
    (mounted) => {
      vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
      const { reload } = runBootRecoveryScript({ hasWorkspace: mounted, hasBootShell: true });
      vi.advanceTimersByTime(59999);
      expect(reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(reload).toHaveBeenCalledTimes(mounted ? 0 : 1);
    },
  );

  it.each(["SCRIPT", "LINK"])("recovers a failed initial %s without waiting for load", (tag) => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const { window: recoveryWindow, reload } = runBootRecoveryScript({
      hasWorkspace: false,
      hasBootShell: true,
    });
    const failure = new Event("error");
    const resource = document.createElement(tag);
    if (resource instanceof HTMLLinkElement) resource.rel = "stylesheet";
    Object.defineProperty(failure, "target", { value: resource });
    recoveryWindow.dispatchEvent(failure);
    vi.advanceTimersByTime(7999);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60000);
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each(["preload", "icon"])("does not arm hydration recovery for a failed %s link", (rel) => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const { window: recoveryWindow, reload } = runBootRecoveryScript({
      hasWorkspace: false,
      hasBootShell: true,
    });
    const resource = document.createElement("link");
    resource.rel = rel;
    const failure = new Event("error");
    Object.defineProperty(failure, "target", { value: resource });
    recoveryWindow.dispatchEvent(failure);
    vi.advanceTimersByTime(8000);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(52000);
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each(["load", "error", "deadline"])(
    "settles racing boot signals once after %s wins",
    (first) => {
      vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
      const { window: recoveryWindow, reload } = runBootRecoveryScript({
        hasWorkspace: false,
        hasBootShell: true,
      });
      const failure = new Event("error");
      Object.defineProperty(failure, "target", { value: document.createElement("script") });
      if (first === "deadline") vi.advanceTimersByTime(60000);
      else {
        vi.advanceTimersByTime(58000);
        recoveryWindow.dispatchEvent(first === "load" ? new Event("load") : failure);
      }
      recoveryWindow.dispatchEvent(new Event("load"));
      recoveryWindow.dispatchEvent(failure);
      vi.advanceTimersByTime(8000);
      expect(reload).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

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
