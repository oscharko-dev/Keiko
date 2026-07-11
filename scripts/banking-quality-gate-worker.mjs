import { evaluateBankingQualityGate } from "./banking-quality-gate-core.mjs";

const checkName = "Banking Quality Gate";
const githubApi = "https://api.github.com";
const encoder = new TextEncoder();

function base64Url(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function bytesFromHex(value) {
  return Uint8Array.from(value.match(/.{2}/gu), (byte) => Number.parseInt(byte, 16));
}

function constantTimeEqual(left, right) {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function verifyWebhookSignature(body, signature, secret) {
  const expected = signature?.match(/^sha256=([0-9a-f]{64})$/iu)?.[1];
  if (expected === undefined) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const actual = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return constantTimeEqual(actual, bytesFromHex(expected));
}

function privateKeyBytes(pem) {
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/u.exec(pem);
  if (match === null) throw new Error("GITHUB_PRIVATE_KEY_PKCS8 must contain a PKCS#8 key.");
  const binary = atob(match[1].replace(/\s/gu, ""));
  return Uint8Array.from(binary, (character) => character.codePointAt(0));
}

async function appJwt(env, now = Math.floor(Date.now() / 1000)) {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ exp: now + 540, iat: now - 60, iss: String(env.GITHUB_APP_ID) }),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes(env.GITHUB_PRIVATE_KEY_PKCS8),
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["sign"],
  );
  const value = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(value));
  return `${value}.${base64Url(signature)}`;
}

async function github(path, token, init = {}) {
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

async function allPages(path, token) {
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

function normalizeAuthor(login) {
  return String(login ?? "").replace(/\[bot\]$/u, "");
}

const pullNumberExtractors = {
  check_run: (payload) => (payload.check_run?.pull_requests ?? []).map(({ number }) => number),
  check_suite: (payload) => (payload.check_suite?.pull_requests ?? []).map(({ number }) => number),
  issue_comment: (payload) =>
    payload.issue?.pull_request === undefined ? [] : [payload.issue.number],
  pull_request: (payload) => [payload.pull_request?.number ?? payload.number],
  pull_request_review: (payload) => [payload.pull_request?.number ?? payload.number],
};

export function pullRequestNumbers(event, payload) {
  const extractor = pullNumberExtractors[event];
  return extractor === undefined ? [] : extractor(payload).filter(Number.isInteger);
}

function isOwnCheckEvent(event, payload, env) {
  return (
    event === "check_run" &&
    payload.check_run?.name === checkName &&
    payload.check_run?.app?.id === Number(env.GITHUB_APP_ID)
  );
}

async function evidence(owner, repository, pullNumber, headSha, token) {
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
      author: normalizeAuthor(comment.user?.login),
      authorAssociation: comment.author_association,
      body: String(comment.body ?? ""),
      updatedAt: comment.updated_at,
    })),
    reviews: reviews.map((review) => ({
      author: normalizeAuthor(review.user?.login),
      commitSha: review.commit_id,
      state: review.state,
    })),
  };
}

function hardFailure(failures) {
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

async function publishCheck(owner, repository, headSha, result, token, env) {
  const checkPayload = await github(
    `/repos/${owner}/${repository}/commits/${headSha}/check-runs?per_page=100`,
    token,
  );
  const existing = (checkPayload.check_runs ?? []).find(
    (check) => check.name === checkName && check.app?.id === Number(env.GITHUB_APP_ID),
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
  if (pull.state !== "open" || pull.base?.ref !== "dev") return;
  const headSha = pull.head?.sha;
  if (!/^[0-9a-f]{40}$/u.test(headSha ?? "")) throw new Error("Pull request head SHA is invalid.");
  const currentEvidence = await evidence(owner, repository, pullNumber, headSha, token);
  const result = evaluateBankingQualityGate({
    ...currentEvidence,
    headSha,
    now: Date.now(),
    socketRiskAllowlist: JSON.parse(env.SOCKET_RISK_ALLOWLIST_JSON ?? "[]"),
    socketRiskActors: JSON.parse(env.SOCKET_RISK_ACTORS_JSON ?? "[]"),
    stabilityMs: Number(env.STABILITY_WINDOW_MS ?? "60000"),
  });
  await publishCheck(owner, repository, headSha, result, token, env);
  await env.BANKING_GATE_STATE.put(
    `pull:${owner}/${repository}/${String(pullNumber)}`,
    JSON.stringify({ installationId, owner, pullNumber, repository }),
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
  const event = request.headers.get("X-GitHub-Event") ?? "";
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

async function handleSchedule(env, context) {
  let cursor;
  do {
    const page = await env.BANKING_GATE_STATE.list({ cursor, prefix: "pull:" });
    for (const key of page.keys) {
      const tracked = JSON.parse(await env.BANKING_GATE_STATE.get(key.name));
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
