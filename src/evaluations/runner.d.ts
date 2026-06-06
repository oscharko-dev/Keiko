import { type EvidenceStore } from "../audit/index.js";
import type { ModelPort } from "../harness/ports.js";
import type { EnvSource } from "../gateway/config.js";
import { ALL_FIXTURES } from "./fixtures/index.js";
import { type EvalScorecard, type EvaluationFixture, type EvaluationMode } from "./types.js";
export interface EvalRunnerDeps {
    readonly modelProviderFactory?: ((fixture: EvaluationFixture, mode: EvaluationMode, modelId: string) => ModelPort) | undefined;
    readonly store?: EvidenceStore | undefined;
    readonly env?: EnvSource | undefined;
    readonly now?: (() => number) | undefined;
    readonly idSource?: (() => string) | undefined;
}
export interface EvalRunOptions {
    readonly mode: EvaluationMode;
    readonly fixtures: readonly EvaluationFixture[];
    readonly modelIdOverride?: string | undefined;
    readonly configPath?: string | undefined;
}
export declare function runEvaluationSuite(options: EvalRunOptions, deps?: EvalRunnerDeps): Promise<EvalScorecard>;
export { ALL_FIXTURES };
//# sourceMappingURL=runner.d.ts.map