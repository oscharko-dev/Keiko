export function throwsFixture(): never {
  const left = 1;
  const total = left + 1;
  const message = "deterministic debug exception";
  if (total === 2) {
    // Intentionally empty and exactly one line — see the note below.
  }
  throw new Error(message);
}

throwsFixture();

// `throw` must stay on line 8: editor-debugging-2348.spec.ts pins the paused frame as
// `src/throws.ts:8`, so anything added above it moves the assertion. The `if` is kept because its
// condition is the only read of `total`. The block never carried behaviour — it held a
// `void message;` discard that typescript-eslint 8.69.0 rejects as meaningless. This note sits
// below the throw for the same reason: it must not shift the line it documents.
