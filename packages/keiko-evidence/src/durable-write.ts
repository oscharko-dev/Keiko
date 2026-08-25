import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    offset += writeSync(fd, data, offset, data.length - offset);
  }
}

function encodeUtf8(value: string): Buffer {
  return Buffer.from(new TextEncoder().encode(value));
}

export function fsyncDirectoryContaining(
  path: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = openSync(dirname(path), "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

export function writeDurableTempFile(path: string, content: string | Buffer, mode = 0o600): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", mode);
    writeAll(fd, typeof content === "string" ? encodeUtf8(content) : content);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

export function writeDurableUtf8TempFile(path: string, content: string, mode = 0o600): void {
  writeDurableTempFile(path, content, mode);
}

/**
 * Thrown when the rename part of {@link replaceViaDurableTempFile} has ALREADY succeeded — so the
 * target file is durably on disk with the new content — but the follow-up
 * {@link fsyncDirectoryContaining} of the parent directory failed. Callers that classify their own
 * atomic-write outcomes MUST distinguish this from a pre-rename write failure: the temp path is
 * already gone (so an rmSync is a no-op that hides the real story), and the content-durability
 * question was answered "yes" before this class was thrown. Only the directory-metadata sync — the
 * belt-and-suspenders extra that turns a durable rename into a POSIX-strong durable rename — is
 * unconfirmed. (KEIKO-0388 / KEIKO-1034.)
 */
export class PostRenameFsyncError extends Error {
  public override readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "unknown");
    this.name = "PostRenameFsyncError";
    this.cause = cause;
  }
}

export function replaceViaDurableTempFile(
  target: string,
  temp: string,
  content: string | Buffer,
  mode = 0o600,
): void {
  // Pre-rename: any failure means the temp path is either partially written or the rename never
  // ran — clean the temp and re-throw the raw error so the caller sees the same "nothing was
  // written" signal it always saw.
  try {
    writeDurableTempFile(temp, content, mode);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  // Post-rename: the rename has succeeded, so the target now holds the new content and the temp
  // path is already gone. A failure of the containing-directory fsync is a DIFFERENT class of
  // event: content is durably on disk, only the directory metadata sync is unconfirmed. Re-throw
  // it as PostRenameFsyncError so callers can classify it apart from a pre-rename failure — and
  // do NOT rmSync the temp (it does not exist any more, and pretending it does hides the real
  // story from a reader of the caller's error path).
  try {
    fsyncDirectoryContaining(target);
  } catch (error) {
    throw new PostRenameFsyncError(error);
  }
}
