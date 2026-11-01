import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { plantDirectoryRedirect } from "../symlinkFixture.test-support.js";
import {
  OPENCODE_NATIVE_DELIVERY_PLUGIN_FILE,
  OPENCODE_NATIVE_DELIVERY_PLUGIN_ID,
} from "./opencodeNativeDeliveryTools.js";
import {
  OPENCODE_NATIVE_REQUIRED_PLUGINS,
  awaitOpenCodeNativePlugins,
  openCodeNativePluginReadiness,
} from "./opencodeNativePluginReadiness.js";
import { createGeneratedOpenCodeV2Plugins } from "./opencodeRuntimeAdapter.js";

const DIRECTORY = "/state/run-1/config/opencode/plugins";

type Entry = Readonly<Record<string, unknown>>;

// The entry shapes the pinned 2.1.4 producer reported for an active plugin, a plugin whose setup
// threw and a module that failed to parse (the last carries no id).
function entry(id: string | undefined, path: string, status: "active" | "failed"): Entry {
  return {
    ...(id === undefined ? {} : { id }),
    source: { type: "local", path },
    features: { server: true },
    state: status === "active" ? { status } : { status, error: "Plugin failed to load" },
  };
}

function required(status: "active" | "failed" = "active", directory = DIRECTORY): Entry[] {
  return OPENCODE_NATIVE_REQUIRED_PLUGINS.map((plugin) =>
    entry(plugin.id, join(directory, plugin.file), status),
  );
}

const BUILTIN: Entry = {
  id: "opencode.tool.read",
  source: { type: "builtin" },
  features: { server: true },
  state: { status: "active" },
};

describe("native plugin readiness (#3897)", () => {
  it("names exactly the generated native plugins, by producer id and materialized file", () => {
    const sources = createGeneratedOpenCodeV2Plugins("native");
    expect(OPENCODE_NATIVE_REQUIRED_PLUGINS.map((plugin) => plugin.file).sort()).toEqual(
      Object.keys(sources)
        .map((name) => `${name}.ts`)
        .sort(),
    );
    for (const plugin of OPENCODE_NATIVE_REQUIRED_PLUGINS) {
      const source = sources[plugin.file.replace(/\.ts$/u, "")] ?? "";
      expect(source).toMatch(new RegExp(`id: ["']${plugin.id.replace(".", "\\.")}["']`, "u"));
    }
  });

  it("is active only when every required plugin is active from its own file", () => {
    expect(openCodeNativePluginReadiness([BUILTIN, ...required()], [DIRECTORY])).toBe("active");
  });

  it("waits while the producer has not listed every required plugin yet", () => {
    expect(openCodeNativePluginReadiness([], [DIRECTORY])).toBe("pending");
    expect(openCodeNativePluginReadiness([BUILTIN, ...required().slice(1)], [DIRECTORY])).toBe(
      "pending",
    );
  });

  // The shell's refusal of a Git write names Keiko's delivery tools as the way to deliver, so a run
  // without the plugin that registers them must never become ready (#3897).
  it("requires the delivery plugin: a run without it waits, and one whose setup failed is refused", () => {
    const delivery = OPENCODE_NATIVE_REQUIRED_PLUGINS.find(
      (plugin) => plugin.id === OPENCODE_NATIVE_DELIVERY_PLUGIN_ID,
    );
    expect(delivery?.file).toBe(`${OPENCODE_NATIVE_DELIVERY_PLUGIN_FILE}.ts`);
    const others = required().filter((candidate) => candidate.id !== delivery?.id);
    expect(others).toHaveLength(OPENCODE_NATIVE_REQUIRED_PLUGINS.length - 1);
    expect(openCodeNativePluginReadiness([BUILTIN, ...others], [DIRECTORY])).toBe("pending");
    const failed = entry(
      OPENCODE_NATIVE_DELIVERY_PLUGIN_ID,
      join(DIRECTORY, `${OPENCODE_NATIVE_DELIVERY_PLUGIN_FILE}.ts`),
      "failed",
    );
    expect(openCodeNativePluginReadiness([...others, failed], [DIRECTORY])).toBe("failed");
    const unparsed = entry(
      undefined,
      join(DIRECTORY, `${OPENCODE_NATIVE_DELIVERY_PLUGIN_FILE}.ts`),
      "failed",
    );
    expect(openCodeNativePluginReadiness([...others, unparsed], [DIRECTORY])).toBe("failed");
  });

  it("refuses a required plugin whose setup failed", () => {
    const [policy, context] = required();
    const failed = entry(
      OPENCODE_NATIVE_REQUIRED_PLUGINS[0]?.id,
      join(DIRECTORY, "keiko_native_policy.ts"),
      "failed",
    );
    expect(policy).toBeDefined();
    expect(openCodeNativePluginReadiness([failed, context ?? BUILTIN], [DIRECTORY])).toBe("failed");
  });

  it("refuses a required plugin that failed to parse and so carries no id", () => {
    const [, context] = required();
    const unparsed = entry(undefined, join(DIRECTORY, "keiko_native_policy.ts"), "failed");
    expect(openCodeNativePluginReadiness([unparsed, context ?? BUILTIN], [DIRECTORY])).toBe(
      "failed",
    );
  });

  it("refuses a required id claimed from any other file or claimed twice", () => {
    const [, context] = required();
    const foreign = entry("keiko.native-policy", "/workspace/.opencode/plugins/evil.ts", "active");
    expect(openCodeNativePluginReadiness([foreign, context ?? BUILTIN], [DIRECTORY])).toBe(
      "failed",
    );
    expect(openCodeNativePluginReadiness([...required(), foreign], [DIRECTORY])).toBe("failed");
    const builtin = { ...BUILTIN, id: "keiko.native-policy" };
    expect(openCodeNativePluginReadiness([builtin, context ?? BUILTIN], [DIRECTORY])).toBe(
      "failed",
    );
  });

  it("matches the resolved plugin directory the producer reports", () => {
    const resolved = "/private/state/run-1/config/opencode/plugins";
    // Without the resolved directory the reported file is foreign, which refuses (never admits).
    expect(openCodeNativePluginReadiness(required("active", resolved), [DIRECTORY])).toBe("failed");
    expect(openCodeNativePluginReadiness(required("active", resolved), [DIRECTORY, resolved])).toBe(
      "active",
    );
  });
});

describe("awaiting the native plugins", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function pluginsDirectory(): { readonly linked: string; readonly resolved: string } {
    const root = mkdtempSync(join(tmpdir(), "keiko-native-plugins-"));
    roots.push(root);
    mkdirSync(join(root, "real", "plugins"), { recursive: true });
    // A junction on Windows (no privilege needed), a directory symlink elsewhere (#4068).
    plantDirectoryRedirect(join(root, "real"), join(root, "link"));
    return {
      linked: join(root, "link", "plugins"),
      resolved: realpathSync(join(root, "real", "plugins")),
    };
  }

  it("polls until the producer reports the plugins active at their resolved path", async () => {
    const { linked, resolved } = pluginsDirectory();
    const lists: Entry[][] = [[], [BUILTIN], [BUILTIN, ...required("active", resolved)]];
    let calls = 0;
    const list = (): Promise<readonly Entry[]> => {
      calls += 1;
      return Promise.resolve(lists.shift() ?? []);
    };
    await expect(awaitOpenCodeNativePlugins(list, linked, undefined)).resolves.toBe(true);
    expect(calls).toBe(3);
  });

  it("refuses at once on a failed plugin and after the bound when one never appears", async () => {
    const { linked, resolved } = pluginsDirectory();
    const failed = (): Promise<readonly Entry[]> => Promise.resolve(required("failed", resolved));
    await expect(awaitOpenCodeNativePlugins(failed, linked, undefined)).resolves.toBe(false);
    let calls = 0;
    const empty = (): Promise<readonly Entry[]> => {
      calls += 1;
      return Promise.resolve([]);
    };
    await expect(awaitOpenCodeNativePlugins(empty, linked, undefined, 2)).resolves.toBe(false);
    expect(calls).toBe(2);
  });

  it("stops waiting when the readiness signal aborts", async () => {
    const { linked } = pluginsDirectory();
    const controller = new AbortController();
    const empty = (): Promise<readonly Entry[]> => {
      controller.abort();
      return Promise.resolve([]);
    };
    await expect(awaitOpenCodeNativePlugins(empty, linked, controller.signal)).rejects.toThrow();
  });
});
