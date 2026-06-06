import { type DimensionResult, type EvaluationFixture, type FixtureRunResult, type ScorecardEntry, type ScorecardSummary, type SurfaceParityResult } from "./types.js";
export interface ScoringInput {
    readonly status: string;
    readonly proposedDiff: string | undefined;
    readonly changedFileCount: number;
    readonly patchBytes: number;
    readonly verificationStatus: string | undefined;
    readonly verificationPresent: boolean;
    readonly manifestValid: boolean;
    readonly recordedWriteCount: number;
}
export declare function scoreFixture(fixture: EvaluationFixture, input: ScoringInput): readonly DimensionResult[];
export declare function aggregateScorecard(results: readonly FixtureRunResult[]): readonly ScorecardEntry[];
export declare function summarizeScorecard(results: readonly FixtureRunResult[], dimensions: readonly ScorecardEntry[], surfaceParity: SurfaceParityResult): ScorecardSummary;
//# sourceMappingURL=scorer.d.ts.map