// Package-private constants. Underscore-prefixed so the index.ts barrel never re-exports them.

// Default body-length cap for captured candidates. Aligned with MEMORY_BODY_MAX_CHARS in the
// contracts package so a candidate that flows through capture into the storage validator does
// not get re-rejected for the same reason at a different boundary. Callers can override via
// CapturePolicyOptions.maxBodyChars.
export const MEMORY_BODY_MAX_CHARS_DEFAULT = 4096;
