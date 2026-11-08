// Fixture maintenance reuses the existing lane lock. No bound lane loses its PAT mid-turn.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  actorDetails,
  basicAuth,
  labRequest,
  loadSession,
  readPrivateFile,
} from "./lab-client.mjs";
import { privateJson, privateText } from "./private-json.mjs";
import { enterActive, withExclusiveRestart } from "./requirements/lab-lanes.mjs";

const TOKEN_NAME = "Keiko synthetic 4081 session";
// Native Jira refuses PAT names over 40 characters; the 11-hex nonce keeps a renewal name at 40.
const NONCE_LENGTH = 40 - TOKEN_NAME.length - 1;
const TOKEN_PATH = "/rest/pat/latest/tokens";
const digest = (value) => createHash("sha256").update(value).digest("hex");
class TokenRecoveryRefusal extends TypeError {
  constructor(reason) {
    super(`Laboratory PAT recovery refused: ${reason}`);
    this.reason = reason;
  }
}
const refusal = (reason) => new TokenRecoveryRefusal(reason);
function pathsFor(session, actor) {
  const root = join(session.directory, "secrets");
  const token = join(root, `${actor}-token`);
  return {
    token,
    next: `${token}.next`,
    active: `${token}.json`,
    pending: join(root, `${actor}-pat-renewal.pending.json`),
    initial: join(root, actor === "api" ? "pat-creation-started" : `${actor}-pat-creation-started`),
  };
}
function readOptional(path) {
  return existsSync(path) ? readPrivateFile(path) : undefined;
}
function parseOptional(path) {
  const text = readOptional(path);
  return text === undefined ? undefined : JSON.parse(text);
}
function ownedName(name) {
  return (
    name === TOKEN_NAME ||
    (typeof name === "string" &&
      new RegExp(`^${TOKEN_NAME}-[a-f0-9]{${NONCE_LENGTH}}$`, "u").test(name))
  );
}
function tokenExpiry(token) {
  const value = token?.expiringAt;
  const expiry =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(expiry) || expiry <= 0) throw refusal("expiry-unavailable");
  return expiry;
}
async function tokens(session, actor) {
  const result = await labRequest(session, "GET", TOKEN_PATH, basicAuth(session, actor));
  if (
    result.status !== 200 ||
    !Array.isArray(result.value) ||
    result.value.length > 100 ||
    result.value.some((row) => !Number.isSafeInteger(row?.id) || row.id < 1)
  )
    throw refusal("inventory-unavailable");
  return result.value;
}
async function verifyIdentity(session, actor, auth) {
  const result = await labRequest(session, "GET", "/rest/api/2/myself", auth);
  if (
    result.status !== 200 ||
    result.value?.name !== actorDetails(actor).name ||
    result.value.active !== true
  )
    throw refusal("identity-mismatch");
}
function selectedToken(inventory, current, metadata) {
  if (metadata !== undefined) {
    if (
      !ownedName(metadata.name) ||
      (current !== undefined && metadata.tokenDigest !== digest(current))
    )
      throw refusal("active-binding-mismatch");
    const selected = inventory.filter(
      (row) => row.id === metadata.id && row.name === metadata.name,
    );
    if (selected.length !== 1) throw refusal("active-token-not-observed");
    return selected[0];
  }
  const selected = inventory.filter((row) => row.name === TOKEN_NAME);
  if (selected.length !== (current === undefined ? 0 : 1)) throw refusal("orphan-pat-ambiguous");
  return selected[0];
}
async function currentState(context) {
  const current = readOptional(context.paths.token);
  const metadata = parseOptional(context.paths.active);
  const inventory = await tokens(context.session, context.actor);
  const prior = selectedToken(inventory, current, metadata);
  if (current !== undefined && tokenExpiry(prior) > Date.now())
    await verifyIdentity(context.session, context.actor, `Bearer ${current}`);
  return {
    current,
    inventory,
    prior,
    tokenDigest: current === undefined ? metadata?.tokenDigest : digest(current),
  };
}
function sufficient(state, minimumSeconds) {
  return (
    state.current !== undefined && tokenExpiry(state.prior) - Date.now() > minimumSeconds * 1000
  );
}
function validatePrior(intent) {
  if (intent.prior === null) {
    if (!intent.initial) throw refusal("intent-unbound");
    return;
  }
  const prior = intent.prior;
  if (
    intent.initial ||
    !intent.priorIds.includes(prior?.id) ||
    !ownedName(prior?.name) ||
    (prior.tokenDigest !== null && !/^[a-f0-9]{64}$/u.test(prior.tokenDigest))
  )
    throw refusal("intent-unbound");
}
function validateIntent(intent, actor) {
  if (
    intent?.schemaVersion !== 2 ||
    intent.actor !== actor ||
    !ownedName(intent.targetName) ||
    !new Set(["prepared", "creating", "retiring"]).has(intent.phase)
  )
    throw refusal("intent-unbound");
  if (
    !Array.isArray(intent.priorIds) ||
    intent.priorIds.length > 100 ||
    intent.priorIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    new Set(intent.priorIds).size !== intent.priorIds.length
  )
    throw refusal("intent-unbound");
  validatePrior(intent);
  return intent;
}
function sameIntent(left, right) {
  const identity = (value) =>
    JSON.stringify([
      value.schemaVersion,
      value.actor,
      value.targetName,
      value.priorIds,
      value.prior?.id,
      value.prior?.name,
      value.prior?.tokenDigest,
      value.initial,
    ]);
  return identity(left) === identity(right);
}
function clearIntent(context, intent, compensated = false) {
  rmSync(context.paths.pending, { force: true });
  rmSync(context.paths.next, { force: true });
  if (
    compensated &&
    intent.initial &&
    [intent.targetName, ...(intent.targetName === TOKEN_NAME ? ["1"] : [])].includes(
      readOptional(context.paths.initial),
    )
  )
    rmSync(context.paths.initial, { force: true });
}
function legacyIntent(context, pending, inventory) {
  if (pending?.schemaVersion !== 1 || !Array.isArray(pending.priorIds))
    throw refusal("intent-unbound");
  const prior = inventory.filter(
    (row) => pending.priorIds.includes(row.id) && row.name === TOKEN_NAME,
  );
  if (prior.length > 1) throw refusal("legacy-prior-ambiguous");
  const current = readOptional(context.paths.token);
  return {
    schemaVersion: 2,
    actor: context.actor,
    targetName: TOKEN_NAME,
    priorIds: pending.priorIds,
    prior:
      prior[0] === undefined
        ? null
        : {
            id: prior[0].id,
            name: prior[0].name,
            tokenDigest: current === undefined ? null : digest(current),
          },
    initial: prior.length === 0,
    phase: "creating",
  };
}
function readBundle(context) {
  const next = readOptional(context.paths.next);
  if (!next?.startsWith("{")) return { next };
  try {
    return { next, bundle: JSON.parse(next) };
  } catch {
    return { next };
  }
}
function recoveryIntent(context, bundle, inventory) {
  let pending;
  try {
    pending = parseOptional(context.paths.pending);
  } catch {
    if (bundle === undefined) throw refusal("intent-corrupt");
  }
  let intent = pending ?? bundle?.intent;
  if (intent === undefined) {
    if (existsSync(context.paths.pending)) throw refusal("intent-corrupt");
    return undefined;
  }
  if (intent.schemaVersion === 1) intent = legacyIntent(context, intent, inventory);
  validateIntent(intent, context.actor);
  if (bundle !== undefined) {
    validateIntent(bundle.intent, context.actor);
    if (!sameIntent(bundle.intent, intent)) throw refusal("candidate-intent-mismatch");
  }
  return intent;
}
function promotedCandidate(context, intent, native) {
  const current = readOptional(context.paths.token);
  if (current === undefined) return undefined;
  const metadata = parseOptional(context.paths.active);
  const bound = metadata?.id === native.id && metadata.tokenDigest === digest(current);
  const legacyPromoted = intent.targetName === TOKEN_NAME && intent.prior === null;
  return bound || legacyPromoted ? { ...native, rawToken: current } : undefined;
}
function availableCandidate(context, intent, native, bundle, next) {
  if (bundle?.candidate !== undefined) return bundle.candidate;
  if (native === undefined) return undefined;
  if (next !== undefined && !next.startsWith("{")) return { ...native, rawToken: next };
  return promotedCandidate(context, intent, native);
}
function recoveryRecord(context, inventory) {
  const { next, bundle } = readBundle(context);
  const intent = recoveryIntent(context, bundle, inventory);
  if (intent === undefined) {
    if (next !== undefined) throw refusal("candidate-metadata-missing");
    return undefined;
  }
  const candidates = inventory.filter(
    (row) => row.name === intent.targetName && !intent.priorIds.includes(row.id),
  );
  if (candidates.length > 1) throw refusal("orphan-pat-ambiguous");
  const native = candidates[0];
  return { intent, native, candidate: availableCandidate(context, intent, native, bundle, next) };
}
async function retireToken(context, selected) {
  if (selected === null || selected === undefined) return;
  const present = (await tokens(context.session, context.actor)).find(
    (row) => row.id === selected.id,
  );
  if (present === undefined) return;
  if (present.name !== selected.name || !ownedName(present.name))
    throw refusal("retirement-binding-mismatch");
  const result = await labRequest(
    context.session,
    "DELETE",
    `${TOKEN_PATH}/${selected.id}`,
    basicAuth(context.session, context.actor),
  );
  if (
    !new Set([200, 204, 404]).has(result.status) ||
    (await tokens(context.session, context.actor)).some((row) => row.id === selected.id)
  )
    throw refusal("retirement-unconfirmed");
}
async function proveCandidate(context, intent, candidate) {
  const inventory = await tokens(context.session, context.actor);
  const selected = inventory.filter(
    (row) =>
      row.id === candidate?.id &&
      row.name === intent.targetName &&
      !intent.priorIds.includes(row.id),
  );
  if (
    selected.length !== 1 ||
    candidate.name !== intent.targetName ||
    typeof candidate.rawToken !== "string" ||
    candidate.rawToken.length === 0
  )
    throw refusal("candidate-native-binding-mismatch");
  if (tokenExpiry(selected[0]) - Date.now() <= context.minimumSeconds * 1000)
    throw refusal("candidate-window-insufficient");
  const candidateDigest = digest(candidate.rawToken);
  if (candidateDigest === intent.prior?.tokenDigest) throw refusal("candidate-credential-reused");
  await verifyIdentity(context.session, context.actor, `Bearer ${candidate.rawToken}`);
  return { selected: selected[0], candidateDigest };
}
async function promoteCandidate(context, intent, candidate) {
  const { selected, candidateDigest } = await proveCandidate(context, intent, candidate);
  const current = readOptional(context.paths.token);
  if (
    current !== undefined &&
    ![intent.prior?.tokenDigest, candidateDigest].includes(digest(current))
  )
    throw refusal("credential-changed");
  privateText(context.paths.token, candidate.rawToken);
  privateJson(context.paths.active, {
    id: selected.id,
    name: selected.name,
    tokenDigest: candidateDigest,
  });
  privateJson(context.paths.pending, { ...intent, phase: "retiring" });
  await retireToken(context, intent.prior);
  await verifyIdentity(context.session, context.actor, `Bearer ${candidate.rawToken}`);
  clearIntent(context, intent);
  return `Bearer ${candidate.rawToken}`;
}
async function recoverPending(context) {
  const record = recoveryRecord(context, await tokens(context.session, context.actor));
  if (record === undefined) return undefined;
  const { intent, candidate, native } = record;
  if (candidate !== undefined) return promoteCandidate(context, intent, candidate);
  if (native !== undefined) {
    // The nonce and pre-dispatch inventory prove ownership; compensate only that orphan, then read absence.
    await retireToken(context, native);
    clearIntent(context, intent, true);
    return undefined;
  }
  if (intent.phase === "prepared" && !existsSync(context.paths.next)) {
    clearIntent(context, intent, true);
    return undefined;
  }
  const state = await currentState(context);
  if (intent.phase === "creating" && sufficient(state, context.minimumSeconds)) {
    console.log(
      JSON.stringify({
        operation: "jira-lab-pat-recovery",
        state: "current-preserved",
        pending: true,
      }),
    );
    return `Bearer ${state.current}`;
  }
  throw refusal("creation-not-observed");
}
function prepareIntent(context, state) {
  const intent = {
    schemaVersion: 2,
    actor: context.actor,
    phase: "prepared",
    targetName: `${TOKEN_NAME}-${randomUUID().replaceAll("-", "").slice(0, NONCE_LENGTH)}`,
    priorIds: state.inventory.map((row) => row.id),
    prior:
      state.prior === undefined
        ? null
        : { id: state.prior.id, name: state.prior.name, tokenDigest: state.tokenDigest ?? null },
    initial: state.prior === undefined,
  };
  if (intent.initial && existsSync(context.paths.initial))
    throw refusal("initial-creation-unreconciled");
  privateJson(context.paths.pending, intent, true);
  return intent;
}
async function createCandidate(context, state) {
  const intent = prepareIntent(context, state);
  if (readOptional(context.paths.token) !== state.current) {
    clearIntent(context, intent, true);
    throw refusal("credential-changed");
  }
  if (intent.initial) privateText(context.paths.initial, intent.targetName, true);
  const dispatchIntent = { ...intent, phase: "creating" };
  privateJson(context.paths.pending, dispatchIntent);
  const result = await labRequest(
    context.session,
    "POST",
    TOKEN_PATH,
    basicAuth(context.session, context.actor),
    { name: intent.targetName, expirationDuration: 1 },
  );
  const candidate = result.value;
  // Preserve the one-time secret and its complete intent BEFORE any response/identity/readback validation.
  if (typeof candidate?.rawToken === "string")
    privateJson(
      context.paths.next,
      {
        intent: dispatchIntent,
        candidate: { id: candidate.id, name: candidate.name, rawToken: candidate.rawToken },
      },
      true,
    );
  if (!new Set([200, 201]).has(result.status)) throw refusal("creation-unconfirmed");
  return promoteCandidate(context, dispatchIntent, candidate);
}
async function maintain(context) {
  const recovered = await recoverPending(context);
  if (recovered !== undefined) return recovered;
  const state = await currentState(context);
  if (sufficient(state, context.minimumSeconds)) return `Bearer ${state.current}`;
  return createCandidate(context, state);
}
function hasPending(context) {
  return existsSync(context.paths.pending) || existsSync(context.paths.next);
}
async function admittedCredential(context, laneOptions) {
  await enterActive(context.session.directory, laneOptions);
  // Another exclusive maintainer may have replaced the token while this lane waited for admission.
  const state = await currentState(context);
  if (!sufficient(state, context.minimumSeconds)) throw refusal("window-unconfirmed");
  return `Bearer ${state.current}`;
}
export async function ensureFixtureToken(session, actor, minimumSeconds = 3600, laneOptions) {
  actorDetails(actor);
  if (!Number.isSafeInteger(minimumSeconds) || minimumSeconds < 1 || minimumSeconds > 86_000)
    throw refusal("invalid-window");
  const context = { session, actor, minimumSeconds, paths: pathsFor(session, actor) };
  if (!hasPending(context)) {
    const state = await currentState(context);
    if (sufficient(state, minimumSeconds)) return admittedCredential(context, laneOptions);
  }
  await withExclusiveRestart(
    session.directory,
    async () => hasPending(context) || !sufficient(await currentState(context), minimumSeconds),
    () => maintain(context),
    laneOptions,
  );
  return admittedCredential(context, laneOptions);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await ensureFixtureToken(
      loadSession(process.argv[2]),
      process.argv[3],
      Number(process.argv[4] ?? 3600),
    );
    console.log(JSON.stringify({ operation: "jira-lab-pat-reconciled", valid: true }));
  } catch (error) {
    console.log(
      JSON.stringify({
        operation: "jira-lab-pat-reconciled",
        valid: false,
        reason: error instanceof TokenRecoveryRefusal ? error.reason : "storage-unavailable",
      }),
    );
    process.exitCode = 1;
  }
}
