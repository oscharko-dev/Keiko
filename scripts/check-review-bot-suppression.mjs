#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_EVENT_BYTES = 1_048_576;
const SUPPRESSION_COMMANDS = [
  /@coderabbitai\s+(?:ignore|pause|resolve)\b/iu,
  /@greptileai\s+(?:disable|ignore|pause)\b/iu,
];

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

export function validateReviewBotSuppression(event) {
  if (!isObject(event)) return ["GitHub event payload must be a JSON object"];
  if (event.pull_request === undefined) return [];
  if (!isObject(event.pull_request)) return ["pull-request metadata must be a JSON object"];
  return validatePullRequestMetadata(event.pull_request);
}

function validateOptionalText(value, label) {
  return value === null || value === undefined || typeof value === "string"
    ? []
    : [`pull-request ${label} must be text when present`];
}

function validatePullRequestMetadata(pullRequest) {
  const titleProblems = validateOptionalText(pullRequest.title, "title");
  const bodyProblems = validateOptionalText(pullRequest.body, "body");
  if (titleProblems.length > 0 || bodyProblems.length > 0) {
    return [...titleProblems, ...bodyProblems];
  }
  const title = pullRequest.title ?? "";
  const body = pullRequest.body ?? "";
  const metadata = `${title}\n${body}`;
  return SUPPRESSION_COMMANDS.some((pattern) => pattern.test(metadata))
    ? ["pull-request metadata must not suppress an automatic review bot"]
    : [];
}

function handleMissingEvent(githubActions, log, error) {
  if (githubActions) {
    error("review-bot-suppression: GitHub event payload is unavailable");
    return 1;
  }
  log("review-bot-suppression: SKIP — no local GitHub event payload");
  return 0;
}

function evaluateEvent(eventPath, log, error) {
  try {
    const problems = validateReviewBotSuppression(readEvent(eventPath));
    for (const problem of problems) error(`review-bot-suppression: ${problem}`);
    if (problems.length > 0) return 1;
  } catch {
    error("review-bot-suppression: GitHub event payload is invalid");
    return 1;
  }
  log("review-bot-suppression: PASS — pull-request metadata keeps automatic review enabled");
  return 0;
}

function readEvent(eventPath) {
  const source = readFileSync(eventPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_EVENT_BYTES) {
    throw new Error("event payload exceeds the review-policy size limit");
  }
  return JSON.parse(source);
}

function isNonPullRequestEvent(eventName) {
  return typeof eventName === "string" && eventName.length > 0 && eventName !== "pull_request";
}

export function main(
  eventPath = process.env.GITHUB_EVENT_PATH,
  githubActions = process.env.GITHUB_ACTIONS === "true",
  log = console.log,
  error = console.error,
  eventName = process.env.GITHUB_EVENT_NAME,
) {
  if (isNonPullRequestEvent(eventName)) {
    log("review-bot-suppression: SKIP — event does not carry pull-request metadata");
    return 0;
  }
  if (eventPath === undefined || eventPath.length === 0) {
    return handleMissingEvent(githubActions, log, error);
  }
  return evaluateEvent(eventPath, log, error);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
