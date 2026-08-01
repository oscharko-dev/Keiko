#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateCodSpeedPolicy } from "./check-external-quality-config.mjs";
import { runCliCheck } from "./lib/run-cli-check.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = "https://gql.codspeed.io";
const QUERY = `query RepositoryQualitySettings($owner: String!, $repository: String!) {
  repository(name: $repository, owner: $owner) {
    settings { allowedRegression informationalCheckOnFailure commentingCondition }
  }
}`;

function output(message) {
  process.stdout.write(`${message}\n`);
}

function diagnostic(message) {
  process.stderr.write(`${message}\n`);
}

export function loadPolicySource(env = process.env, read = readFileSync) {
  const path =
    typeof env.QUALITY_CODSPEED_POLICY_PATH === "string" &&
    env.QUALITY_CODSPEED_POLICY_PATH.length > 0
      ? env.QUALITY_CODSPEED_POLICY_PATH
      : join(REPO_ROOT, ".codspeed-policy.json");
  return read(path, "utf8");
}

function parsePolicy(source) {
  const problems = validateCodSpeedPolicy(source);
  if (problems.length > 0) throw new Error(problems[0]);
  return JSON.parse(source);
}

function extractSettings(payload) {
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error("live settings response contains GraphQL errors");
  }
  const settings = payload?.data?.repository?.settings;
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("live settings response is missing the project settings object");
  }
  return settings;
}

export function validateLiveSettings(policy, payload) {
  const settings = extractSettings(payload);
  const expectedRegression = policy.regressionThresholdPercent / 100;
  const problems = [];
  if (settings.allowedRegression > expectedRegression) {
    problems.push("live regression threshold differs from the repository policy");
  }
  if (settings.informationalCheckOnFailure !== !policy.failOnRegression) {
    problems.push("live performance failures are not configured as blocking checks");
  }
  if (settings.commentingCondition !== policy.pullRequestReport.toUpperCase()) {
    problems.push("live pull-request reporting differs from the repository policy");
  }
  return problems;
}

async function requestSettings(request) {
  const response = await request(ENDPOINT, {
    body: JSON.stringify({
      query: QUERY,
      variables: { owner: "oscharko-dev", repository: "Keiko" },
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("live settings request did not succeed");
  return response.json();
}

export async function checkCodSpeedPolicy(source, request = globalThis.fetch) {
  const policy = parsePolicy(source);
  const payload = await requestSettings(request);
  return validateLiveSettings(policy, payload);
}

export async function main(
  source = loadPolicySource(),
  request = globalThis.fetch,
  log = output,
  error = diagnostic,
) {
  return runCliCheck({
    check: () => checkCodSpeedPolicy(source, request),
    error,
    failureFallback: "live policy validation failed",
    failurePrefix: "codspeed-policy",
    log,
    passMessage: "codspeed-policy: PASS — live project settings match the blocking 5% policy",
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
