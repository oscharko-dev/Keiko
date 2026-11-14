export interface PackedFile {
  readonly path: string;
  readonly size?: number;
  readonly mode?: number;
}

/**
 * The file list `npm pack --dry-run --json` reports for a package directory: the same list the
 * package-surface gate and the portable stager's packed root package are built from.
 */
export function packFiles(options?: { readonly packageDir?: string }): readonly PackedFile[];
