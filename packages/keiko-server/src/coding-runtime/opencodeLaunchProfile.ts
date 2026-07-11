import { randomBytes as nodeRandomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";

export interface OpenCodeLaunchProfileInput {
  readonly executable: string;
  readonly stateRoot: string;
  readonly randomBytes?: ((size: number) => Buffer) | undefined;
}
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
      OPENCODE_CONFIG: join(input.stateRoot, "config", "opencode.json"),
      OPENCODE_DB: join(input.stateRoot, "state", "opencode.db"),
      OPENCODE_SERVER_PASSWORD: secret.toString("base64url"),
    }),
    config: JSON.stringify(fixedConfig()),
  };
}
function fixedConfig(): Record<string, unknown> {
  return {
    autoupdate: false,
    model: { fetch: false, provider: "keiko-runtime" },
    tools: {
      bash: false,
      edit: false,
      patch: false,
      write: false,
      git: false,
      pty: false,
      worktree: false,
      update: false,
      browser: false,
      mcp: false,
      web: false,
    },
    permission: {
      bash: "deny",
      edit: "deny",
      patch: "deny",
      write: "deny",
      git: "deny",
      pty: "deny",
      worktree: "deny",
      update: "deny",
      browser: "deny",
      mcp: "deny",
      webfetch: "deny",
      websearch: "deny",
    },
  };
}
