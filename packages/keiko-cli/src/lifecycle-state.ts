import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Runtime state Keiko writes for a background UI process: the pid file (legacy
// plain-PID payload, kept for backward compatibility) and a sibling metadata
// file used to confirm process identity before `keiko stop` signals a pid.

export interface LaunchMetadata {
  readonly pid: number;
  readonly binPath: string;
  readonly startedAt: string;
}

export function pidFilePath(stateDir: string): string {
  return join(stateDir, "ui.pid");
}

export function metaFilePath(stateDir: string): string {
  return join(stateDir, "ui.meta.json");
}

export function readPidFile(stateDir: string): number | undefined {
  const path = pidFilePath(stateDir);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  return Number(raw);
}

export function writePidFile(stateDir: string, pid: number): void {
  writeFileSync(pidFilePath(stateDir), `${String(pid)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function writeLaunchMetadata(stateDir: string, pid: number, binPath: string): void {
  const metadata: LaunchMetadata = { pid, binPath, startedAt: new Date().toISOString() };
  writeFileSync(metaFilePath(stateDir), `${JSON.stringify(metadata)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function readLaunchMetadata(stateDir: string): LaunchMetadata | undefined {
  const path = metaFilePath(stateDir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { readonly pid?: unknown };
    return typeof parsed.pid === "number" ? (parsed as LaunchMetadata) : undefined;
  } catch {
    return undefined;
  }
}

export function clearRuntimeState(stateDir: string): void {
  rmSync(pidFilePath(stateDir), { force: true });
  rmSync(metaFilePath(stateDir), { force: true });
}

// Refuse to signal a live pid that recorded metadata proves is no longer the
// Keiko process we launched (Windows pid reuse). Missing or malformed metadata
// returns false so existing legacy flows are never blocked.
export function isForeignLivePid(stateDir: string, pid: number): boolean {
  const metadata = readLaunchMetadata(stateDir);
  return metadata !== undefined && metadata.pid !== pid;
}
