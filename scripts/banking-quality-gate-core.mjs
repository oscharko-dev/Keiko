const actionsAppId = 15368;
const gitarIdentity = { appId: 827041, userId: 159877585 };
const socketIdentity = { appId: 156372, userId: 95510084 };
const npmRiskPattern = /^npm\/(?:@[^/\s]+\/)?[^@\s]+@[^\s]+$/u;

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

export function checkFailures(checks, headSha) {
  return requiredChecks.flatMap(({ appId, name }) => {
    const candidates = checks.filter((check) => check.name === name && check.headSha === headSha);
    const check = candidates.toSorted(
      (left, right) => (completedAt(right) ?? 0) - (completedAt(left) ?? 0),
    )[0];
    if (check === undefined) return [`Missing current-head check: ${name}.`];
    if (check.appId !== appId) return [`Wrong producer for ${name}.`];
    if (check.status !== "completed" || check.conclusion !== "success")
      return [`Check is not successful: ${name}.`];
    return [];
  });
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
  if (match === null) return undefined;
  const resolved = Number(match[1]);
  const total = Number(match[2]);
  return resolved <= total ? total - resolved : undefined;
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

function reviewFailures(checks, reviews, comments, headSha, socketRiskAllowlist, socketRiskActors) {
  const failures = [];
  if (
    reviews.some(
      (review) =>
        isBotEvidence(review, gitarIdentity, false) &&
        review.commitSha === headSha &&
        review.state === "CHANGES_REQUESTED",
    )
  ) {
    failures.push("Gitar has an active CHANGES_REQUESTED review for the current head.");
  }
  const gitar = latestComment(comments, gitarIdentity);
  const gitarStart = currentCheckStart(checks, headSha, ["Gitar"]);
  const findings = commentIsCurrent(gitar, gitarStart) ? parseGitarFindings(gitar.body) : undefined;
  if (findings === undefined)
    failures.push("Current Gitar finding evidence is missing or unparseable.");
  else if (findings !== 0) failures.push(`Gitar has ${String(findings)} unresolved finding(s).`);

  const socket = latestComment(comments, socketIdentity);
  const socketStart = currentCheckStart(checks, headSha, [
    "Socket Security: Project Report",
    "Socket Security: Pull Request Alerts",
  ]);
  if (!commentIsCurrent(socket, socketStart))
    failures.push("Current Socket alert evidence is missing.");
  else {
    const alerts = packageAlerts(socket.body);
    const accepted = acceptedSocketRisks(
      comments,
      socketRiskAllowlist,
      socketRiskActors,
      socketStart,
    );
    const unresolved = alerts.filter((entry) => !accepted.has(entry));
    if (unresolved.length > 0)
      failures.push(`${String(unresolved.length)} Socket warning(s) remain.`);
    if (/\bError\b/u.test(socket.body)) failures.push("Socket reports an error alert.");
  }
  return failures;
}

export function stabilityFailures(checks, comments, now, stabilityMs) {
  const evidenceTimes = [
    ...checks
      .filter((check) => check.name === "Gitar" || check.name.startsWith("Socket Security:"))
      .map(completedAt),
    latestComment(comments, gitarIdentity)?.updatedAt,
    latestComment(comments, socketIdentity)?.updatedAt,
  ]
    .map((value) => (typeof value === "number" ? value : Date.parse(value)))
    .filter(Number.isFinite);
  if (evidenceTimes.length < 5) return ["Review-product stability evidence is incomplete."];
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

export function evaluateBankingQualityGate(input) {
  const riskAllowlist = validatedRiskAllowlist(input.socketRiskAllowlist);
  const riskActors = validatedSet(input.socketRiskActors, /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u);
  const failures = [
    ...checkFailures(input.checks, input.headSha),
    ...reviewFailures(
      input.checks,
      input.reviews,
      input.comments,
      input.headSha,
      riskAllowlist,
      riskActors,
    ),
    ...stabilityFailures(input.checks, input.comments, input.now, input.stabilityMs ?? 60_000),
  ];
  return { failures, passed: failures.length === 0 };
}
