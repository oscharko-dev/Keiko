// Fault ownership stays with this block; durable state stays with the existing limit-run intent.
import { URL } from "node:url";
import { observeFaultCheckpoint, gradeFaultCheckpoint } from "./browser-bulk-fault-oracle.mjs";

const SCOPES = new Set(["bulk-epics", "hierarchy", "progress"]);
const KINDS = new Set(["response-drop", "server-kill"]);
const SEND_PATHS = new Set(["/api/desktop/chat", "/api/desktop/chat/stream"]);
const queues = new WeakMap();
function requireFact(condition) {
  if (!condition) throw new TypeError("Invalid bulk fault contract");
}
function serialized(intent, action) {
  const pending = (queues.get(intent) ?? Promise.resolve()).then(action, action);
  queues.set(
    intent,
    pending.catch(() => undefined),
  );
  return pending;
}
function faultState(ctx) {
  const facts = ctx.intent.state.faults ?? {};
  requireFact(facts && typeof facts === "object" && !Array.isArray(facts));
  return facts;
}
async function record(ctx, key, value) {
  await ctx.intent.record("faults", { ...faultState(ctx), [key]: value });
}
function counts(ctx, plan, grade = {}) {
  const states = faultState(ctx);
  const entries = plan.map((item) => states[item.key]);
  return {
    injected: entries.filter((item) => item?.injected === true).length,
    recovered: entries.filter(recordedRecovery).length,
    duplicates: grade.duplicates ?? 0,
    lost: grade.lost ?? 0,
  };
}
function result(ctx, scope, plan, status, detail, grade) {
  return { step: `ac8-${scope}`, status, detail, counts: counts(ctx, plan, grade) };
}
function validateContext(ctx, progress01) {
  requireFact(Number.isFinite(progress01) && progress01 >= 0 && progress01 <= 1);
  requireFact(ctx && typeof ctx.intent?.record === "function" && ctx.intent.state);
  requireFact(typeof ctx.signal?.throwIfAborted === "function");
  requireFact(typeof ctx.projectKey === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(ctx.projectKey));
  ctx.signal.throwIfAborted();
}
function planFor({ scope, at, kinds }) {
  requireFact(SCOPES.has(scope));
  requireFact(
    Array.isArray(at) &&
      Array.isArray(kinds) &&
      at.length === kinds.length &&
      at.length > 0 &&
      at.length <= 2,
  );
  requireFact(new Set(kinds).size === kinds.length && kinds.every((kind) => KINDS.has(kind)));
  requireFact(at.every((value) => Number.isFinite(value) && value >= 0 && value < 1));
  return at
    .map((target, index) => ({ target, kind: kinds[index], key: `${scope}:${kinds[index]}` }))
    .sort((a, b) => a.target - b.target);
}
async function patch(ctx, key, patch) {
  await record(ctx, key, { ...faultState(ctx)[key], ...patch });
}
async function skip(ctx, item, progress01, reason) {
  await record(ctx, item.key, { phase: "skipped", progress01, reason });
}
async function observeAfter(ctx, scope, item) {
  const after = await observeFaultCheckpoint(ctx, scope);
  const entry = faultState(ctx)[item.key];
  const grade = gradeFaultCheckpoint(entry.checkpoint, after, {
    progress01: entry.progress01,
    checkpointProgress: entry.progress01,
  });
  await patch(ctx, item.key, {
    nativeVerified: true,
    duplicates: grade.duplicates,
    lost: grade.lost,
    lostKeys: grade.lostKeys,
    ...(grade.duplicates || grade.lost ? { reason: "native-oracle-refused" } : {}),
  });
}
async function forwardDrop(route, ctx, item) {
  let response;
  let settled = false;
  try {
    response = await route.fetch({ timeout: 0, maxRedirects: 0, maxRetries: 0 });
    settled = true;
    if (ctx.signal.aborted) {
      await route.fulfill({ response });
      return false;
    }
    await route.abort("connectionreset");
    await serialized(ctx.intent, () => patch(ctx, item.key, { injected: true }));
    return true;
  } catch {
    if (!settled) {
      try {
        await route.abort("failed");
      } catch {
        /* The request may already be closed; never forward it again. */
      }
    }
    throw new TypeError("Fault response unavailable");
  } finally {
    await response?.dispose();
  }
}
async function responseDrop(ctx, scope, item) {
  const pageUrl = new URL(ctx.page.url());
  requireFact(new Set(["http:", "https:"]).has(pageUrl.protocol));
  requireFact(new Set(["127.0.0.1", "localhost", "[::1]"]).has(pageUrl.hostname));
  requireFact(pageUrl.username === "" && pageUrl.password === "");
  const origin = pageUrl.origin;
  const matches = (url) => url.origin === origin && SEND_PATHS.has(url.pathname);
  let claimed = false;
  const cleanup = async () => {
    ctx.signal.removeEventListener("abort", onAbort);
    await ctx.page.unroute(matches, handler);
  };
  const onAbort = () => {
    void serialized(ctx.intent, async () => {
      try {
        await cleanup();
        await patch(ctx, item.key, { reason: "aborted" });
      } catch {
        /* Durable injecting marker remains. */
      }
    });
  };
  const handler = async (route) => {
    if (claimed || ctx.signal.aborted || route.request().method() !== "POST")
      return route.fallback();
    claimed = true;
    try {
      const dropped = await forwardDrop(route, ctx, item);
      await cleanup();
      if (dropped) await serialized(ctx.intent, () => observeAfter(ctx, scope, item));
    } catch {
      await failedRoute(ctx, item, cleanup);
    }
  };
  await ctx.page.route(matches, handler);
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  if (ctx.signal.aborted) onAbort();
}
async function failedRoute(ctx, item, cleanup) {
  try {
    await cleanup();
  } catch {
    /* No second route or effect is installed. */
  }
  try {
    await serialized(ctx.intent, () => patch(ctx, item.key, { reason: "response-unavailable" }));
  } catch {
    /* An incomplete write-ahead record never authorizes another injection. */
  }
}
async function restart(ctx, scope, item) {
  const recovery = await ctx.recovery.restartServer({ signal: ctx.signal });
  requireFact(
    recovery?.restarted === true &&
      Number.isFinite(recovery.downtimeMs) &&
      recovery.downtimeMs >= 0,
  );
  await patch(ctx, item.key, { injected: true, downtimeMs: recovery.downtimeMs });
  await observeAfter(ctx, scope, item);
}
async function inject(ctx, scope, item, progress01, checkpoint) {
  await record(ctx, item.key, {
    phase: "injecting",
    progress01,
    startedAtMs: Date.now(),
    checkpoint,
  });
  ctx.signal.throwIfAborted();
  try {
    if (item.kind === "response-drop") await responseDrop(ctx, scope, item);
    else await restart(ctx, scope, item);
  } catch {
    ctx.signal.throwIfAborted();
    await patch(ctx, item.key, { reason: "injection-unconfirmed" });
  }
}
function gradesFor(ctx, plan, after, progress01) {
  return plan.flatMap((item) => {
    const entry = faultState(ctx)[item.key];
    if (!entry?.checkpoint) return [];
    return [
      {
        item,
        entry,
        ...gradeFaultCheckpoint(entry.checkpoint, after, {
          progress01,
          checkpointProgress: entry.progress01,
        }),
      },
    ];
  });
}
async function recover(ctx, grades) {
  await grades.reduce(async (previous, grade) => {
    await previous;
    if (
      grade.entry.phase !== "injecting" ||
      !grade.entry.injected ||
      !grade.entry.nativeVerified ||
      grade.entry.reason ||
      !grade.continued ||
      grade.duplicates ||
      grade.lost
    )
      return;
    const recoveryMs = Date.now() - grade.entry.startedAtMs;
    if (!Number.isSafeInteger(recoveryMs) || recoveryMs < 0) return;
    await patch(ctx, grade.item.key, { phase: "recovered", recoveryMs });
  }, Promise.resolve());
}
function aggregate(grades) {
  return {
    duplicates: Math.max(0, ...grades.map((grade) => grade.duplicates ?? 0)),
    lost: new Set(grades.flatMap((grade) => grade.lostKeys ?? [])).size,
  };
}
function missingHandle(ctx, item) {
  if (item.kind === "server-kill")
    return typeof ctx.recovery?.restartServer === "function" ? undefined : "recovery-unavailable";
  return typeof ctx.page?.route === "function" && typeof ctx.page?.unroute === "function"
    ? undefined
    : "route-unavailable";
}
async function unavailable(ctx, due, progress01) {
  if (progress01 === 1) {
    await due.reduce(async (previous, item) => {
      await previous;
      await skip(ctx, item, progress01, "threshold-missed");
    }, Promise.resolve());
    return true;
  }
  const reason = missingHandle(ctx, due[0]);
  if (reason === undefined) return false;
  await skip(ctx, due[0], progress01, reason);
  return true;
}
function recordedRecovery(entry) {
  return (
    entry?.phase === "recovered" &&
    entry.injected === true &&
    entry.nativeVerified === true &&
    Number.isSafeInteger(entry.recoveryMs) &&
    entry.recoveryMs >= 0 &&
    entry.checkpoint?.schemaVersion === 1 &&
    !entry.reason
  );
}
function verifiedRecovery(entry, grade) {
  return recordedRecovery(entry) && grade?.retained === true && grade.continued === true;
}
function finishPulse(ctx, scope, plan, initial, grades) {
  const latest = faultState(ctx);
  const observed = aggregate([initial, ...grades, ...plan.map((item) => latest[item.key] ?? {})]);
  if (observed.duplicates || observed.lost)
    return result(ctx, scope, plan, "red", "native-oracle-refused", observed);
  const complete = plan.every((item) =>
    verifiedRecovery(
      latest[item.key],
      grades.find((grade) => grade.item.key === item.key),
    ),
  );
  return result(
    ctx,
    scope,
    plan,
    complete ? "green" : "unverified",
    complete ? "fault-plan-recovered" : "fault-plan-incomplete",
    observed,
  );
}
async function startDue(ctx, scope, plan, due, progress01, after) {
  const pending = plan.some((item) => faultState(ctx)[item.key]?.phase === "injecting");
  if (due.length && !pending) await inject(ctx, scope, due[0], progress01, after);
}
async function pulse(ctx, scope, plan, progress01) {
  const states = faultState(ctx);
  const due = plan.filter((item) => item.target <= progress01 && !Object.hasOwn(states, item.key));
  if (due.length && (await unavailable(ctx, due, progress01)))
    return result(ctx, scope, plan, "unverified", "fault-handle-unavailable");
  const present = plan.some((item) => Object.hasOwn(states, item.key));
  if (!present && due.length === 0)
    return result(ctx, scope, plan, "unverified", "fault-plan-pending");
  const after = await observeFaultCheckpoint(ctx, scope);
  const initial = gradeFaultCheckpoint(after, after, {
    progress01,
    checkpointProgress: progress01,
  });
  const grades = gradesFor(ctx, plan, after, progress01);
  const grade = aggregate([initial, ...grades]);
  if (grade.duplicates || grade.lost)
    return result(ctx, scope, plan, "red", "native-oracle-refused", grade);
  await recover(ctx, grades);
  await startDue(ctx, scope, plan, due, progress01, after);
  return finishPulse(ctx, scope, plan, initial, grades);
}
/** Amendment 3: this is the only public export; F never submits or resubmits a browser turn. */
export function createFaultPlan({ scope, at, kinds }) {
  const plan = planFor({ scope, at, kinds });
  return {
    maybeInject: async (ctx, progress01) => {
      validateContext(ctx, progress01);
      return serialized(ctx.intent, async () => {
        ctx.signal.throwIfAborted();
        try {
          return await pulse(ctx, scope, plan, progress01);
        } catch {
          ctx.signal.throwIfAborted();
          return result(ctx, scope, plan, "unverified", "fault-evidence-unavailable");
        }
      });
    },
  };
}
