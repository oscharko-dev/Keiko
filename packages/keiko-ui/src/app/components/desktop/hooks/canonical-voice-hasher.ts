interface CanonicalVoiceHasherRuntime {
  readonly sha256Hex: (value: string) => string;
}

type CanonicalVoiceHasherLoader = () => Promise<CanonicalVoiceHasherRuntime>;

interface CanonicalVoiceHasherLoad {
  readonly generation: number;
  readonly promise: Promise<void>;
}

const HASHER_UNAVAILABLE_ERROR = "Canonical voice hashing is unavailable.";

let generation = 0;
let runtime: CanonicalVoiceHasherRuntime | undefined;
let activeLoad: CanonicalVoiceHasherLoad | undefined;

function loadCanonicalVoiceHasherRuntime(): Promise<CanonicalVoiceHasherRuntime> {
  return import("./canonical-voice-hasher-runtime");
}

export function canonicalVoiceHasherIsReady(): boolean {
  return runtime !== undefined;
}

export function prepareCanonicalVoiceHasher(
  loader: CanonicalVoiceHasherLoader = loadCanonicalVoiceHasherRuntime,
): Promise<void> {
  if (runtime !== undefined) return Promise.resolve();
  if (activeLoad !== undefined) return activeLoad.promise;

  const loadGeneration = generation;
  const promise = Promise.resolve()
    .then(loader)
    .then((loadedRuntime) => {
      if (
        generation !== loadGeneration ||
        activeLoad?.generation !== loadGeneration ||
        typeof loadedRuntime.sha256Hex !== "function"
      ) {
        throw new Error(HASHER_UNAVAILABLE_ERROR);
      }
      runtime = loadedRuntime;
    })
    .catch(() => {
      throw new Error(HASHER_UNAVAILABLE_ERROR);
    })
    .finally(() => {
      if (activeLoad?.generation === loadGeneration) activeLoad = undefined;
    });
  activeLoad = { generation: loadGeneration, promise };
  return promise;
}

export function canonicalVoiceSha256Hex(value: string): string {
  if (runtime === undefined) throw new Error(HASHER_UNAVAILABLE_ERROR);
  return runtime.sha256Hex(value);
}

export function clearCanonicalVoiceHasherForTests(): void {
  generation += 1;
  runtime = undefined;
  activeLoad = undefined;
}
