// One browser page may render many independent chat windows, but it still exposes one physical
// microphone. Every capture surface therefore leases this page-scoped owner before touching media
// APIs. Capture modes are exclusive even inside one chat: a dialogue lease and a dictation lease may
// never overlap. Reclaiming the same lease is idempotent; every other lease fails closed.

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

export function voiceCaptureLeaseAvailable(owner: string, lease: symbol): boolean {
  const leaseOwner = voiceCaptureLeases.get(lease);
  return leaseOwner === owner || activeVoiceCaptureOwner === null;
}

export function claimVoiceCapture(owner: string, lease: symbol): boolean {
  const leaseOwner = voiceCaptureLeases.get(lease);
  if (leaseOwner !== undefined) return leaseOwner === owner;
  if (activeVoiceCaptureOwner !== null) return false;
  activeVoiceCaptureOwner = owner;
  voiceCaptureLeases.set(lease, owner);
  publishVoiceCaptureOwner();
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
