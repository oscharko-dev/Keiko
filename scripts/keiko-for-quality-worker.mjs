import {
  evaluateKeikoForQuality,
  requiredChecks,
  requiredChecksForProfile,
} from "./keiko-for-quality-core.mjs";

const checkName = "Keiko for Quality";
const dashboardMarker = "<!-- keiko-for-quality-dashboard:v1 -->";
const githubApi = "https://api.github.com";
const encoder = new TextEncoder();
const emptyPullNumbers = Object.freeze([]);
const deliveryRetentionMs = 86_400_000;
const postMergeReconciliationMs = 3_600_000;
const persistedPullPageSize = 100;
const persistedPullPageLimit = 10;

export function base64Url(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
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
      "User-Agent": "keiko-keiko-for-quality",
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

export async function allCheckRuns(path, token) {
  const checks = [];
  for (let page = 1; page <= 10; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const result = await github(`${path}${separator}per_page=100&page=${String(page)}`, token);
    if (!Array.isArray(result?.check_runs)) throw new Error("GitHub omitted check runs.");
    if (!Number.isInteger(result.total_count)) throw new Error("GitHub omitted check run count.");
    checks.push(...result.check_runs);
    if (checks.length >= result.total_count) return checks;
    if (result.check_runs.length < 100)
      throw new Error(`Incomplete paginated check runs for ${path}.`);
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
    appId(run.app) === Number(env.GITHUB_APP_ID)
  );
}

export function isOwnCommentEvent(event, payload, env) {
  return (
    event === "issue_comment" &&
    appId(payload.comment?.performed_via_github_app) === Number(env.GITHUB_APP_ID)
  );
}

export function appId(app) {
  return app?.id;
}

export function socketNoAlertEvidence(check) {
  if (
    appId(check.app) !== 156372 ||
    check.conclusion !== "success" ||
    check.name !== "Socket Security: Pull Request Alerts" ||
    check.output?.annotations_count !== 0
  )
    return false;
  const output = [check.output.title, check.output.summary, check.output.text]
    .filter((value) => typeof value === "string")
    .join("\n");
  return /\b(?:contains no net changes to dependencies|no dependency changes detected|no new alerts?)\b/iu.test(
    output,
  );
}

export async function evidence(owner, repository, pullNumber, headSha, token) {
  const [checkRuns, comments] = await Promise.all([
    allCheckRuns(`/repos/${owner}/${repository}/commits/${headSha}/check-runs`, token),
    allPages(`/repos/${owner}/${repository}/issues/${String(pullNumber)}/comments`, token),
  ]);
  return {
    checks: checkRuns.map((check) => ({
      appId: check.app?.id,
      completedAt: check.completed_at,
      conclusion: check.conclusion,
      headSha: check.head_sha,
      name: check.name,
      socketNoAlerts: socketNoAlertEvidence(check),
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
      id: comment.id,
      updatedAt: comment.updated_at,
    })),
  };
}

export function hardFailure(failures) {
  return failures.some(
    (failure) =>
      failure.startsWith("Wrong producer") ||
      failure.includes("unresolved finding") ||
      failure.includes("Socket warning") ||
      failure.includes("Socket reports") ||
      failure.startsWith("Check is not successful"),
  );
}

export async function publishCheck(owner, repository, headSha, result, token, env) {
  const checkRuns = await allCheckRuns(
    `/repos/${owner}/${repository}/commits/${headSha}/check-runs`,
    token,
  );
  const existing = checkRuns.find(
    (check) => check.name === checkName && appId(check.app) === Number(env.GITHUB_APP_ID),
  );
  const body = checkBody(result);
  const path =
    existing === undefined
      ? `/repos/${owner}/${repository}/check-runs`
      : `/repos/${owner}/${repository}/check-runs/${String(existing.id)}`;
  await github(path, token, {
    body: JSON.stringify(existing === undefined ? { ...body, head_sha: headSha } : body),
    method: existing === undefined ? "POST" : "PATCH",
  });
}

export function checkBody(result) {
  if (result.passed) {
    return {
      conclusion: "success",
      name: checkName,
      output: {
        summary: "All current-head Keiko for Quality evidence is valid.",
        title: checkName,
      },
      status: "completed",
    };
  }
  const body = {
    name: checkName,
    output: { summary: result.failures.join("\n"), title: checkName },
    status: "in_progress",
  };
  return hardFailure(result.failures)
    ? { ...body, conclusion: "failure", status: "completed" }
    : body;
}

function currentCheckCount(checks, headSha, expectedChecks) {
  return expectedChecks.filter(({ appId: expectedAppId, name }) =>
    checks.some(
      (check) =>
        check.appId === expectedAppId &&
        check.conclusion === "success" &&
        check.headSha === headSha &&
        check.name === name &&
        check.status === "completed",
    ),
  ).length;
}

function decision(result) {
  if (result.passed) return { icon: "✅", label: "Ready for auto-merge" };
  return hardFailure(result.failures)
    ? { icon: "❌", label: "Blocked" }
    : { icon: "⏳", label: "Waiting for evidence" };
}

function failureDetails(failures) {
  if (failures.length === 0) return "All exact-current-head evidence is valid.";
  return failures.map((failure) => `- ${failure}`).join("\n");
}

function evidenceState(failures, pattern, cleanLabel) {
  const failure = failures.find((entry) => pattern.test(entry));
  if (failure === undefined) return `✅ ${cleanLabel}`;
  return `${hardFailure([failure]) ? "❌" : "⏳"} ${failure}`;
}

export function dashboardComment({
  checks,
  expectedChecks = requiredChecks,
  headSha,
  pull,
  result,
}) {
  const state = decision(result);
  const successfulChecks = currentCheckCount(checks, headSha, expectedChecks);
  const autoMerge =
    pull.auto_merge === null || pull.auto_merge === undefined ? "not armed" : "armed";
  const blocked = hardFailure(result.failures);
  const incompleteEvidenceLabel = blocked ? "Blocking" : "Waiting";
  const detailsSummary = result.passed
    ? "Validated evidence"
    : `${incompleteEvidenceLabel} evidence (${String(result.failures.length)})`;
  return [
    dashboardMarker,
    "## Keiko for Quality",
    "",
    `${state.icon} **${state.label}**`,
    "",
    `\`head ${headSha.slice(0, 12)}\``,
    "",
    "| Gate group | Evidence |",
    "| --- | --- |",
    `| Required checks | ${String(successfulChecks)}/${String(expectedChecks.length)} successful |`,
    `| SonarQube Cloud | ${evidenceState(result.failures, /SonarCloud Code Analysis/iu, "native quality gate passed")} |`,
    `| Qodo review | ${evidenceState(result.failures, /Qodo/iu, "zero unresolved findings")} |`,
    `| Socket Security | ${evidenceState(result.failures, /Socket/iu, "zero unresolved alerts")} |`,
    `| Stability window | ${evidenceState(result.failures, /stability/iu, "settled")} |`,
    "",
    "| Automation | State |",
    "| --- | --- |",
    `| GitHub Auto-Merge | ${autoMerge} |`,
    "",
    `<details${blocked ? " open" : ""}>`,
    `<summary>${detailsSummary}</summary>`,
    "",
    failureDetails(result.failures),
    "",
    "</details>",
    "",
    "<sub>Exact-head, app-bound, fail-closed aggregate. This redacted status comment updates in place.</sub>",
  ].join("\n");
}

export async function publishDashboardComment({
  expectedChecks,
  owner,
  repository,
  pullNumber,
  currentEvidence,
  pull,
  result,
  token,
  env,
}) {
  const body = dashboardComment({
    ...currentEvidence,
    expectedChecks,
    headSha: pull.head.sha,
    pull,
    result,
  });
  const existing = currentEvidence.comments.find(
    (comment) =>
      comment.appId === Number(env.GITHUB_APP_ID) &&
      Number.isInteger(comment.id) &&
      comment.body.includes(dashboardMarker),
  );
  if (existing?.body === body) return;
  const path =
    existing === undefined
      ? `/repos/${owner}/${repository}/issues/${String(pullNumber)}/comments`
      : `/repos/${owner}/${repository}/issues/comments/${String(existing.id)}`;
  await github(path, token, {
    body: JSON.stringify({ body }),
    method: existing === undefined ? "POST" : "PATCH",
  });
}

function postMergeReconciliation(pull, evaluatedAt) {
  const mergedAt = Date.parse(pull.merged_at);
  return (
    pull.state === "closed" &&
    pull.merged === true &&
    Number.isFinite(mergedAt) &&
    mergedAt + postMergeReconciliationMs >= evaluatedAt
  );
}

function pullNeedsEvaluation(pull, baseBranch, evaluatedAt) {
  return (
    pull.base?.ref === baseBranch &&
    (pull.state === "open" || postMergeReconciliation(pull, evaluatedAt))
  );
}

async function persistEvaluatedPull(database, tracked, pull, result) {
  if (pull.state === "open" || !result.passed) await storeTrackedPull(database, tracked);
  else await deleteTrackedPull(database, tracked);
}

// A merge-commit head (2+ parents) has its Qodo review pinned to a parent (the feature commit), not
// the merge SHA, so surface those parent SHAs to let KFQ's head-SHA currency accept the review. A
// normal single-parent commit returns [] so it still binds to its exact SHA.
async function mergeParentShas(owner, repository, headSha, token) {
  const commit = await github(`/repos/${owner}/${repository}/commits/${headSha}`, token);
  const parents = Array.isArray(commit?.parents) ? commit.parents : [];
  return parents.length >= 2
    ? parents.map((parent) => parent?.sha).filter((sha) => isValidHeadSha(sha))
    : [];
}

async function evaluatePullRequest(owner, repository, pullNumber, installationId, env) {
  const target = targetForRepository(`${owner}/${repository}`, env);
  const token = await installationToken(installationId, env);
  const pull = await github(`/repos/${owner}/${repository}/pulls/${String(pullNumber)}`, token);
  const evaluatedAt = Date.now();
  if (!pullNeedsEvaluation(pull, target.baseBranch, evaluatedAt)) {
    await deleteTrackedPull(env.KEIKO_FOR_QUALITY_DB, { owner, pullNumber, repository });
    return;
  }
  const headSha = pull.head?.sha;
  if (!isValidHeadSha(headSha)) {
    throw new Error("Pull request head SHA is invalid.");
  }
  const mergeParents = await mergeParentShas(owner, repository, headSha, token);
  const currentEvidence = await evidence(owner, repository, pullNumber, headSha, token);
  const expectedChecks = requiredChecksForProfile(target.profile);
  const decisionResult = evaluateKeikoForQuality({
    ...currentEvidence,
    requiredChecks: expectedChecks,
    headSha,
    mergeParents,
    now: evaluatedAt,
    socketRiskAllowlist: JSON.parse(env.SOCKET_RISK_ALLOWLIST_JSON ?? "[]"),
    socketRiskActors: JSON.parse(env.SOCKET_RISK_ACTORS_JSON ?? "[]"),
    stabilityMs: parseStabilityMs(env.STABILITY_WINDOW_MS),
  });
  const result = { ...decisionResult, evaluatedAt };
  await publishCheck(owner, repository, headSha, result, token, env);
  await publishDashboardComment({
    expectedChecks,
    owner,
    repository,
    pullNumber,
    currentEvidence,
    pull,
    result,
    token,
    env,
  });
  const tracked = {
    installationId,
    owner,
    pullNumber,
    repository,
  };
  await persistEvaluatedPull(env.KEIKO_FOR_QUALITY_DB, tracked, pull, result);
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
  return undefined;
}

async function reserveWebhookDelivery(request, database) {
  const delivery = request.headers.get("X-GitHub-Delivery");
  if (delivery === null) return new Response("missing delivery", { status: 409 });
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(delivery))
    return new Response("invalid delivery", { status: 409 });
  if (!(await reserveDelivery(database, delivery)))
    return new Response("replayed delivery", { status: 409 });
  return undefined;
}

export async function reserveDelivery(database, delivery, now = Date.now()) {
  try {
    const result = await database
      .prepare("INSERT OR IGNORE INTO webhook_deliveries (delivery_id, expires_at) VALUES (?1, ?2)")
      .bind(delivery, now + deliveryRetentionMs)
      .run();
    const { changes } = result.meta;
    if (changes === 0) return false;
    if (changes === 1) return true;
    console.error("reserveDelivery failed errorKind=UnexpectedChangeCount");
    return false;
  } catch (error) {
    const errorKind = error instanceof Error ? error.name : "UnknownError";
    console.error(`reserveDelivery failed errorKind=${errorKind}`);
    return false;
  }
}

function preflightWebhookResponse(event, payload, env) {
  if (event === "ping") return new Response("pong", { status: 202 });
  if (
    !targetRepositories(env).some(({ repository }) => repository === payload.repository?.full_name)
  )
    return new Response("unexpected repository", { status: 403 });
  if (isOwnCheckEvent(event, payload, env) || isOwnCommentEvent(event, payload, env))
    return new Response("ignored", { status: 202 });
  return undefined;
}

async function dispatchWebhookEvent(event, payload, request, env, context) {
  const preflightResponse = preflightWebhookResponse(event, payload, env);
  if (preflightResponse !== undefined) return preflightResponse;
  const installationId = payload.installation?.id;
  if (!Number.isInteger(installationId))
    return new Response("missing installation", { status: 400 });
  const target = targetForRepository(payload.repository.full_name, env);
  const [owner, repository] = target.repository.split("/");
  const pullNumbers = new Set(pullRequestNumbers(event, payload));
  if (pullNumbers.size === 0) return new Response("accepted", { status: 202 });
  const reservationFailure = await reserveWebhookDelivery(request, env.KEIKO_FOR_QUALITY_DB);
  if (reservationFailure !== undefined) return reservationFailure;
  for (const pullNumber of pullNumbers) {
    context.waitUntil(evaluatePullRequest(owner, repository, pullNumber, installationId, env));
  }
  return new Response("accepted", { status: 202 });
}

async function handleWebhook(request, env, context) {
  if (env.KEIKO_FOR_QUALITY_DB === undefined)
    throw new Error("KEIKO_FOR_QUALITY_DB binding is required.");
  const body = await request.text();
  const authenticationFailure = await authenticateWebhook(request, env, body);
  if (authenticationFailure !== undefined) return authenticationFailure;
  const event = request.headers.get("X-GitHub-Event");
  if (event === null) return new Response("missing event", { status: 400 });
  const payload = JSON.parse(body);
  return dispatchWebhookEvent(event, payload, request, env, context);
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

function validatedRepository(value, legacy) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new Error(
      legacy ? "TARGET_REPOSITORY must be owner/repository." : "Invalid target repository.",
    );
  }
  return value;
}

function validatedBaseBranch(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._/-]{1,128}$/u.test(value))
    throw new Error("Invalid target base branch.");
  return value;
}

function validatedTarget(value, legacy = false) {
  const repository = validatedRepository(legacy ? value : value?.repository, legacy);
  const baseBranch = validatedBaseBranch(legacy ? "dev" : value?.baseBranch);
  const profile = legacy ? "keiko" : value?.profile;
  requiredChecksForProfile(profile);
  return { baseBranch, profile, repository };
}

export function targetRepositories(env) {
  if (env.TARGET_REPOSITORIES_JSON === undefined)
    return [validatedTarget(env.TARGET_REPOSITORY, true)];
  const values = parseJson(env.TARGET_REPOSITORIES_JSON);
  if (!Array.isArray(values) || values.length === 0)
    throw new Error("TARGET_REPOSITORIES_JSON must contain target profiles.");
  const targets = values.map((value) => validatedTarget(value));
  if (new Set(targets.map(({ repository }) => repository)).size !== targets.length)
    throw new Error("Target repositories must be unique.");
  return targets;
}

export function targetForRepository(repository, env) {
  const target = targetRepositories(env).find((candidate) => candidate.repository === repository);
  if (target === undefined) throw new Error("Repository is outside the quality target set.");
  return target;
}

async function repositoryInstallation(owner, repository, env) {
  const jwt = await appJwt(env);
  const installation = await github(`/repos/${owner}/${repository}/installation`, jwt);
  if (!Number.isInteger(installation?.id)) throw new Error("GitHub omitted installation ID.");
  return installation.id;
}

export async function discoverOpenPullRequests(env) {
  const discovered = [];
  for (const target of targetRepositories(env)) {
    const [owner, repository] = target.repository.split("/");
    const installationId = await repositoryInstallation(owner, repository, env);
    const token = await installationToken(installationId, env);
    const pulls = await allPages(
      `/repos/${owner}/${repository}/pulls?state=open&base=${encodeURIComponent(target.baseBranch)}`,
      token,
    );
    discovered.push(
      ...pulls.flatMap((pull) =>
        Number.isInteger(pull.number)
          ? [{ installationId, owner, pullNumber: pull.number, repository }]
          : [],
      ),
    );
  }
  return discovered;
}

function trackedPullKey(tracked) {
  return `${tracked.owner}/${tracked.repository}#${String(tracked.pullNumber)}`;
}

function trackedPullFromRow(row) {
  const tracked = {
    installationId: row?.installation_id,
    owner: row?.owner,
    pullNumber: row?.pull_number,
    repository: row?.repository,
  };
  return parseTrackedPull(JSON.stringify(tracked));
}

export async function trackedPullRequests(database) {
  const trackedPulls = new Map();
  for (let page = 0; page < persistedPullPageLimit; page += 1) {
    const queryLimit =
      page === persistedPullPageLimit - 1 ? persistedPullPageSize + 1 : persistedPullPageSize;
    const result = await database
      .prepare(
        "SELECT installation_id, owner, repository, pull_number FROM tracked_pulls ORDER BY owner, repository, pull_number LIMIT ?1 OFFSET ?2",
      )
      .bind(queryLimit, page * persistedPullPageSize)
      .all();
    if (!Array.isArray(result?.results)) throw new Error("D1 omitted tracked pull rows.");
    if (result.results.length > persistedPullPageSize)
      throw new Error("Tracked pull pagination limit exceeded.");
    for (const row of result.results) {
      const parsed = trackedPullFromRow(row);
      if (parsed.kind !== "valid") throw new Error("D1 returned an invalid tracked pull row.");
      const { tracked } = parsed;
      trackedPulls.set(trackedPullKey(tracked), tracked);
    }
    if (result.results.length < persistedPullPageSize) return trackedPulls;
  }
  return trackedPulls;
}

async function storeTrackedPull(database, tracked) {
  await database
    .prepare(
      "INSERT INTO tracked_pulls (owner, repository, pull_number, installation_id) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (owner, repository, pull_number) DO UPDATE SET installation_id = excluded.installation_id WHERE installation_id != excluded.installation_id",
    )
    .bind(tracked.owner, tracked.repository, tracked.pullNumber, tracked.installationId)
    .run();
}

async function deleteTrackedPull(database, tracked) {
  await database
    .prepare("DELETE FROM tracked_pulls WHERE owner = ?1 AND repository = ?2 AND pull_number = ?3")
    .bind(tracked.owner, tracked.repository, tracked.pullNumber)
    .run();
}

async function cleanupExpiredDeliveries(database, now) {
  await database.prepare("DELETE FROM webhook_deliveries WHERE expires_at <= ?1").bind(now).run();
}

export function reconciliationErrorKind(error) {
  return error instanceof Error ? error.name : "UnknownError";
}

async function reconciledPullRequests(env) {
  const pulls = new Map();
  try {
    for (const tracked of (await trackedPullRequests(env.KEIKO_FOR_QUALITY_DB)).values())
      pulls.set(trackedPullKey(tracked), tracked);
  } catch (error) {
    console.error(`tracked pull read failed errorKind=${reconciliationErrorKind(error)}`);
  }
  try {
    for (const discovered of await discoverOpenPullRequests(env))
      pulls.set(trackedPullKey(discovered), discovered);
  } catch (error) {
    console.error(`pull reconciliation failed errorKind=${reconciliationErrorKind(error)}`);
  }
  return pulls.values();
}

async function handleSchedule(controller, env, context) {
  if (env.KEIKO_FOR_QUALITY_DB === undefined)
    throw new Error("KEIKO_FOR_QUALITY_DB binding is required.");
  if (
    Number.isFinite(controller.scheduledTime) &&
    new Date(controller.scheduledTime).getUTCMinutes() === 0
  )
    context.waitUntil(cleanupExpiredDeliveries(env.KEIKO_FOR_QUALITY_DB, Date.now()));
  for (const tracked of await reconciledPullRequests(env))
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

export default {
  fetch: handleWebhook,
  scheduled(controller, env, context) {
    return handleSchedule(controller, env, context);
  },
};
