const actionsAppId = 15368;
const gitarIdentity = { appId: 827041, userId: 159877585 };
const socketIdentity = { appId: 156372, userId: 95510084 };
const npmRiskPattern = /^npm\/(?:@[^/\s]+\/)?[^@\s]+@[^\s]+$/u;
const runningCheckStatuses = new Set(["in_progress", "queued"]);
const terminalConclusions = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "success",
  "timed_out",
]);

export const requiredChecks = [
  ["ci", actionsAppId],
  ["actionlint", actionsAppId],
  ["Verify pinned action SHAs", actionsAppId],
  ["zizmor", actionsAppId],
  ["Analyze (actions)", actionsAppId],
  ["Analyze (javascript-typescript)", actionsAppId],
  ["Build, scan, SBOM, smoke", actionsAppId],
  ["Review dependency diff (dev/main)", actionsAppId],
  ["ui", actionsAppId],
  ["Scan dependency lockfiles", actionsAppId],
  ["Mutation quality gate", actionsAppId],
  ["SonarCloud Code Analysis", 12526],
  ["Socket Security: Project Report", 156372],
  ["Socket Security: Pull Request Alerts", 156372],
  ["Gitar", 827041],
].map(([name, appId]) => ({ appId, name }));

function completedAt(check) {
  const value = Date.parse(check.completedAt ?? check.completed_at);
  return Number.isFinite(value) ? value : undefined;
}

function startedAt(check) {
  const value = Date.parse(check.startedAt ?? check.started_at);
  return Number.isFinite(value) ? value : undefined;
}

function checkTimestamp(check) {
  return Math.max(completedAt(check) ?? 0, startedAt(check) ?? 0);
}

function latestCheck(checks, headSha, name) {
  return checks
    .filter((check) => check.name === name && check.headSha === headSha)
    .toSorted(
      (left, right) =>
        checkTimestamp(right) - checkTimestamp(left) || (right.id ?? 0) - (left.id ?? 0),
    )[0];
}

function reviewProductSettled(checks, headSha, names, now, stabilityMs) {
  const currentChecks = names.map((name) => latestCheck(checks, headSha, name));
  if (
    currentChecks.some(
      (check) =>
        check === undefined || check.status !== "completed" || check.conclusion !== "success",
    )
  )
    return false;
  const completedTimes = currentChecks.map(completedAt);
  return completedTimes.every(Number.isFinite) && Math.max(...completedTimes) + stabilityMs <= now;
}

function blocking(message) {
  return { kind: "blocking", message };
}

function waiting(message) {
  return { kind: "waiting", message };
}

function safeConclusion(value) {
  return terminalConclusions.has(value) ? value : "invalid conclusion";
}

export function checkProblems(checks, headSha) {
  return requiredChecks.flatMap(({ appId, name }) => {
    const check = latestCheck(checks, headSha, name);
    if (check === undefined) return [waiting(`Missing current-head check: ${name}.`)];
    if (check.appId !== appId) return [blocking(`Wrong producer for ${name}.`)];
    if (runningCheckStatuses.has(check.status))
      return [waiting(`Check is still running: ${name}.`)];
    if (check.status !== "completed") return [blocking(`Invalid check state for ${name}.`)];
    if (check.conclusion !== "success")
      return [blocking(`Check failed: ${name} (${safeConclusion(check.conclusion)}).`)];
    return [];
  });
}

export function checkFailures(checks, headSha) {
  return checkProblems(checks, headSha).map(({ message }) => message);
}

export function isBotEvidence(value, identity, requireApp) {
  return (
    value.authorId === identity.userId &&
    value.authorType === "Bot" &&
    (!requireApp || value.appId === identity.appId)
  );
}

function latestComment(comments, identity) {
  return comments
    .filter((comment) => isBotEvidence(comment, identity, true))
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

export function parseGitarFindings(body) {
  const match = /\b(\d+)\s+resolved\s*\/\s*(\d+)\s+findings\b/iu.exec(body);
  if (match !== null) {
    const resolved = Number(match[1]);
    const total = Number(match[2]);
    return resolved <= total ? total - resolved : undefined;
  }
  const compactCleanReview =
    /<summary>\s*<b>Code Review<\/b>\s*<kbd>✅ Approved<\/kbd>\s*<\/summary>[\s\S]*?\bNo issues found\.\s*<\/details>/iu;
  return compactCleanReview.test(body) ? 0 : undefined;
}

export function packageAlerts(body) {
  if (!body.includes("[!WARNING]")) return [];
  const direct = [...body.matchAll(/npm\/(?:@[^/\s<]+\/)?[^@\s<]+@[^\s<`]+/gu)].map(
    ([value]) => value,
  );
  const links = [
    ...body.matchAll(/socket\.dev\/npm\/package\/([^/"<\s]+)\/overview\/([^?"<\s]+)/gu),
  ].map((match) => `npm/${decodeURIComponent(match[1])}@${decodeURIComponent(match[2])}`);
  const packages = [...direct, ...links];
  return [...new Set(packages)];
}

export function acceptedSocketRisks(comments, allowlist, actors, checkStart) {
  const commands = comments
    .filter(
      (comment) =>
        actors.has(comment.author) &&
        ["MEMBER", "OWNER"].includes(comment.authorAssociation) &&
        Date.parse(comment.updatedAt) >= checkStart,
    )
    .flatMap((comment) => [...comment.body.matchAll(/@SocketSecurity\s+ignore\s+(npm\/\S+)/gu)])
    .map((match) => match[1]);
  return new Set(commands.filter((entry) => allowlist.has(entry)));
}

export function currentCheckStart(checks, headSha, names) {
  return Math.max(
    ...checks
      .filter((check) => check.headSha === headSha && names.includes(check.name))
      .map(startedAt)
      .filter(Number.isFinite),
  );
}

export function commentIsCurrent(comment, checkStart) {
  if (comment === undefined) return false;
  const updatedAt = Date.parse(comment.updatedAt);
  return Number.isFinite(checkStart) && updatedAt >= checkStart;
}

export function hasCurrentSocketNoAlertEvidence(checks, headSha) {
  return checks.some(
    (check) =>
      check.appId === socketIdentity.appId &&
      check.conclusion === "success" &&
      check.headSha === headSha &&
      check.name === "Socket Security: Pull Request Alerts" &&
      check.socketNoAlerts === true &&
      check.status === "completed",
  );
}

function gitarProblems(checks, reviews, comments, headSha, now, stabilityMs) {
  const problems = [];
  if (
    reviews.some(
      (review) =>
        isBotEvidence(review, gitarIdentity, false) &&
        review.commitSha === headSha &&
        review.state === "CHANGES_REQUESTED",
    )
  ) {
    problems.push(blocking("Gitar has an active CHANGES_REQUESTED review for the current head."));
  }
  const gitar = latestComment(comments, gitarIdentity);
  const gitarStart = currentCheckStart(checks, headSha, ["Gitar"]);
  const findings = commentIsCurrent(gitar, gitarStart) ? parseGitarFindings(gitar.body) : undefined;
  if (findings === undefined) {
    const problem = reviewProductSettled(checks, headSha, ["Gitar"], now, stabilityMs)
      ? blocking
      : waiting;
    problems.push(problem("Current Gitar finding evidence is missing or unparseable."));
  } else if (findings !== 0)
    problems.push(blocking(`Gitar has ${String(findings)} unresolved finding(s).`));
  return problems;
}

function currentSocketProblems(socket, comments, socketRiskAllowlist, socketRiskActors, socketStart) {
  const alerts = packageAlerts(socket.body);
  const accepted = acceptedSocketRisks(
    comments,
    socketRiskAllowlist,
    socketRiskActors,
    socketStart,
  );
  const unresolved = alerts.filter((entry) => !accepted.has(entry));
  const problems = [];
  if (unresolved.length > 0)
    problems.push(blocking(`${String(unresolved.length)} Socket warning(s) remain.`));
  if (/\bError\b/u.test(socket.body)) problems.push(blocking("Socket reports an error alert."));
  return problems;
}

function socketProblems(
  checks,
  comments,
  headSha,
  socketRiskAllowlist,
  socketRiskActors,
  now,
  stabilityMs,
) {
  const socket = latestComment(comments, socketIdentity);
  const socketStart = currentCheckStart(checks, headSha, [
    "Socket Security: Project Report",
    "Socket Security: Pull Request Alerts",
  ]);
  if (commentIsCurrent(socket, socketStart))
    return currentSocketProblems(
      socket,
      comments,
      socketRiskAllowlist,
      socketRiskActors,
      socketStart,
    );
  if (hasCurrentSocketNoAlertEvidence(checks, headSha)) return [];
  const problem = reviewProductSettled(
    checks,
    headSha,
    ["Socket Security: Project Report", "Socket Security: Pull Request Alerts"],
    now,
    stabilityMs,
  )
    ? blocking
    : waiting;
  return [problem("Current Socket alert evidence is missing.")];
}

function reviewProblems(input) {
  return [
    ...gitarProblems(
      input.checks,
      input.reviews,
      input.comments,
      input.headSha,
      input.now,
      input.stabilityMs,
    ),
    ...socketProblems(
      input.checks,
      input.comments,
      input.headSha,
      input.socketRiskAllowlist,
      input.socketRiskActors,
      input.now,
      input.stabilityMs,
    ),
  ];
}

export function stabilityFailures(checks, comments, now, stabilityMs, headSha) {
  const socketStart = currentCheckStart(checks, headSha, [
    "Socket Security: Project Report",
    "Socket Security: Pull Request Alerts",
  ]);
  const socket = latestComment(comments, socketIdentity);
  const currentSocket = commentIsCurrent(socket, socketStart) ? socket : undefined;
  const cleanWithoutComment =
    currentSocket === undefined && hasCurrentSocketNoAlertEvidence(checks, headSha);
  const evidenceTimes = [
    ...checks
      .filter((check) => check.name === "Gitar" || check.name.startsWith("Socket Security:"))
      .map(completedAt),
    latestComment(comments, gitarIdentity)?.updatedAt,
    currentSocket?.updatedAt,
  ]
    .map((value) => (typeof value === "number" ? value : Date.parse(value)))
    .filter(Number.isFinite);
  if (evidenceTimes.length < (cleanWithoutComment ? 4 : 5))
    return ["Review-product stability evidence is incomplete."];
  return Math.max(...evidenceTimes) + stabilityMs > now
    ? ["Review-product evidence is inside the stability window."]
    : [];
}

export function validatedSet(value, pattern) {
  const entries = Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string" && pattern.test(entry))
    : undefined;
  return new Set(entries);
}

export function validatedRiskAllowlist(value) {
  return validatedSet(value, npmRiskPattern);
}

export function evaluateKeikoForQuality(input) {
  const riskAllowlist = validatedRiskAllowlist(input.socketRiskAllowlist);
  const riskActors = validatedSet(input.socketRiskActors, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u);
  const stabilityMs = input.stabilityMs ?? 60_000;
  const problems = [
    ...checkProblems(input.checks, input.headSha),
    ...reviewProblems({
      checks: input.checks,
      comments: input.comments,
      headSha: input.headSha,
      now: input.now,
      reviews: input.reviews,
      socketRiskActors: riskActors,
      socketRiskAllowlist: riskAllowlist,
      stabilityMs,
    }),
    ...stabilityFailures(input.checks, input.comments, input.now, stabilityMs, input.headSha).map(
      waiting,
    ),
  ];
  const blockingFailures = problems
    .filter(({ kind }) => kind === "blocking")
    .map(({ message }) => message);
  const waitingFailures = problems
    .filter(({ kind }) => kind === "waiting")
    .map(({ message }) => message);
  return {
    blockingFailures,
    failures: problems.map(({ message }) => message),
    passed: problems.length === 0,
    waitingFailures,
  };
}
