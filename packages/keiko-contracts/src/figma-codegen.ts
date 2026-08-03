// Browser-safe design-to-code response shared by the BFF and UI. The split counts are part of the
// wire contract so a partial proposal can never be presented as if every stored screen was emitted.
export interface FigmaCodegenFile {
  readonly path: string;
  readonly contents: string;
}

export interface FigmaCodegenResponse {
  readonly runId: string;
  readonly adapterName: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly screenCount: number;
  readonly renderedScreenCount: number;
  readonly structuralScreenCount: number;
  readonly unparseableScreenCount: number;
  readonly files: readonly FigmaCodegenFile[];
}
