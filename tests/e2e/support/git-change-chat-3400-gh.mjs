#!/usr/bin/env node
// Hermetic `gh api` boundary for #3400's browser journey. Git reads remain real. This process
// accepts only one repository, one pull request, and the exact GET/PATCH shapes used by the
// production PR-description service. Its state is transient test data and is never copied into
// release evidence.

import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const REPOSITORY = "fixture/git-change-chat-fork";
const PR_NUMBER = 42;
const STATE_PATH = process.env.KEIKO_GIT_CHANGE_CHAT_PROVIDER_STATE;
const INITIAL_BODY =
  "Human context before the managed region.\n\n" +
  "<!-- keiko:managed:v1:start -->Initial description.<!-- keiko:managed:v1:end -->\n\n" +
  "Human footer after the managed region.";

if (STATE_PATH === undefined || STATE_PATH.length === 0) deny();

function deny() {
  process.stderr.write("git-change-chat-provider-boundary-denied\n");
  process.exit(73);
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { body: INITIAL_BODY, updatedAt: "2026-09-06T00:00:00.000Z", updates: 0 };
  }
}

function writeState(state) {
  writeFileSync(`${STATE_PATH}.next`, JSON.stringify(state));
  renameSync(`${STATE_PATH}.next`, STATE_PATH);
}

function gitSha(ref) {
  const result = spawnSync("git", ["rev-parse", "--verify", ref], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) deny();
  return result.stdout.trim();
}

function identity() {
  return {
    number: PR_NUMBER,
    externalId: "PR_fixture_42",
    url: `https://github.com/${REPOSITORY}/pull/${String(PR_NUMBER)}`,
    repository: REPOSITORY,
    headRepository: REPOSITORY,
    headRef: "feature/x",
    headSha: gitSha("feature/x"),
    baseRef: "main",
    baseSha: gitSha("main"),
    state: "open",
    isDraft: false,
  };
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(0);
}

const args = process.argv.slice(2);
const method = args[args.indexOf("--method") + 1];
const host = args[args.indexOf("--hostname") + 1];
const endpoint = args.find((arg) => arg.startsWith("/repos/"));
const projection = args.at(-1);
const prefix = `/repos/${REPOSITORY}`;
if (args[0] !== "api" || host !== "github.com" || endpoint === undefined) deny();

if (method === "GET" && endpoint.startsWith(`${prefix}/pulls?`)) {
  const url = new URL(endpoint, "https://github.com");
  if (
    url.searchParams.get("state") !== "open" ||
    url.searchParams.get("head") !== "fixture:feature/x" ||
    url.searchParams.get("per_page") !== "2" ||
    url.searchParams.get("page") !== "1" ||
    projection?.startsWith("[.[] | ") !== true
  )
    deny();
  output([identity()]);
}

if (method === "GET" && endpoint === `${prefix}/pulls/${String(PR_NUMBER)}`) {
  const state = readState();
  if (projection?.startsWith("{identity:") === true) {
    output({ identity: identity(), body: state.body, updatedAt: state.updatedAt });
  }
  output(identity());
}

if (method === "PATCH" && endpoint === `${prefix}/pulls/${String(PR_NUMBER)}`) {
  const field = args[args.indexOf("-f") + 1];
  if (typeof field !== "string" || !field.startsWith("body=") || projection !== ".number") deny();
  const previous = readState();
  writeState({
    body: field.slice("body=".length),
    updatedAt: "2026-09-06T00:00:01.000Z",
    updates: previous.updates + 1,
  });
  output(PR_NUMBER);
}

deny();
