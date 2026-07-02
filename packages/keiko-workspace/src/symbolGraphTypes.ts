import type { WorkspaceLanguage } from "./types.js";

export type SymbolGraphRecordKind = "definition" | "reference" | "call";
export type SymbolDefinitionKind =
  "function" | "class" | "interface" | "type" | "enum" | "variable";

export interface SymbolGraphRecord {
  readonly stableId: string;
  readonly symbol: string;
  readonly scopePath: string;
  readonly kind: SymbolGraphRecordKind;
  readonly line: number;
  readonly ordinal: number;
  readonly confidence: number;
  readonly definitionKind?: SymbolDefinitionKind | undefined;
  readonly enclosingSymbol?: string | undefined;
}

export interface SymbolGraphDiagnostics {
  readonly filesScanned: number;
  readonly truncated: boolean;
  readonly unsupportedLanguages: readonly WorkspaceLanguage[];
}

export interface SymbolGraph {
  readonly records: readonly SymbolGraphRecord[];
  readonly definitions: ReadonlyMap<string, readonly SymbolGraphRecord[]>;
  readonly references: ReadonlyMap<string, readonly SymbolGraphRecord[]>;
  readonly calls: ReadonlyMap<string, readonly SymbolGraphRecord[]>;
  readonly diagnostics: SymbolGraphDiagnostics;
}
