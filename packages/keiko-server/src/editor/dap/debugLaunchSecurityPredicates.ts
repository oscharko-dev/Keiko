function isAsciiAlphaNumeric(character: string): boolean {
  const code = character.codePointAt(0);
  return (
    code !== undefined &&
    ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122))
  );
}

function everyCharacter(value: string, predicate: (character: string) => boolean): boolean {
  for (const character of value) {
    if (!predicate(character)) return false;
  }
  return true;
}

function isLowercaseHex(character: string): boolean {
  const code = character.codePointAt(0);
  return code !== undefined && ((code >= 48 && code <= 57) || (code >= 97 && code <= 102));
}

export function isSha256Digest(value: string): boolean {
  return value.length === 64 && everyCharacter(value, isLowercaseHex);
}

function isSafeScriptCharacter(character: string): boolean {
  return isAsciiAlphaNumeric(character) || ". _:-".replace(" ", "").includes(character);
}

export function isSafeDebugScriptName(value: string): boolean {
  const normalized = value.normalize();
  const first = normalized.at(0);
  return (
    first !== undefined &&
    isAsciiAlphaNumeric(first) &&
    everyCharacter(normalized, isSafeScriptCharacter)
  );
}

function isSafeSocketStemCharacter(character: string): boolean {
  return (
    isAsciiAlphaNumeric(character) || character === "." || character === "_" || character === "-"
  );
}

export function isSafeDapSocketBasename(value: string): boolean {
  if (!value.endsWith(".sock")) return false;
  const stem = value.slice(0, -".sock".length);
  return stem.length > 0 && everyCharacter(stem, isSafeSocketStemCharacter);
}

export function isSupportedNodeDebugExtension(value: string): boolean {
  switch (value.toLowerCase()) {
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".ts":
    case ".mts":
    case ".cts":
      return true;
    default:
      return false;
  }
}
