// SDK-level runAgent wrapper. The harness createSession remains the deterministic core; this wrapper
// adds the #10 SDK contract that completed SDK runs persist a redacted EvidenceManifest by default.
import { persistEvidence } from "../audit/persist.js";
import { createSession, DEFAULT_LIMITS, HARNESS_VERSION, } from "../harness/index.js";
import { resolveCostClass } from "../gateway/index.js";
function resolveLimits(config) {
    return { ...DEFAULT_LIMITS, ...config.limits };
}
function resolveDryRun(config) {
    return config.dryRun ?? true;
}
function buildRunManifest(task, config, result) {
    return {
        runId: result.runId,
        fingerprint: result.fingerprint,
        harnessVersion: HARNESS_VERSION,
        taskType: task.taskType,
        taskInput: task,
        limits: resolveLimits(config),
        modelId: config.model,
        workingDirectory: config.workingDirectory,
        dryRun: resolveDryRun(config),
        startedAt: new Date(result.startedAt).toISOString(),
        events: result.events,
    };
}
function evidenceBuildInput(task, config, result, evidence) {
    return {
        result,
        manifest: buildRunManifest(task, config, result),
        ...(evidence?.redaction === undefined ? {} : { redaction: evidence.redaction }),
        ...(evidence?.options === undefined ? {} : { options: evidence.options }),
    };
}
function evidenceDeps(evidence) {
    return {
        ...(evidence?.store === undefined ? {} : { store: evidence.store }),
        ...(evidence?.env === undefined ? {} : { env: evidence.env }),
        // Wire the default cost-class resolver from the gateway capability registry (#163). The
        // evidence package stays leaf-clean against ADR-0019 rule 3d; the SDK is the runtime composer.
        costClassResolver: resolveCostClass,
    };
}
function persistRunEvidence(task, config, result) {
    const evidence = config.evidence;
    if (evidence?.write === false) {
        return;
    }
    persistEvidence(evidenceBuildInput(task, config, result, evidence), evidenceDeps(evidence), evidence?.retention);
}
export function runAgent(task, config, deps) {
    const session = createSession(task, config, deps);
    return {
        ...session,
        result: session.result.then((result) => {
            persistRunEvidence(task, config, result);
            return result;
        }),
    };
}
