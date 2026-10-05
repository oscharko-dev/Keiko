import {
  CONNECTED_CONTEXT_SCHEMA_VERSION,
  type EvidenceAtom,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { evidenceAtomStableId } from "@oscharko-dev/keiko-workspace";

interface EligibleTextFile {
  readonly scopePath: string;
  readonly contentBytes: number;
  readonly lineCount: number;
}

export interface ScopeContextObservation {
  readonly state: "applied" | "empty" | "overflow" | "incomplete-traversal" | "gate-refused";
  readonly observedFileCount: number;
  readonly retainedFileCount: number;
  readonly chargedBytes: number;
  readonly capacityBytes: number;
}

// Descriptors are transient and body-free. Crossing the accepted capacity irreversibly discards
// the enrichment; normal lexical/semantic evidence continues unchanged.
export class KnownFitScopeContext {
  private retained: EvidenceAtom[] = [];
  private readonly bytesByPath = new Map<string, number>();
  private chargedBytes = 0;
  private overflowed = false;
  private observedFileCount = 0;

  public constructor(
    private readonly capacityBytes: number,
    private readonly scopeId: string,
    private readonly queryFingerprint: string,
    private readonly emittedAtMs: number,
  ) {}

  public observe = (file: EligibleTextFile): boolean => {
    if (this.overflowed) return false;
    this.observedFileCount += 1;
    const atom = this.atom(file);
    this.chargedBytes += file.contentBytes + new TextEncoder().encode(JSON.stringify(atom)).length;
    if (this.chargedBytes > this.capacityBytes) {
      this.retained = [];
      this.bytesByPath.clear();
      this.overflowed = true;
      return false;
    }
    this.retained.push(atom);
    this.bytesByPath.set(file.scopePath, Math.max(1, file.contentBytes));
    return true;
  };

  public observation(): ScopeContextObservation {
    const retainedState = this.retained.length === 0 ? "empty" : "applied";
    return {
      state: this.overflowed ? "overflow" : retainedState,
      observedFileCount: this.observedFileCount,
      retainedFileCount: this.retained.length,
      chargedBytes: this.chargedBytes,
      capacityBytes: this.capacityBytes,
    };
  }

  public fileBytes(): ReadonlyMap<string, number> {
    return this.bytesByPath;
  }

  public atoms(): readonly EvidenceAtom[] {
    return this.retained;
  }

  private atom(file: EligibleTextFile): EvidenceAtom {
    const { scopeId, queryFingerprint, emittedAtMs } = this;
    const lineRange = { startLine: 1, endLine: file.lineCount };
    return {
      schemaVersion: CONNECTED_CONTEXT_SCHEMA_VERSION,
      stableId: evidenceAtomStableId({
        scopeId,
        scopePath: file.scopePath,
        lineRange,
        provenanceKind: "file-listing",
        provenanceTool: "repo.findFiles",
        queryFingerprint,
      }),
      scopePath: file.scopePath,
      lineRange,
      score: 1,
      provenance: { kind: "file-listing", tool: "repo.findFiles", queryFingerprint },
      redactionState: "redacted",
      emittedAtMs,
      ledgerRef: undefined,
    };
  }
}
