import type { SpawnFn, WorkspaceWriter } from "../tools/index.js";
import type { UnitTestWorkflowInput } from "@oscharko-dev/keiko-workflows";
import type { BugInvestigationInput } from "@oscharko-dev/keiko-workflows";
import type { ScoringInput } from "./scorer.js";
import type { EvaluationFixture } from "./types.js";
export interface MaterializedWorkspace {
    readonly root: string;
    readonly cleanup: () => void;
}
export declare function materializeFixture(fixture: EvaluationFixture): MaterializedWorkspace;
export interface RecordingWriter extends WorkspaceWriter {
    readonly writeCount: () => number;
}
export declare function recordingWriter(): RecordingWriter;
export interface RecordingSink {
    readonly emit: (event: {
        readonly type: string;
    }) => void;
    readonly events: () => readonly {
        readonly type: string;
    }[];
}
export declare function recordingSink(): RecordingSink;
export declare function fakeSpawn(exitCode: number, stdout?: string): SpawnFn;
export declare function buildUnitTestInput(fixture: EvaluationFixture, workspaceRoot: string, modelId: string): UnitTestWorkflowInput;
export declare function buildBugInput(fixture: EvaluationFixture, workspaceRoot: string, modelId: string): BugInvestigationInput;
export declare function toScoringInput(report: Record<string, unknown>, writeCount: number, manifestValid: boolean): ScoringInput;
//# sourceMappingURL=runner-support.d.ts.map