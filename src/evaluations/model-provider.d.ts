import { type EnvSource } from "../gateway/config.js";
import type { ModelPort } from "../harness/ports.js";
import type { NormalizedResponse } from "../gateway/types.js";
import type { EvaluationMode } from "./types.js";
export interface EvaluationModelProviderDeps {
    readonly mode: EvaluationMode;
    readonly env?: EnvSource | undefined;
    readonly transcript: readonly (NormalizedResponse | Error)[];
    readonly modelId: string;
    readonly configPath?: string | undefined;
}
export declare function createEvaluationModelProvider(deps: EvaluationModelProviderDeps): ModelPort;
//# sourceMappingURL=model-provider.d.ts.map