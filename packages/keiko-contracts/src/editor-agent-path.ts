export const EDITOR_AGENT_TARGET_PATH_MAX_BYTES = 4_096;

const TEXT_ENCODER = new TextEncoder();

/** True for a bounded, workspace-relative path that cannot traverse above its root. */
export function isContainedAgentPath(candidate: string): boolean {
  if (candidate.length === 0) return false;
  if (TEXT_ENCODER.encode(candidate).length > EDITOR_AGENT_TARGET_PATH_MAX_BYTES) return false;
  if (candidate.startsWith("/") || /^[A-Za-z]:/u.test(candidate)) return false;
  if (candidate.includes("\u0000")) return false;
  return !candidate.split(/[/\\]/u).includes("..");
}
