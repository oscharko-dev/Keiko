import { evaluateBankingQualityGate } from "./banking-quality-gate-core.mjs";

const checkName = "Banking Quality Gate";
const githubApi = "https://api.github.com";
const encoder = new TextEncoder();
const emptyPullNumbers = Object.freeze([]);
const emptyCheckRuns = Object.freeze([]);

export function base64Url(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function bytesFromHex(value) {
  return Uint8Array.from(value.match(/.{2}/gu), (byte) => Number.parseInt(byte, 16));
}

export function constantTimeEqual(left, right) {
  let difference = 0;
  for (const [index, byte] of left.entries()) difference |= byte ^ right[index];
  return difference === 0;
}

export async function verifyWebhookSignature(body, signature, secret) {
  const expected = signature?.match(/^sha256=([0-9a-f]{64})$/iu)?.[1];
  if (expected === undefined) return false;
  const key = await importWebhookKey(secret);
  const actual = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return constantTimeEqual(actual, bytesFromHex(expected));
}

export function importWebhookKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
}

export function privateKeyBytes(pem) {
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/u.exec(pem);
  if (match === null) throw new Error("GITHUB_PRIVATE_KEY_PKCS8 must contain a PKCS#8 key.");
  const binary = atob(match[1].replace(/\s/gu, ""));
  return Uint8Array.from(binary, (character) => character.codePointAt(0));
}

export async function appJwt(env, now = Math.floor(Date.now() / 1000)) {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ exp: now + 540, iat: now - 60, iss: String(env.GITHUB_APP_ID) }),
  );
  const key = await importAppKey(env.GITHUB_PRIVATE_KEY_PKCS8);
  const value = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(value));
  return `${value}.${base64Url(signature)}`;
}

export function importAppKey(pem) {
  return crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes(pem),
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["sign"],
  );
}

export async function github(path, token, init = {}) {
  const response = await fetch(`${githubApi}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "keiko-banking-quality-gate",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}.`);
  return response.status === 204 ? undefined : response.json();
}

async function installationToken(installationId, env) {
  const jwt = await appJwt(env);
  const result = await github(`/app/installations/${String(installationId)}/access_tokens`, jwt, {
    method: "POST",
  });
  if (typeof result?.token !== "string") throw new Error("GitHub omitted installation token.");
  return result.token;
}

export async function allPages(path, token) {
  const values = [];
  for (let page = 1; page <= 10; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const result = await github(`${path}${separator}per_page=100&page=${String(page)}`, token);
    if (!Array.isArray(result)) throw new Error(`Expected paginated array for ${path}.`);
    values.push(...result);
    if (result.length < 100) return values;
  }
  throw new Error(`Pagination limit exceeded for ${path}.`);
}

const pullNumberExtractors = {
  check_run: (payload) =>
    (payload.check_run?.pull_requests ?? emptyPullNumbers).map(({ number }) => number),
  check_suite: (payload) =>
    (payload.check_suite?.pull_requests ?? emptyPullNumbers).map(({ number }) => number),
  issue_comment: (payload) =>
    payload.issue?.pull_request === undefined ? emptyPullNumbers : [payload.issue.number],
  pull_request: (payload) => [payload.pull_request?.number ?? payload.number],
  pull_request_review: (payload) => [payload.pull_request?.number ?? payload.number],
};

export function pullRequestNumbers(event, payload) {
  const extractor = pullNumberExtractors[event];
  return extractor === undefined ? [] : extractor(payload).filter(Number.isInteger);
}

export function isOwnCheckEvent(event, payload, env) {
  const run = payload.check_run;
  return (
    event === "check_run" &&
    run !== undefined &&
    run.name === checkName &&
    run.app !== undefined &&
    run.app !== null &&
    run.app.id === Number(env.GITHUB_APP_ID)
  );
}

export async function evidence(owner, repository, pullNumber, headSha, token) {
  const [checkPayload, reviews, comments] = await Promise.all([
    github(`/repos/${owner}/${repository}/commits/${headSha}/check-runs?per_page=100`, token),
    allPages(`/repos/${owner}/${repository}/pulls/${String(pullNumber)}/reviews`, token),
    allPages(`/repos/${owner}/${repository}/issues/${String(pullNumber)}/comments`, token),
  ]);
  if (!Array.isArray(checkPayload?.check_runs)) throw new Error("GitHub omitted check runs.");
  return {
    checks: checkPayload.check_runs.map((check) => ({
      appId: check.app?.id,
      completedAt: check.completed_at,
      conclusion: check.conclusion,
      headSha: check.head_sha,
      name: check.name,
      startedAt: check.started_at,
      status: check.status,
    })),
    comments: comments.map((comment) => ({
      appId: comment.performed_via_github_app?.id,
      author: String(comment.user?.login ?? ""),
      authorAssociation: comment.author_association,
      authorId: comment.user?.id,
      authorType: comment.user?.type,
      body: String(comment.body ?? ""),
      updatedAt: comment.updated_at,
    })),
    reviews: reviews.map((review) => ({
      authorId: review.user?.id,
      authorType: review.user?.type,
      commitSha: review.commit_id,
      state: review.state,
    })),
  };
}

export function hardFailure(failures) {
  return failures.some(
    (failure) =>
      failure.startsWith("Wrong producer") ||
      failure.includes("CHANGES_REQUESTED") ||
      failure.includes("unresolved finding") ||
      failure.includes("Socket warning") ||
      failure.includes("Socket reports") ||
      failure.startsWith("Check is not successful"),
  );
}

export async function publishCheck(owner, repository, headSha, result, token, env) {
  const checkPayload = await github(
    `/repos/${owner}/${repository}/commits/${headSha}/check-runs?per_page=100`,
    token,
  );
  const existing = (checkPayload.check_runs ?? emptyCheckRuns).find(
    (check) =>
      check.name === checkName &&
      check.app !== undefined &&
      check.app !== null &&
      check.app.id === Number(env.GITHUB_APP_ID),
  );
  const body = result.passed
    ? {
        conclusion: "success",
        name: checkName,
        output: {
          summary: "All current-head Banking Quality Gate evidence is valid.",
          title: checkName,
        },
        status: "completed",
      }
    : hardFailure(result.failures)
      ? {
          conclusion: "failure",
          name: checkName,
          output: { summary: result.failures.join("\n"), title: checkName },
          status: "completed",
        }
      : {
          name: checkName,
          output: { summary: result.failures.join("\n"), title: checkName },
          status: "in_progress",
        };
  const path =
    existing === undefined
      ? `/repos/${owner}/${repository}/check-runs`
      : `/repos/${owner}/${repository}/check-runs/${String(existing.id)}`;
  await github(path, token, {
    body: JSON.stringify(existing === undefined ? { ...body, head_sha: headSha } : body),
    method: existing === undefined ? "POST" : "PATCH",
  });
}

async function evaluatePullRequest(owner, repository, pullNumber, installationId, env) {
  const token = await installationToken(installationId, env);
  const pull = await github(`/repos/${owner}/${repository}/pulls/${String(pullNumber)}`, token);
  const stateKey = `pull:${owner}/${repository}/${String(pullNumber)}`;
  if (pull.state !== "open" || pull.base?.ref !== "dev") {
    await env.BANKING_GATE_STATE.delete(stateKey);
    return;
  }
  const headSha = pull.head?.sha;
  if (!isValidHeadSha(headSha)) {
    throw new Error("Pull request head SHA is invalid.");
  }
  const currentEvidence = await evidence(owner, repository, pullNumber, headSha, token);
  const result = evaluateBankingQualityGate({
    ...currentEvidence,
    headSha,
    now: Date.now(),
    socketRiskAllowlist: JSON.parse(env.SOCKET_RISK_ALLOWLIST_JSON ?? "[]"),
    socketRiskActors: JSON.parse(env.SOCKET_RISK_ACTORS_JSON ?? "[]"),
    stabilityMs: parseStabilityMs(env.STABILITY_WINDOW_MS),
  });
  await publishCheck(owner, repository, headSha, result, token, env);
  await env.BANKING_GATE_STATE.put(
    stateKey,
    JSON.stringify({ installationId, owner, pullNumber, repository }),
    { expirationTtl: 2_592_000 },
  );
}

async function authenticateWebhook(request, env, body) {
  if (
    !(await verifyWebhookSignature(
      body,
      request.headers.get("X-Hub-Signature-256"),
      env.GITHUB_WEBHOOK_SECRET,
    ))
  ) {
    return new Response("invalid signature", { status: 401 });
  }
  const delivery = request.headers.get("X-GitHub-Delivery");
  if (delivery === null) return new Response("missing delivery", { status: 409 });
  if ((await env.BANKING_GATE_STATE.get(`delivery:${delivery}`)) !== null)
    return new Response("replayed delivery", { status: 409 });
  await env.BANKING_GATE_STATE.put(`delivery:${delivery}`, "1", { expirationTtl: 86_400 });
  return undefined;
}

async function handleWebhook(request, env, context) {
  if (env.BANKING_GATE_STATE === undefined)
    throw new Error("BANKING_GATE_STATE binding is required.");
  const body = await request.text();
  const authenticationFailure = await authenticateWebhook(request, env, body);
  if (authenticationFailure !== undefined) return authenticationFailure;
  const event = request.headers.get("X-GitHub-Event");
  if (event === null) return new Response("missing event", { status: 400 });
  const payload = JSON.parse(body);
  if (payload.repository?.full_name !== env.TARGET_REPOSITORY) {
    return new Response("unexpected repository", { status: 403 });
  }
  if (isOwnCheckEvent(event, payload, env)) return new Response("ignored", { status: 202 });
  const installationId = payload.installation?.id;
  if (!Number.isInteger(installationId))
    return new Response("missing installation", { status: 400 });
  const [owner, repository] = env.TARGET_REPOSITORY.split("/");
  for (const pullNumber of new Set(pullRequestNumbers(event, payload))) {
    context.waitUntil(evaluatePullRequest(owner, repository, pullNumber, installationId, env));
  }
  return new Response("accepted", { status: 202 });
}

export function parseTrackedPull(value) {
  if (value === null) return { kind: "missing" };
  const tracked = parseJson(value);
  if (
    typeof tracked?.owner !== "string" ||
    typeof tracked.repository !== "string" ||
    !Number.isInteger(tracked.pullNumber) ||
    !Number.isInteger(tracked.installationId)
  ) {
    return { kind: "invalid" };
  }
  return { kind: "valid", tracked };
}

export function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    // Malformed persisted state is represented by undefined below.
  }
  return undefined;
}

export function parseStabilityMs(value) {
  if (value === undefined || value.trim() === "") return 60_000;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
}

export function isValidHeadSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

async function handleSchedule(env, context) {
  let cursor;
  do {
    const page = await env.BANKING_GATE_STATE.list({ cursor, prefix: "pull:" });
    for (const key of page.keys) {
      const result = parseTrackedPull(await env.BANKING_GATE_STATE.get(key.name));
      if (result.kind === "missing") continue;
      if (result.kind === "invalid") {
        await env.BANKING_GATE_STATE.delete(key.name);
        continue;
      }
      const { tracked } = result;
      context.waitUntil(
        evaluatePullRequest(
          tracked.owner,
          tracked.repository,
          tracked.pullNumber,
          tracked.installationId,
          env,
        ),
      );
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
}

export default {
  fetch: handleWebhook,
  scheduled(_controller, env, context) {
    return handleSchedule(env, context);
  },
};
