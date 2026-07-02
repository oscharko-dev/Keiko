"use client";

export function sameOriginApiEventSourceUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || /[\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  if (typeof window === "undefined" || window.location.origin === "null") return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed, window.location.origin);
  } catch {
    return null;
  }

  if (parsed.origin !== window.location.origin) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (!parsed.pathname.startsWith("/api/")) return null;
  if (parsed.hash.length > 0) return null;
  return `${parsed.pathname}${parsed.search}`;
}

export function createSameOriginApiEventSource(input: string): EventSource | null {
  if (typeof EventSource === "undefined") return null;
  const url = sameOriginApiEventSourceUrl(input);
  return url === null ? null : new EventSource(url);
}
