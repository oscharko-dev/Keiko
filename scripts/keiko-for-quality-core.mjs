const qodoIdentity = { appId: 484649, userId: 151058649 };

// A currency SHA must be a full 40-hex commit id. Validating at this trust boundary stops a short or
// empty caller-supplied merge-parent value from matching every comment body through includes().
export function isValidHeadSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

export function isBotEvidence(value, identity, requireApp) {
  return (
    value.authorId === identity.userId &&
    value.authorType === "Bot" &&
    (!requireApp || value.appId === identity.appId)
  );
}

// Qodo's summary counts line omits a category when it is not applicable (a real review may show
// Bugs + Rule violations + Skill insights with no Requirement gaps). Require the header and at least
// one recognized blocking category, then sum the present blocking categories (Skill insights are
// advisory and excluded). A header-only comment with no counts is unparseable and fails closed.
export function parseQodoFindings(body) {
  if (!/Code Review by Qodo/iu.test(body)) return undefined;
  const counts = [
    /Bugs\s*\((\d+)\)/iu,
    /Rule violations\s*\((\d+)\)/iu,
    /Requirement gaps\s*\((\d+)\)/iu,
  ].map((pattern) => {
    const match = pattern.exec(body);
    return match === null ? undefined : Number(match[1]);
  });
  if (counts.every((count) => count === undefined)) return undefined;
  return counts.reduce((total, count) => total + (count ?? 0), 0);
}

// Head binding is necessary but not sufficient currency: Qodo can rewrite these embedded SHAs
// without regenerating its analysis, so the canonical Action separately enforces the app-bound
// normalized-digest chain from Issue #2870. For a merge-commit head (e.g. "Merge dev into <branch>")
// Qodo pins its review to the feature parent, so that binding also requires a post-merge update.
function qodoReviewBindsHead(comment, headSha, validParents, mergeCommitTime) {
  if (comment.body.includes(headSha)) return true;
  if (typeof mergeCommitTime !== "number") return false;
  const bindsParent = validParents.some((sha) => comment.body.includes(sha));
  return bindsParent && Date.parse(comment.updatedAt) >= mergeCommitTime;
}

// Select the newest current Qodo summary. Requiring a parseable summary prevents a newer non-summary
// Qodo comment from shadowing the real one. Merge parents are validated (full 40-hex) before use so a
// malformed entry can't broaden currency matching.
export function latestQodoReview(
  comments,
  headSha,
  mergeParents = [],
  mergeCommitTime = undefined,
) {
  const validParents = mergeParents.filter((sha) => isValidHeadSha(sha));
  return comments
    .filter((comment) => isBotEvidence(comment, qodoIdentity, true))
    .filter((comment) => parseQodoFindings(comment.body) !== undefined)
    .filter((comment) => qodoReviewBindsHead(comment, headSha, validParents, mergeCommitTime))
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

// The aggregate's only irreplaceable job is bridging the comment-only Qodo review into a gateable
// check bound to the exact current head (Issue #2508, ADR-0143). The direct required checks —
// including both Socket contexts and SonarQube Cloud — are branch-protection authority on the exact
// head already, so they are not re-checked here.
function reviewFailures(comments, headSha, mergeParents, mergeCommitTime) {
  const qodo = latestQodoReview(comments, headSha, mergeParents, mergeCommitTime);
  const findings = qodo === undefined ? undefined : parseQodoFindings(qodo.body);
  if (findings === undefined) return ["Current Qodo finding evidence is missing or unparseable."];
  return findings === 0 ? [] : [`Qodo has ${String(findings)} unresolved finding(s).`];
}

// The stability window guards against review evidence that is still being updated in place: the
// newest current Qodo summary must have settled for stabilityMs before the aggregate may turn
// green. Missing evidence keeps the window incomplete — fail closed, mirroring the review failure.
export function stabilityFailures(
  comments,
  now,
  stabilityMs,
  headSha,
  mergeParents = [],
  mergeCommitTime = undefined,
) {
  const qodo = latestQodoReview(comments, headSha, mergeParents, mergeCommitTime);
  const updatedAt = Date.parse(qodo?.updatedAt ?? "");
  if (!Number.isFinite(updatedAt)) return ["Review-product stability evidence is incomplete."];
  return updatedAt + stabilityMs > now
    ? ["Review-product evidence is inside the stability window."]
    : [];
}

export function evaluateKeikoForQuality(input) {
  const mergeParents = Array.isArray(input.mergeParents) ? input.mergeParents : [];
  const mergeCommitTime =
    typeof input.mergeCommitTime === "number" ? input.mergeCommitTime : undefined;
  const failures = [
    ...reviewFailures(input.comments, input.headSha, mergeParents, mergeCommitTime),
    ...stabilityFailures(
      input.comments,
      input.now,
      input.stabilityMs ?? 60_000,
      input.headSha,
      mergeParents,
      mergeCommitTime,
    ),
  ];
  return { failures, passed: failures.length === 0 };
}
