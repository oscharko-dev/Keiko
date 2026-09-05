// Test-only provider boundary. Ordinary Git remains real; accepted remote effects target a real
// disposable bare repository. This is composed functional evidence, never live authentication.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, join, relative, isAbsolute } from "node:path";
import type { GitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import { GIT_PR_IDENTITY_JQ } from "../../../packages/keiko-tools/src/git-pr-gateway.js";
import {
  DELIVERY_REPOSITORY,
  DELIVERY_URL,
  deliveryProviderState,
  deliveryRemote,
  deliveryRepository,
} from "../support/coding-issue-delivery.js";

export interface DeliveryProviderState {
  readonly headRef: string;
  readonly pushes: number;
  readonly creates: number;
  readonly rejections: number;
  readonly mode: "normal" | "push-response-loss" | "create-response-loss" | "read-failure";
  readonly pullRequests: readonly GitPullRequestIdentity[];
  readonly lastTitleDigest?: string;
  readonly lastBodyDigest?: string;
  readonly lastPush?: {
    readonly sha: string;
    readonly ref: string;
    readonly privateView: boolean;
    readonly pinnedCredentialHost: boolean;
  };
}

function readState(stateDir: string): DeliveryProviderState {
  return JSON.parse(readFileSync(deliveryProviderState(stateDir), "utf8")) as DeliveryProviderState;
}
function writeState(stateDir: string, state: DeliveryProviderState): void {
  const path = deliveryProviderState(stateDir);
  writeFileSync(`${path}.next`, JSON.stringify(state));
  renameSync(`${path}.next`, path);
}
function deny(stateDir: string): never {
  const state = readState(stateDir);
  writeState(stateDir, { ...state, rejections: state.rejections + 1 });
  process.stderr.write("fixture-provider-boundary-denied\n");
  process.exit(73);
}

/** The wrapper executables are outside every repository/managed worktree and contain no token. */
export function installDeliveryTransport(stateDir: string): {
  readonly realGit: string;
  readonly bin: string;
} {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(stateDir, "provider-bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(stateDir, "provider-home"), { recursive: true });
  for (const tool of ["git", "gh"] as const) {
    const invocation = `import { runDeliveryTransport } from ${JSON.stringify(import.meta.url)};\nrunDeliveryTransport(${JSON.stringify({ stateDir, realGit, tool })});\n`;
    writeFileSync(join(bin, tool), `#!${process.execPath}\n${invocation}`, { mode: 0o755 });
  }
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  return { realGit, bin };
}

export function initializeDeliveryRemote(stateDir: string, realGit: string): void {
  execFileSync(
    realGit,
    ["clone", "--bare", "--quiet", deliveryRepository(stateDir), deliveryRemote(stateDir)],
    { timeout: 30_000 },
  );
  writeState(stateDir, {
    headRef: "unselected",
    pushes: 0,
    creates: 0,
    rejections: 0,
    mode: "normal",
    pullRequests: [],
  });
}

interface Invocation {
  readonly stateDir: string;
  readonly realGit: string;
  readonly tool: "git" | "gh";
}
const LOCAL_GIT = new Set([
  "init",
  "config",
  "add",
  "commit",
  "worktree",
  "rev-parse",
  "status",
  "diff",
  "show",
  "cat-file",
  "symbolic-ref",
  "ls-files",
  "version",
  "check-ref-format",
  "rev-list",
  "merge-base",
  "restore",
  "rm",
  "log",
  "update-index",
  "hash-object",
  "update-ref",
  "remote",
  "for-each-ref",
  "branch",
  "show-ref",
  "ls-tree",
  "read-tree",
  "diff-index",
  "check-attr",
  "write-tree",
  "commit-tree",
]);

function gitCommandIndex(args: readonly string[]): number {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (arg === "-c" || arg === "-C" || arg === "--git-dir" || arg === "--work-tree") index += 2;
    else if (arg.startsWith("-")) index += 1;
    else return index;
  }
  return -1;
}

function gitInvocation(input: Invocation, args: readonly string[]): void {
  const index = gitCommandIndex(args);
  const command = args.includes("--version") ? "version" : (args[index] ?? "");
  if (command === "push") {
    push(input, args, index);
    return;
  }
  if (!LOCAL_GIT.has(command)) deny(input.stateDir);
  // `remote` only inspects or sets local metadata; helper transport never fetches it implicitly.
  if (
    command === "remote" &&
    !new Set(["", "add", "get-url", "set-url"]).has(args[index + 1] ?? "")
  )
    deny(input.stateDir);
  const result = spawnSync(input.realGit, [...args], { stdio: "inherit", timeout: 30_000 });
  process.exit(result.status ?? 74);
}

function push(input: Invocation, args: readonly string[], index: number): void {
  const state = readState(input.stateDir);
  const remote = args[index + 1];
  const spec = args[index + 2] ?? "";
  const match = /^([a-f0-9]{40}):refs\/heads\/(.+)$/u.exec(spec);
  if (remote !== DELIVERY_URL || args.length !== index + 3 || match?.[2] !== state.headRef)
    deny(input.stateDir);
  const result = spawnSync(
    input.realGit,
    [...args.slice(0, index + 1), deliveryRemote(input.stateDir), spec],
    { stdio: "inherit", timeout: 30_000 },
  );
  if (result.status !== 0) process.exit(result.status ?? 74);
  writeState(input.stateDir, {
    ...state,
    pushes: state.pushes + 1,
    pullRequests: state.pullRequests.map((pr) =>
      pr.headRef === state.headRef ? { ...pr, headSha: match[1] ?? "" } : pr,
    ),
    lastPush: pushEvidence(input, args, state.headRef, match[1] ?? ""),
  });
  if (state.mode === "push-response-loss") {
    process.stderr.write("remote connection failed\n");
    process.exit(1);
  }
  process.exit(0);
}

function privateViewMatches(input: Invocation, sha: string): boolean {
  const dir = process.env.GIT_DIR;
  if (dir === undefined || process.env.GIT_CONFIG_COUNT !== "0") return false;
  const result = spawnSync(input.realGit, ["rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return [
    outside(process.cwd(), dir),
    outside(join(deliveryRepository(input.stateDir), ".git"), dir),
    process.env.GIT_OBJECT_DIRECTORY ===
      join(deliveryRepository(input.stateDir), ".git", "objects"),
    result.status === 0,
    result.stdout.trim() === sha,
  ].every(Boolean);
}
function outside(root: string, child: string): boolean {
  const path = relative(root, child);
  return path === ".." || path.startsWith("../") || isAbsolute(path);
}

function pushEvidence(
  input: Invocation,
  args: readonly string[],
  ref: string,
  sha: string,
): NonNullable<DeliveryProviderState["lastPush"]> {
  return {
    sha,
    ref,
    privateView: privateViewMatches(input, sha),
    pinnedCredentialHost: args.some((arg) =>
      arg.startsWith("credential.https://github.com.helper="),
    ),
  };
}

function remoteSha(input: Invocation, ref: string): string | undefined {
  const result = spawnSync(
    input.realGit,
    ["--git-dir", deliveryRemote(input.stateDir), "rev-parse", "--verify", `refs/heads/${ref}`],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  );
  return result.status === 0 ? result.stdout.trim() : undefined;
}
function providerOutput(value: unknown): never {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}
function notFound(): never {
  process.stderr.write("HTTP 404: Not Found\n");
  process.exit(1);
}

function ghInvocation(input: Invocation, args: readonly string[]): void {
  const state = readState(input.stateDir);
  const method = args[args.indexOf("--method") + 1];
  const host = args[args.indexOf("--hostname") + 1];
  const endpoint = args.find((arg) => arg.startsWith("/repos/")) ?? "";
  if (
    args[0] !== "api" ||
    host !== "github.com" ||
    !endpoint.startsWith(`/repos/${DELIVERY_REPOSITORY}/`)
  )
    deny(input.stateDir);
  if (method === "POST" && endpoint === `/repos/${DELIVERY_REPOSITORY}/pulls`) {
    createPullRequest(input, args, state);
    return;
  }
  if (method !== "GET") deny(input.stateDir);
  if (state.mode === "read-failure") {
    process.stderr.write("HTTP 503: Service Unavailable\n");
    process.exit(1);
  }
  readProvider(input, endpoint, state, args.at(-1) ?? "");
}

function readProvider(
  input: Invocation,
  endpoint: string,
  state: DeliveryProviderState,
  projection: string,
): void {
  const prefix = `/repos/${DELIVERY_REPOSITORY}`;
  if (endpoint.startsWith(`${prefix}/git/ref/heads/`)) {
    readBranch(input, endpoint, state, projection);
    return;
  }
  const url = new URL(endpoint, "https://github.com");
  if (url.pathname === `${prefix}/pulls`) {
    if (
      url.searchParams.get("head") !== `fixture:${state.headRef}` ||
      projection !== `[.[] | ${GIT_PR_IDENTITY_JQ}]`
    )
      deny(input.stateDir);
    providerOutput(state.pullRequests.filter((pr) => pr.headRef === state.headRef));
  }
  const pr = state.pullRequests.find(
    (candidate) => endpoint === `${prefix}/pulls/${String(candidate.number)}`,
  );
  if (pr === undefined || projection !== GIT_PR_IDENTITY_JQ) deny(input.stateDir);
  providerOutput(pr);
}

function readBranch(
  input: Invocation,
  endpoint: string,
  state: DeliveryProviderState,
  projection: string,
): never {
  const prefix = `/repos/${DELIVERY_REPOSITORY}`;
  const ref = decodeURIComponent(endpoint.slice(`${prefix}/git/ref/heads/`.length));
  if (
    (ref !== "main" && ref !== state.headRef) ||
    projection !== "{ref,sha:.object.sha,type:.object.type}"
  )
    deny(input.stateDir);
  const sha = remoteSha(input, ref);
  if (sha === undefined) notFound();
  providerOutput({ ref: `refs/heads/${ref}`, sha, type: "commit" });
}

function createPullRequest(
  input: Invocation,
  args: readonly string[],
  state: DeliveryProviderState,
): void {
  const fields = createFields(input, args, state);
  const headSha = remoteSha(input, state.headRef);
  const baseSha = remoteSha(input, "main");
  if (headSha === undefined || baseSha === undefined) notFound();
  const number = state.creates + 1;
  const identity: GitPullRequestIdentity = {
    number,
    externalId: `PR_fixture_${String(number)}`,
    url: `https://github.com/${DELIVERY_REPOSITORY}/pull/${String(number)}`,
    repository: DELIVERY_REPOSITORY,
    headRepository: DELIVERY_REPOSITORY,
    headRef: state.headRef,
    headSha,
    baseRef: "main",
    baseSha,
    state: "open",
    isDraft: true,
  };
  writeState(input.stateDir, {
    ...state,
    creates: number,
    pullRequests: [...state.pullRequests, identity],
    lastTitleDigest: digest(fields.get("title") ?? ""),
    lastBodyDigest: digest(fields.get("body") ?? ""),
  });
  if (state.mode === "create-response-loss") {
    process.stderr.write("HTTP 503: Service Unavailable\n");
    process.exit(1);
  }
  providerOutput(identity);
}
function createFields(
  input: Invocation,
  args: readonly string[],
  state: DeliveryProviderState,
): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    if (!new Set(["-f", "-F"]).has(args[i] ?? "")) continue;
    const value = args[i + 1] ?? "";
    const key = value.slice(0, value.indexOf("="));
    if (fields.has(key)) deny(input.stateDir);
    fields.set(key, value.slice(key.length + 1));
  }
  assertCreateFields(input, args, state, fields);
  return fields;
}

function assertCreateFields(
  input: Invocation,
  args: readonly string[],
  state: DeliveryProviderState,
  fields: ReadonlyMap<string, string>,
): void {
  const keys = ["head", "base", "draft", "title", "body"];
  if (!keys.every((key) => fields.has(key))) deny(input.stateDir);
  if (
    fields.size !== 5 ||
    fields.get("head") !== state.headRef ||
    fields.get("base") !== "main" ||
    fields.get("draft") !== "true" ||
    args.at(-1) !== GIT_PR_IDENTITY_JQ
  )
    deny(input.stateDir);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function runDeliveryTransport(input: Invocation): void {
  const args = process.argv.slice(2);
  if (input.tool === "git") gitInvocation(input, args);
  else ghInvocation(input, args);
}
