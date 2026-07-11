import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    offset += writeSync(fd, data, offset, data.length - offset);
  }
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
    writeAll(fd, typeof content === "string" ? Buffer.from(content, "utf8") : content);
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

export function replaceViaDurableTempFile(
  target: string,
  temp: string,
  content: string | Buffer,
  mode = 0o600,
): void {
  try {
    writeDurableTempFile(temp, content, mode);
    renameSync(temp, target);
    fsyncDirectoryContaining(target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
