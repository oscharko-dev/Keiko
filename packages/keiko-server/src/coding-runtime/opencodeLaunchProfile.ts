import { randomBytes as nodeRandomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";

import {
  OPENCODE_MODEL_VISIBLE_TOOL_NAMES,
  OPENCODE_PINNED_BUILT_IN_TOOLS,
} from "./opencodeToolSchemas.js";

export interface OpenCodeLaunchProfileInput {
  readonly executable: string;
  readonly stateRoot: string;
  readonly randomBytes?: ((size: number) => Buffer) | undefined;
}
export const OPENCODE_RUNTIME_MODEL_ALIAS = "coding";
export type OpenCodeLaunchProfileResult =
  | {
      readonly ok: true;
      readonly executable: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly config: string;
    }
  | { readonly ok: false; readonly reason: "invalid-launch-input" | "secret-generation-failed" };

/** Fixed, secret-free-in-config launch shape. The password exists only in the child environment. */
export function buildOpenCodeLaunchProfile(
  input: OpenCodeLaunchProfileInput,
): OpenCodeLaunchProfileResult {
  if (!isAbsolute(input.executable) || !isAbsolute(input.stateRoot))
    return { ok: false, reason: "invalid-launch-input" };
  const secret = (input.randomBytes ?? nodeRandomBytes)(32);
  if (secret.length < 32) return { ok: false, reason: "secret-generation-failed" };
  const home = join(input.stateRoot, "home");
  return {
    ok: true,
    executable: input.executable,
    args: ["serve", "--hostname", "127.0.0.1", "--port", "0", "--no-mdns"],
    env: Object.freeze({
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(input.stateRoot, "config"),
      XDG_STATE_HOME: join(input.stateRoot, "state"),
      TMPDIR: join(input.stateRoot, "tmp"),
      TEMP: join(input.stateRoot, "tmp"),
      TMP: join(input.stateRoot, "tmp"),
      OPENCODE_CONFIG_DIR: join(input.stateRoot, "config", "opencode"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DB: join(input.stateRoot, "state", "opencode.db"),
      OPENCODE_SERVER_PASSWORD: secret.toString("base64url"),
    }),
    config: JSON.stringify(createFixedOpenCodeConfig()),
  };
}

export function createFixedOpenCodeConfig(): {
  readonly autoupdate: false;
  readonly snapshot: false;
  readonly model: string;
  readonly provider: Readonly<Record<string, unknown>>;
  readonly tools: Readonly<Record<string, boolean>>;
  readonly permission: Readonly<Record<string, string>>;
} {
  return {
    autoupdate: false,
    snapshot: false,
    model: `keiko-runtime/${OPENCODE_RUNTIME_MODEL_ALIAS}`,
    provider: {
      "keiko-runtime": {
        name: "Keiko Governed Coding Gateway",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: {
          [OPENCODE_RUNTIME_MODEL_ALIAS]: {
            name: "Keiko Governed Coding",
            tool_call: true,
            limit: { context: 32_768, output: 4_096 },
            cost: { input: 0, output: 0 },
          },
        },
        options: {
          baseURL: "{env:KEIKO_MODEL_GATEWAY_URL}",
          headers: { Authorization: "Bearer {env:KEIKO_MODEL_GATEWAY_CAPABILITY}" },
        },
      },
    },
    tools: Object.fromEntries([
      ["*", false] as const,
      ...OPENCODE_PINNED_BUILT_IN_TOOLS.map((tool) => [tool, false] as const),
      ...OPENCODE_MODEL_VISIBLE_TOOL_NAMES.map((tool) => [tool, true] as const),
    ]),
    permission: Object.fromEntries([
      ["*", "deny"] as const,
      ...OPENCODE_PINNED_BUILT_IN_TOOLS.map((tool) => [tool, "deny"] as const),
      ...OPENCODE_MODEL_VISIBLE_TOOL_NAMES.map((tool) => [tool, "allow"] as const),
    ]),
  };
}
