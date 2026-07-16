function isLowercaseHex(character: string): boolean {
  const code = character.codePointAt(0);
  if (code === undefined) return false;
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102);
}

export function isSha256Digest(value: string): boolean {
  if (value.length !== 64) return false;
  for (const character of value) {
    if (!isLowercaseHex(character)) return false;
  }
  return true;
}

export function isDigestPinnedDebugCapsuleImage(value: string): boolean {
  const separator = value.indexOf("@sha256:");
  if (separator <= 0 || /\s/u.test(value)) return false;
  return isSha256Digest(value.slice(separator + "@sha256:".length));
}
