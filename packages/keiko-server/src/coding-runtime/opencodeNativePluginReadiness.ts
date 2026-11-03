import { realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  OPENCODE_NATIVE_DELIVERY_PLUGIN_FILE,
  OPENCODE_NATIVE_DELIVERY_PLUGIN_ID,
} from "./opencodeNativeDeliveryTools.js";

/**
 * The generated plugins a native run cannot do without (#3897): the policy hook that decides every
 * permission the producer evaluates, the context hook that hands the model Keiko's guidance, and
 * the delivery plugin that registers Keiko's Git delivery tools. The producer keeps each built-in
 * agent's own rules, so no configured rule stands in for the policy hook; a native run becomes
 * ready only once the producer reports every plugin active. The delivery plugin is required
 * because the shell's refusal of Git writes names its tools as the way to deliver: a run without
 * them would be told to use tools it does not have.
 */
export const OPENCODE_NATIVE_REQUIRED_PLUGINS = Object.freeze([
  Object.freeze({ id: "keiko.native-policy", file: "keiko_native_policy.ts" }),
  Object.freeze({ id: "keiko.native-context", file: "keiko_native_context.ts" }),
  Object.freeze({
    id: OPENCODE_NATIVE_DELIVERY_PLUGIN_ID,
    file: `${OPENCODE_NATIVE_DELIVERY_PLUGIN_FILE}.ts`,
  }),
]);

/** `pending` while the producer is still loading plugins; `failed` is final. */
export type OpenCodeNativePluginReadiness = "active" | "pending" | "failed";

type PluginEntry = Readonly<Record<string, unknown>>;

function record(value: unknown): PluginEntry | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as PluginEntry)
    : undefined;
}

function localPath(entry: PluginEntry): string | undefined {
  const source = record(entry.source);
  return source?.type === "local" && typeof source.path === "string" ? source.path : undefined;
}

function status(entry: PluginEntry): unknown {
  return record(entry.state)?.status;
}

function requiredState(
  entries: readonly PluginEntry[],
  plugin: { readonly id: string; readonly file: string },
  directories: readonly string[],
): OpenCodeNativePluginReadiness {
  const paths = new Set(directories.map((directory) => join(directory, plugin.file)));
  // A module that fails to parse is reported without an id, under its file only.
  const atPath = entries.filter((entry) => {
    const path = localPath(entry);
    return path !== undefined && paths.has(path);
  });
  if (atPath.some((entry) => status(entry) === "failed")) return "failed";
  const byId = entries.filter((entry) => entry.id === plugin.id);
  const [claimed] = byId;
  if (claimed === undefined) return "pending";
  // The id must come from Keiko's own generated file, once, and nowhere else.
  if (byId.length > 1 || !atPath.includes(claimed)) return "failed";
  const state = status(claimed);
  if (state === "active") return "active";
  return state === "failed" ? "failed" : "pending";
}

/**
 * Reads the producer's plugin list (`GET /api/plugin`, operation `plugin.list`) for the required
 * generated plugins. `directories` names the plugin directory as materialized and as resolved, since
 * the producer reports the resolved path. Body-free: the producer's error text is never read.
 */
export function openCodeNativePluginReadiness(
  entries: readonly PluginEntry[],
  directories: readonly string[],
): OpenCodeNativePluginReadiness {
  const states = OPENCODE_NATIVE_REQUIRED_PLUGINS.map((plugin) =>
    requiredState(entries, plugin, directories),
  );
  if (states.includes("failed")) return "failed";
  return states.every((state) => state === "active") ? "active" : "pending";
}

/**
 * The producer loads plugins a few tens of milliseconds after it starts listening; this bounds the
 * wait to 10 seconds. A loopback list is cheap, so a short interval keeps every run's start from
 * waiting out most of a long one (#3907 AC7: a 200 ms interval cost each start about 80 ms).
 */
export const OPENCODE_NATIVE_PLUGIN_READINESS_ATTEMPTS = 1_000;
export const OPENCODE_NATIVE_PLUGIN_READINESS_INTERVAL_MS = 10;

/**
 * Waits until the producer reports every required generated plugin active. A failed plugin, a
 * foreign plugin claiming a required id, or a plugin still missing when the bound runs out refuses.
 */
export async function awaitOpenCodeNativePlugins(
  list: (signal?: AbortSignal) => Promise<readonly PluginEntry[]>,
  pluginsDirectory: string,
  signal: AbortSignal | undefined,
  attempts: number = OPENCODE_NATIVE_PLUGIN_READINESS_ATTEMPTS,
): Promise<boolean> {
  const directories = [pluginsDirectory, realpathSync(pluginsDirectory)];
  // Each poll depends on the previous one's answer, so the polls run one after another.
  const poll = async (remaining: number): Promise<boolean> => {
    const readiness = openCodeNativePluginReadiness(await list(signal), directories);
    if (readiness !== "pending") return readiness === "active";
    if (remaining <= 1) return false;
    await delay(
      OPENCODE_NATIVE_PLUGIN_READINESS_INTERVAL_MS,
      undefined,
      signal === undefined ? {} : { signal },
    );
    return poll(remaining - 1);
  };
  return attempts > 0 ? poll(attempts) : false;
}
