/** Pure ZIP attribute classification; neither this helper nor its callers follow links. */
export interface ZipEntryAttributes { readonly fileName: string; readonly externalFileAttributes: number }
export function zipEntryKind(entry: ZipEntryAttributes): "directory" | "file" | "unsafe" {
  if (entry.fileName.endsWith("/")) return "directory";
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (type === 0 || type === 0o100000) return "file";
  return type === 0o040000 ? "directory" : "unsafe";
}
/** Strict submission mode also refuses link/device modes disguised by a trailing slash. */
export function regularZipEntry(entry: ZipEntryAttributes): boolean {
  const type = (entry.externalFileAttributes >>> 16) & 0o170000;
  if ((entry.externalFileAttributes & 0x400) !== 0) return false; // Windows reparse point.
  if ((entry.externalFileAttributes & 0x10) !== 0 && !entry.fileName.endsWith("/")) return false;
  if (type !== 0 && type !== 0o100000 && type !== 0o040000) return false;
  if (type === 0o100000 && entry.fileName.endsWith("/")) return false;
  return type !== 0o040000 || entry.fileName.endsWith("/");
}
