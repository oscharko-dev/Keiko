import type { ModelPort } from "../harness/ports.js";
import type { NormalizedResponse } from "../gateway/types.js";
export interface ScriptedModelPort extends ModelPort {
    readonly callCount: () => number;
}
export declare function createScriptedModelPort(script: readonly (NormalizedResponse | Error)[]): ScriptedModelPort;
//# sourceMappingURL=scripted-model.d.ts.map