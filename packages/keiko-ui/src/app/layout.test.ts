import vm from "node:vm";
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

function runLocaleScript(storage: ScriptStorage): {
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
    String,
  });

  return { lang: documentElement.lang, locale: documentElement.dataset["locale"] ?? "" };
}

function runBootRecoveryScript(options: {
  readonly hasWorkspace: boolean;
  readonly hasBootShell: boolean;
  readonly storage?: ScriptStorage;
}): ReturnType<typeof vi.fn> {
  const reload = vi.fn();
  const querySelector = vi.fn((selector: string): object | null => {
    if (selector === "main.workspace") return options.hasWorkspace ? {} : null;
    if (selector === ".app[aria-hidden='true'] .app-boot") return options.hasBootShell ? {} : null;
    return null;
  });

  vm.runInNewContext(APP_BOOT_RECOVERY_BOOTSTRAP, {
    document: { querySelector },
    location: { reload },
    sessionStorage: options.storage ?? makeStorage(),
    setTimeout,
  });

  return reload;
}

describe("APP_BOOT_RECOVERY_BOOTSTRAP", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reloads when the prerender boot shell remains stranded", () => {
    const storage = makeStorage();
    const reload = runBootRecoveryScript({
      hasWorkspace: false,
      hasBootShell: true,
      storage,
    });

    vi.advanceTimersByTime(8000);

    expect(reload).toHaveBeenCalledOnce();
    expect(storage.getItem(RECOVERY_KEY)).toBe("1");
  });

  it("does not reload once the workspace has mounted", () => {
    const reload = runBootRecoveryScript({ hasWorkspace: true, hasBootShell: true });

    vi.advanceTimersByTime(8000);

    expect(reload).not.toHaveBeenCalled();
  });

  it("allows one more recovery navigation when the first attempt was too early", () => {
    const storage = makeStorage({ [RECOVERY_KEY]: "1" });
    const reload = runBootRecoveryScript({
      hasWorkspace: false,
      hasBootShell: true,
      storage,
    });

    vi.advanceTimersByTime(8000);

    expect(reload).toHaveBeenCalledOnce();
    expect(storage.getItem(RECOVERY_KEY)).toBe("2");
  });

  it("stops recovery reloads after two stranded boot attempts", () => {
    const storage = makeStorage({ [RECOVERY_KEY]: "2" });
    const reload = runBootRecoveryScript({
      hasWorkspace: false,
      hasBootShell: true,
      storage,
    });

    vi.advanceTimersByTime(8000);

    expect(reload).not.toHaveBeenCalled();
  });
});

describe("LOCALE_BOOTSTRAP", () => {
  it("applies the stored German locale before hydration", () => {
    expect(runLocaleScript(makeStorage({ "keiko.locale": "de-DE" }))).toEqual({
      lang: "de",
      locale: "de",
    });
  });

  it("falls back to English for unsupported locale values", () => {
    expect(runLocaleScript(makeStorage({ "keiko.locale": "fr-FR" }))).toEqual({
      lang: "en",
      locale: "en",
    });
  });
});
