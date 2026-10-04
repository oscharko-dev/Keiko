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

// Descriptors are transient and body-free. Crossing the accepted capacity irreversibly discards
// the enrichment; normal lexical/semantic evidence continues unchanged.
export class KnownFitScopeContext {
  private retained: EvidenceAtom[] = [];
  private readonly bytesByPath = new Map<string, number>();
  private chargedBytes = 0;
  private overflowed = false;

  public constructor(
    private readonly capacityBytes: number,
    private readonly scopeId: string,
    private readonly queryFingerprint: string,
    private readonly emittedAtMs: number,
  ) {}

  public observe = (file: EligibleTextFile): boolean => {
    if (this.overflowed) return false;
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
