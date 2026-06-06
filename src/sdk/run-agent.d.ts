import type { AuditRedactionConfig, BuildOptions, RetentionPolicy } from "../audit/types.js";
import type { EvidenceStore } from "../audit/store.js";
import { type AgentConfig, type AgentSession, type HarnessDeps, type TaskInput } from "../harness/index.js";
import { type EnvSource } from "../gateway/index.js";
export interface SdkEvidenceOptions {
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
export declare function runAgent(task: TaskInput, config: SdkAgentConfig, deps: HarnessDeps): AgentSession;
//# sourceMappingURL=run-agent.d.ts.map