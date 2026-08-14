// One browser page may render many independent chat windows, but it still exposes one physical
// microphone. Every capture surface therefore leases this page-scoped owner before touching media
// APIs. Multiple leases from the same chat are allowed so its dialogue and dictation controllers can
// hand off safely; a different chat fails closed until the final lease is released.

let activeVoiceCaptureOwner: string | null = null;
const voiceCaptureLeases = new Map<symbol, string>();
const voiceCaptureOwnerListeners = new Set<() => void>();

function publishVoiceCaptureOwner(): void {
  for (const listener of voiceCaptureOwnerListeners) listener();
}

export function subscribeVoiceCaptureOwner(listener: () => void): () => void {
  voiceCaptureOwnerListeners.add(listener);
  return () => voiceCaptureOwnerListeners.delete(listener);
}

export function voiceCaptureOwnerSnapshot(): string | null {
  return activeVoiceCaptureOwner;
}

export function claimVoiceCapture(owner: string, lease: symbol): boolean {
  const leaseOwner = voiceCaptureLeases.get(lease);
  if (leaseOwner !== undefined) return leaseOwner === owner;
  if (activeVoiceCaptureOwner !== null && activeVoiceCaptureOwner !== owner) return false;
  const changed = activeVoiceCaptureOwner === null;
  activeVoiceCaptureOwner = owner;
  voiceCaptureLeases.set(lease, owner);
  if (changed) publishVoiceCaptureOwner();
  return true;
}

export function releaseVoiceCapture(lease: symbol): void {
  const owner = voiceCaptureLeases.get(lease);
  if (owner === undefined) return;
  voiceCaptureLeases.delete(lease);
  for (const leaseOwner of voiceCaptureLeases.values()) {
    if (leaseOwner === owner) return;
  }
  if (activeVoiceCaptureOwner === owner) activeVoiceCaptureOwner = null;
  publishVoiceCaptureOwner();
}

export function resetVoiceCaptureOwnerForTests(): void {
  activeVoiceCaptureOwner = null;
  voiceCaptureLeases.clear();
  publishVoiceCaptureOwner();
}
