import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGitNetworkProcessRunner } from "./runner.js";
import { classifyGitRemoteFailure } from "./classify.js";

let fixture: string;
let repository: string;
let account: string;
let server: Server;
let remote: string;
let authenticated = 0;

function config(key: string, value: string, scope: "global" | "local" = "global"): void {
  execFileSync("git", ["config", `--${scope}`, "--add", key, value], { cwd: repository });
}

function helper(marker: string): string {
  const file = join(fixture, marker).replaceAll("\\", "/");
  return `!f() { echo used > '${file}'; if test "$1" = get; then printf 'username=fixture-user\\npassword=fixture-password\\n'; fi; }; f`;
}

function fetchRemote(
  args: readonly string[] = ["fetch", remote],
): ReturnType<typeof defaultGitNetworkProcessRunner> {
  return defaultGitNetworkProcessRunner(args, {
    cwd: repository,
    timeoutMs: 5_000,
    maxBytes: 8_192,
  });
}

beforeEach(async () => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "keiko-git-credentials-")));
  repository = join(fixture, "repo");
  account = join(fixture, "account");
  mkdirSync(repository);
  mkdirSync(account);
  vi.stubEnv("HOME", account);
  vi.stubEnv("USERPROFILE", account);
  vi.stubEnv("XDG_CONFIG_HOME", account);
  execFileSync("git", ["init", "-q"], { cwd: repository });
  config("credential.helper", "");
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ],
    { cwd: repository },
  );
  const remoteRoot = join(fixture, "remote.git");
  execFileSync("git", ["clone", "--bare", "-q", repository, remoteRoot]);
  execFileSync("git", ["update-server-info"], { cwd: remoteRoot });
  authenticated = 0;
  server = createServer((request, response) => {
    const expected = `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`;
    if (request.headers.authorization !== expected) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
      response.end();
      return;
    }
    authenticated += 1;
    const suffix = new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(
      "/repo.git/".length,
    );
    try {
      const data = readFileSync(join(remoteRoot, suffix));
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("expected TCP address");
  remote = `http://127.0.0.1:${String(address.port)}/repo.git`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    }),
  );
  rmSync(fixture, { recursive: true, force: true });
});

describe("host credentials at the network Git boundary (#4411)", () => {
  it("fetches with the account helper while refusing repository helpers", async () => {
    config("credential.helper", helper("host-used"));
    config("credential.helper", helper("repo-used"), "local");
    config(`credential.${remote}.helper`, helper("repo-url-used"), "local");
    const result = await fetchRemote();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(authenticated).toBeGreaterThan(0);
    expect(result.credentialHelperSource).toBe("host-config");
    expect(existsSync(join(fixture, "host-used"))).toBe(true);
    expect(existsSync(join(fixture, "repo-used"))).toBe(false);
    expect(existsSync(join(fixture, "repo-url-used"))).toBe(false);
    expect(result.stdout + result.stderr).not.toContain("fixture-password");
  });

  it("preserves URL-specific host helper matching", async () => {
    config("credential.https://unused.invalid.helper", helper("wrong-host-used"));
    config(`credential.${remote}.helper`, helper("right-host-used"));
    const result = await fetchRemote();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(join(fixture, "right-host-used"))).toBe(true);
    expect(existsSync(join(fixture, "wrong-host-used"))).toBe(false);
  });

  it("preserves empty host helper resets without restoring an earlier credential", async () => {
    config("credential.helper", helper("reset-helper-used"));
    config("credential.helper", "");
    const result = await fetchRemote();
    expect(classifyGitRemoteFailure(result)).toBe("auth-failed");
    expect(authenticated).toBe(0);
    expect(existsSync(join(fixture, "reset-helper-used"))).toBe(false);
  });

  it("does not promote a repository include or host include into executable authority", async () => {
    const included = join(repository, "helper.gitconfig");
    writeFileSync(
      included,
      `[credential]\n\thelper = ${JSON.stringify(helper("included-helper-used"))}\n`,
    );
    config("include.path", included);
    config("include.path", included, "local");
    const result = await fetchRemote();
    expect(classifyGitRemoteFailure(result)).toBe("auth-failed");
    expect(existsSync(join(fixture, "included-helper-used"))).toBe(false);
  });

  it("does not run helpers when the credential discovery is cancelled", async () => {
    config("credential.helper", helper("cancelled-helper-used"));
    const controller = new AbortController();
    controller.abort();
    const result = await defaultGitNetworkProcessRunner(["fetch", remote], {
      cwd: repository,
      maxBytes: 8_192,
      timeoutMs: 5_000,
      abortSignal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(authenticated).toBe(0);
    expect(existsSync(join(fixture, "cancelled-helper-used"))).toBe(false);
  });

  it("refuses an oversized host helper listing without running a truncated command", async () => {
    // Exercise the output bound, without exceeding Windows' command-line bound while arranging it.
    appendFileSync(
      join(account, ".gitconfig"),
      `\n[credential]\n\thelper = ${JSON.stringify(helper("oversized-helper-used") + " ".repeat(40_000))}\n`,
    );
    const result = await fetchRemote();
    expect(result.truncated).toBe(true);
    expect(result.credentialHelperSource).toBe("unavailable");
    expect(result.stdout + result.stderr).toBe("");
    expect(existsSync(join(fixture, "oversized-helper-used"))).toBe(false);
  });

  it("rejects caller-supplied URL credential helper overrides before authentication", async () => {
    const result = await fetchRemote([
      "-c",
      `credential.${remote}.helper=${helper("caller-used")}`,
      "fetch",
      remote,
    ]);
    expect(result.refusal).toBe("config-override");
    expect(existsSync(join(fixture, "caller-used"))).toBe(false);
    expect(authenticated).toBe(0);
  });
});
