import { describe, expect, it, vi } from "vitest";
import {
  changeLimitUiLanguage,
  withEnglishLimitUi,
} from "../testing/jira-chat-lab/limit-run-language.mjs";

vi.mock("@playwright/test", () => ({
  expect: (locator) => ({
    toHaveCount: async (count) => expect(await locator.count()).toBe(count),
    toHaveAttribute: async (key, value) => expect(await locator.getAttribute(key)).toBe(value),
  }),
}));

function languageControls(state, options) {
  return {
    async click(name) {
      state.events.push(name);
      if (name === "general") {
        state.tab = "general";
        options.onGeneral?.();
      }
      if (name === "open") {
        state.settings = true;
        state.top = "settings-1";
        if (options.failOpen) throw new Error("settings-open-failed");
      }
      if (name === "close") {
        state.settings = false;
        state.top = "fallback-window";
        if (options.failClose) throw new Error("settings-close-failed");
      }
    },
    async option(name) {
      expect(state.settings).toBe(true);
      expect(state.tab).toBe("general");
      const locale = { English: "en", Deutsch: "de" }[name];
      expect(locale).toBeDefined();
      state.events.push(`option:${locale}`);
      state.locale = locale;
      if (options.failFirstOption && !state.optionFailed) {
        state.optionFailed = true;
        throw new Error("language-option-failed");
      }
    },
  };
}
function settingsLocator(state, controls) {
  return {
    count: async () => Number(state.settings),
    getByRole: (role, options) => {
      expect(role).toBe("button");
      expect(options.exact).toBe(true);
      const general = state.locale === "en" ? "General" : "Allgemein";
      const close =
        state.locale === "en" ? "Close Settings window" : "Einstellungen-Fenster schließen";
      const action = options.name.test(general) ? "general" : "close";
      expect(options.name.test(action === "general" ? general : close)).toBe(true);
      return { click: () => controls.click(action) };
    },
    locator: (selector) => {
      expect(selector).toBe('[role="combobox"][aria-describedby="settings-language-help"]');
      return {
        click: async () => {
          state.events.push("combobox");
        },
      };
    },
  };
}
function pageLocator(state, settings, selector) {
  if (selector === "html")
    return {
      getAttribute: async (key) => {
        expect(key).toBe("lang");
        return state.locale;
      },
    };
  if (selector === 'section.window[data-top="true"]')
    return {
      count: async () => 1,
      getAttribute: async (key) => {
        expect(key).toBe("data-window-id");
        return state.top;
      },
    };
  if (selector === ".set") return { marker: "settings" };
  if (selector === "section.window")
    return {
      filter: ({ has }) => {
        expect(has).toEqual({ marker: "settings" });
        return settings;
      },
    };
  const match = /^section\.window\[data-window-id=([A-Za-z\d_-]+)\]$/u.exec(selector);
  expect(match).not.toBeNull();
  return {
    count: async () => 1,
    click: async (options) => {
      expect(options).toEqual({ position: { x: 12, y: 12 } });
      state.events.push(`foreground:${match[1]}`);
      state.top = match[1];
    },
  };
}
function fixture(locale = "de", options = {}) {
  const state = {
    locale,
    settings: options.existingSettings ?? false,
    top: "chat-1",
    tab: "models",
    events: [],
  };
  const controller = new globalThis.AbortController();
  const controls = languageControls(state, options);
  const settings = settingsLocator(state, controls);
  const page = {
    locator: (selector) => pageLocator(state, settings, selector),
    evaluate: async (_fn, value) => value,
    getByRole: (role, control) => {
      expect(control.exact).toBe(true);
      if (role === "option") return { click: () => controls.option(control.name) };
      expect(role).toBe("button");
      expect(control.name.test(state.locale === "en" ? "Settings" : "Einstellungen")).toBe(true);
      return { first: () => ({ click: () => controls.click("open") }) };
    },
  };
  const ctx = { page, locale, signal: controller.signal };
  return { state, ctx, controller };
}

describe("limit-run language through ordinary Settings", () => {
  it.each([
    ["en", "de"],
    ["de", "en"],
  ])(
    "changes %s to %s with the real language combobox and restores foreground",
    async (from, to) => {
      const f = fixture(from);
      await changeLimitUiLanguage(f.ctx, to);
      expect(f.state.locale).toBe(to);
      expect(f.ctx.locale).toBe(to);
      expect(f.state.settings).toBe(false);
      expect(f.state.top).toBe("chat-1");
      expect(f.state.events).toEqual([
        "open",
        "general",
        "combobox",
        `option:${to}`,
        "close",
        "foreground:chat-1",
      ]);
    },
  );
  it.each(["en", "de"])("does not touch Settings when already %s", async (locale) => {
    const f = fixture(locale);
    f.ctx.locale = locale === "en" ? "de" : "en";
    await changeLimitUiLanguage(f.ctx, locale);
    expect(f.ctx.locale).toBe(locale);
    expect(f.state.events).toEqual([]);
  });
  it("keeps an existing Settings window open", async () => {
    const f = fixture("de", { existingSettings: true });
    await changeLimitUiLanguage(f.ctx, "en");
    expect(f.state.settings).toBe(true);
    expect(f.state.events).not.toContain("close");
    expect(f.state.top).toBe("chat-1");
  });
  it.each(["en", "de"])(
    "restores original %s and original foreground after a successful English task",
    async (locale) => {
      const f = fixture(locale);
      const result = await withEnglishLimitUi(f.ctx, async () => {
        expect(f.state.locale).toBe("en");
        f.state.top = "skills-2";
        return "completed";
      });
      expect(result).toBe("completed");
      expect(f.state.locale).toBe(locale);
      expect(f.ctx.locale).toBe(locale);
      expect(f.state.top).toBe("chat-1");
      expect(f.state.settings).toBe(false);
    },
  );
  it.each(["en", "de"])(
    "restores original %s and foreground when the English task fails",
    async (locale) => {
      const f = fixture(locale);
      await expect(
        withEnglishLimitUi(f.ctx, async () => {
          f.state.top = "skills-2";
          throw new Error("task-failed");
        }),
      ).rejects.toThrow("task-failed");
      expect(f.state.locale).toBe(locale);
      expect(f.ctx.locale).toBe(locale);
      expect(f.state.top).toBe("chat-1");
    },
  );
  it("restores language and foreground even when the task aborts its signal", async () => {
    const f = fixture();
    await expect(
      withEnglishLimitUi(f.ctx, async () => {
        f.controller.abort(new Error("turn-aborted"));
        f.state.top = "skills-2";
        throw new Error("task-aborted");
      }),
    ).rejects.toThrow("task-aborted");
    expect(f.state.locale).toBe("de");
    expect(f.ctx.locale).toBe("de");
    expect(f.state.top).toBe("chat-1");
  });
  it("restores after an initial language-option failure following its native UI effect", async () => {
    const f = fixture("de", { failFirstOption: true });
    const run = vi.fn();
    await expect(withEnglishLimitUi(f.ctx, run)).rejects.toThrow("language-option-failed");
    expect(run).not.toHaveBeenCalled();
    expect(f.state.locale).toBe("de");
    expect(f.ctx.locale).toBe("de");
    expect(f.state.top).toBe("chat-1");
  });
  it("restores foreground even if closing the temporary Settings window fails", async () => {
    const f = fixture("de", { failClose: true });
    await expect(changeLimitUiLanguage(f.ctx, "en")).rejects.toThrow("settings-close-failed");
    expect(f.state.top).toBe("chat-1");
  });
  it("cleans an opened Settings window and foreground when the opening click fails", async () => {
    const f = fixture("de", { failOpen: true });
    await expect(changeLimitUiLanguage(f.ctx, "en")).rejects.toThrow("settings-open-failed");
    expect(f.state.settings).toBe(false);
    expect(f.state.top).toBe("chat-1");
  });
  it("restores an already-open Settings window without closing it after task failure", async () => {
    const f = fixture("de", { existingSettings: true });
    await expect(
      withEnglishLimitUi(f.ctx, async () => {
        throw new Error("task-failed");
      }),
    ).rejects.toThrow("task-failed");
    expect(f.state.settings).toBe(true);
    expect(f.state.events).not.toContain("close");
    expect(f.state.locale).toBe("de");
    expect(f.state.top).toBe("chat-1");
  });
  it.each(["fr", "EN", "../de", "de\n"])(
    "refuses unsupported target locale %j before UI changes",
    async (locale) => {
      const f = fixture();
      await expect(changeLimitUiLanguage(f.ctx, locale)).rejects.toThrow(
        "Unsupported limit-run UI language",
      );
      expect(f.state.events).toEqual([]);
    },
  );
  it("refuses an unsupported original locale", async () => {
    const f = fixture("fr");
    await expect(withEnglishLimitUi(f.ctx, vi.fn())).rejects.toThrow(
      "Unsupported limit-run UI language",
    );
    expect(f.state.events).toEqual([]);
  });
  it("refuses an already aborted context without opening Settings or running work", async () => {
    const f = fixture();
    f.controller.abort(new Error("already-aborted"));
    const run = vi.fn();
    await expect(changeLimitUiLanguage(f.ctx, "en")).rejects.toThrow("already-aborted");
    await expect(withEnglishLimitUi(f.ctx, run)).rejects.toThrow("already-aborted");
    expect(run).not.toHaveBeenCalled();
    expect(f.state.events).toEqual([]);
  });
  it("guards a newly aborted normal change before selecting a language", async () => {
    let f;
    f = fixture("de", { onGeneral: () => f.controller.abort(new Error("selection-aborted")) });
    await expect(changeLimitUiLanguage(f.ctx, "en")).rejects.toThrow("selection-aborted");
    expect(f.state.locale).toBe("de");
    expect(f.state.events).not.toContain("option:en");
    expect(f.state.top).toBe("chat-1");
  });
});
