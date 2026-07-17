const actionsAppId = 15368;
const qodoIdentity = { appId: 484649, userId: 151058649 };
const socketIdentity = { appId: 156372, userId: 95510084 };
const npmRiskPattern = /^npm\/(?:@[^/\s]+\/)?[^@\s]+@[^\s]+$/u;

function checks(entries) {
  return entries.map(([name, appId]) => ({ appId, name }));
}

export const requiredChecks = checks([
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
  ["SonarCloud Code Analysis", 12526],
  ["Socket Security: Project Report", 156372],
  ["Socket Security: Pull Request Alerts", 156372],
]);

export const nativeRequiredChecks = checks([
  ["ci", actionsAppId],
  ["actionlint", actionsAppId],
  ["Verify pinned action SHAs", actionsAppId],
  ["zizmor", actionsAppId],
  ["Analyze (actions)", actionsAppId],
  ["Analyze (javascript-typescript)", actionsAppId],
  ["Build, scan, SBOM, smoke", actionsAppId],
  ["Review dependency diff (dev/main)", actionsAppId],
  ["native", actionsAppId],
  ["Scan dependency lockfiles", actionsAppId],
  ["SonarCloud Code Analysis", 12526],
  ["Socket Security: Project Report", 156372],
  ["Socket Security: Pull Request Alerts", 156372],
]);

export function requiredChecksForProfile(profile) {
  if (profile === "keiko") return requiredChecks;
  if (profile === "keiko-native") return nativeRequiredChecks;
  throw new Error("Unsupported quality-gate profile.");
}

function completedAt(check) {
  const value = Date.parse(check.completedAt ?? check.completed_at);
  return Number.isFinite(value) ? value : undefined;
}

function startedAt(check) {
  const value = Date.parse(check.startedAt ?? check.started_at);
  return Number.isFinite(value) ? value : undefined;
}

export function checkFailures(checkRuns, headSha, expectedChecks = requiredChecks) {
  return expectedChecks.flatMap(({ appId, name }) => {
    const candidates = checkRuns.filter(
      (check) => check.name === name && check.headSha === headSha,
    );
    const check = candidates.toSorted(
      (left, right) => (completedAt(right) ?? 0) - (completedAt(left) ?? 0),
    )[0];
    if (check === undefined) return [`Missing current-head check: ${name}.`];
    if (check.appId !== appId) return [`Wrong producer for ${name}.`];
    if (check.status !== "completed") return [`Check is pending: ${name}.`];
    if (check.conclusion !== "success") return [`Check is not successful: ${name}.`];
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

export function parseQodoFindings(body) {
  if (!/Code Review by Qodo/iu.test(body)) return undefined;
  const bugs = /Bugs\s*\((\d+)\)/iu.exec(body);
  const rules = /Rule violations\s*\((\d+)\)/iu.exec(body);
  const gaps = /Requirement gaps\s*\((\d+)\)/iu.exec(body);
  if (bugs === null || rules === null || gaps === null) return undefined;
  return Number(bugs[1]) + Number(rules[1]) + Number(gaps[1]);
}

export function latestQodoReview(comments, headSha) {
  return comments
    .filter((comment) => isBotEvidence(comment, qodoIdentity, true))
    .filter(
      (comment) => /Code Review by Qodo/iu.test(comment.body) && comment.body.includes(headSha),
    )
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
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

function reviewFailures(checks, comments, headSha, socketRiskAllowlist, socketRiskActors) {
  const failures = [];
  const qodo = latestQodoReview(comments, headSha);
  const findings = qodo === undefined ? undefined : parseQodoFindings(qodo.body);
  if (findings === undefined)
    failures.push("Current Qodo finding evidence is missing or unparseable.");
  else if (findings !== 0) failures.push(`Qodo has ${String(findings)} unresolved finding(s).`);

  const socket = latestComment(comments, socketIdentity);
  const socketStart = currentCheckStart(checks, headSha, [
    "Socket Security: Project Report",
    "Socket Security: Pull Request Alerts",
  ]);
  if (commentIsCurrent(socket, socketStart)) {
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
  } else if (!hasCurrentSocketNoAlertEvidence(checks, headSha))
    failures.push("Current Socket alert evidence is missing.");
  return failures;
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
    ...checks.filter((check) => check.name.startsWith("Socket Security:")).map(completedAt),
    latestQodoReview(comments, headSha)?.updatedAt,
    currentSocket?.updatedAt,
  ]
    .map((value) => (typeof value === "number" ? value : Date.parse(value)))
    .filter(Number.isFinite);
  if (evidenceTimes.length < (cleanWithoutComment ? 3 : 4))
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
  const failures = [
    ...checkFailures(input.checks, input.headSha, input.requiredChecks),
    ...reviewFailures(input.checks, input.comments, input.headSha, riskAllowlist, riskActors),
    ...stabilityFailures(
      input.checks,
      input.comments,
      input.now,
      input.stabilityMs ?? 60_000,
      input.headSha,
    ),
  ];
  return { failures, passed: failures.length === 0 };
}
