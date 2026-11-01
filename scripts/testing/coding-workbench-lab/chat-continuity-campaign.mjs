// Campaign execution and evidence persistence; no model or product-runtime policy lives here.
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { continuityCorpusManifest } from "./chat-continuity-corpus.mjs";

export function continuityCaseId({ model, kind, repetition }, phase) {
  if (repetition !== "long" && (!Number.isSafeInteger(repetition) || repetition < 0))
    throw new TypeError("invalid-continuity-trial");
  return `${model}:${kind}:${repetition}:${phase}`;
}

export function installContinuityCancellation(target = process) {
  const controller = new globalThis.AbortController();
  let reason;
  const stop = (signal) => {
    if (controller.signal.aborted) return;
    reason = signal;
    controller.abort();
  };
  const interrupt = () => stop("SIGINT"),
    terminate = () => stop("SIGTERM");
  target.once("SIGINT", interrupt);
  target.once("SIGTERM", terminate);
  return {
    signal: controller.signal,
    get reason() {
      return reason;
    },
    dispose: () => {
      target.off("SIGINT", interrupt);
      target.off("SIGTERM", terminate);
    },
  };
}

export async function driveContinuityCampaigns(states, bounds, operation, now = Date.now) {
  const pending = (state) =>
    state.failures < 3 &&
    (state.cycles < bounds.requiredCycles || now() - state.startedAt < bounds.requiredDuration);
  while (states.some(pending)) {
    for (const state of states) if (pending(state)) await operation(state);
  }
}

export function continuityCampaignQualified(state, bounds, now = Date.now()) {
  return (
    state.failures === 0 &&
    state.cycles >= bounds.requiredCycles &&
    now - state.startedAt >= bounds.requiredDuration &&
    recallQualified(state, bounds.requireRestart !== false)
  );
}

export function continuityTrialResult(state, bounds, now = Date.now()) {
  const phase = state.repetition === "long" ? "campaign-result" : "repetition-result";
  return {
    id: continuityCaseId(state, phase),
    model: state.model,
    kind: state.kind,
    repetition: state.repetition,
    cycles: state.cycles,
    elapsedMs: now - state.startedAt,
    failures: state.failures,
    probes: structuredClone(state.probes ?? []),
    status: continuityCampaignQualified(state, bounds, now) ? "passed" : "incomplete",
  };
}

function recallQualified(state, requireRestart) {
  const probes = state.probes ?? [],
    expected = continuityCorpusManifest().criticalFields.length;
  const phases = new Set(probes.map((probe) => probe.phase));
  return (
    phases.has("control") &&
    (!requireRestart || phases.has("restart")) &&
    probes.filter((probe) => probe.phase === "cycle").length >= state.cycles &&
    probes.every(
      ({ score }) => score.validJson && score.total === expected && score.correct === expected,
    )
  );
}

export function writeContinuityJson(path, value, io = fs) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const descriptor = io.openSync(temporary, "wx", 0o600);
  try {
    try {
      io.writeFileSync(descriptor, JSON.stringify(value, null, 2));
      io.fsyncSync(descriptor);
    } finally {
      io.closeSync(descriptor);
    }
    io.renameSync(temporary, path);
  } finally {
    io.rmSync(temporary, { force: true });
  }
}
