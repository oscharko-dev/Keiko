// SDK-level runAgent wrapper. The harness createSession remains the deterministic core; this wrapper
// adds the #10 SDK contract that completed SDK runs persist a redacted EvidenceManifest by default.

import { persistEvidence } from "../audit/persist.js";
import type {
  AuditRedactionConfig,
  BuildOptions,
  EvidenceBuildInput,
  EvidenceDeps,
  RetentionPolicy,
} from "../audit/types.js";
import type { EvidenceStore } from "../audit/store.js";
import {
  createSession,
  DEFAULT_LIMITS,
  HARNESS_VERSION,
  type AgentConfig,
  type AgentSession,
  type HarnessDeps,
  type HarnessLimits,
  type RunManifest,
  type RunResult,
  type TaskInput,
} from "../harness/index.js";
import type { EnvSource } from "../gateway/index.js";

export interface SdkEvidenceOptions {
  // Defaults true. Set false for callers that need the legacy no-artifact session behavior.
  readonly write?: boolean | undefined;
  readonly store?: EvidenceStore | undefined;
  readonly env?: EnvSource | undefined;
  readonly retention?: RetentionPolicy | undefined;
  readonly redaction?: AuditRedactionConfig | undefined;
  readonly options?: BuildOptions | undefined;
}

export interface SdkAgentConfig extends AgentConfig {
  readonly evidence?: SdkEvidenceOptions | undefined;
}

function resolveLimits(config: AgentConfig): HarnessLimits {
  return { ...DEFAULT_LIMITS, ...config.limits };
}

function resolveDryRun(config: AgentConfig): boolean {
  return config.dryRun ?? true;
}

function buildRunManifest(task: TaskInput, config: AgentConfig, result: RunResult): RunManifest {
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

function evidenceBuildInput(
  task: TaskInput,
  config: SdkAgentConfig,
  result: RunResult,
  evidence: SdkEvidenceOptions | undefined,
): EvidenceBuildInput {
  return {
    result,
    manifest: buildRunManifest(task, config, result),
    ...(evidence?.redaction === undefined ? {} : { redaction: evidence.redaction }),
    ...(evidence?.options === undefined ? {} : { options: evidence.options }),
  };
}

function evidenceDeps(evidence: SdkEvidenceOptions | undefined): EvidenceDeps {
  return {
    ...(evidence?.store === undefined ? {} : { store: evidence.store }),
    ...(evidence?.env === undefined ? {} : { env: evidence.env }),
  };
}

function persistRunEvidence(task: TaskInput, config: SdkAgentConfig, result: RunResult): void {
  const evidence = config.evidence;
  if (evidence?.write === false) {
    return;
  }
  persistEvidence(
    evidenceBuildInput(task, config, result, evidence),
    evidenceDeps(evidence),
    evidence?.retention,
  );
}

export function runAgent(task: TaskInput, config: SdkAgentConfig, deps: HarnessDeps): AgentSession {
  const session = createSession(task, config, deps);
  return {
    ...session,
    result: session.result.then((result) => {
      persistRunEvidence(task, config, result);
      return result;
    }),
  };
}
