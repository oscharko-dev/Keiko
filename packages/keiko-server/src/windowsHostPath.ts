/**
 * The Windows path forms Keiko never touches on the host (#4068 W7). A device or UNC path reaches a
 * pipe server or an SMB host on its first lstat, which already discloses the user's identity; a DOS
 * device name opens a device in any directory; an alternate data stream holds content no file view
 * shows. Callers refuse these before any filesystem call.
 */

// The DOS device names Windows resolves in any directory, also with an extension or trailing dots.
const WINDOWS_DEVICE_NAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/iu;

// Windows ignores trailing dots and spaces when it resolves a name, so `CON. ` is still `CON`.
// A linear scan, not a regular expression, so a long run of dots cannot backtrack.
function withoutTrailingDotsAndSpaces(component: string): string {
  let end = component.length;
  while (end > 0 && (component[end - 1] === "." || component[end - 1] === " ")) end -= 1;
  return component.slice(0, end);
}

/** Whether one path component names neither a DOS device nor an alternate data stream. */
export function isWindowsOrdinaryPathComponent(component: string): boolean {
  return (
    !component.includes(":") && !WINDOWS_DEVICE_NAME.test(withoutTrailingDotsAndSpaces(component))
  );
}

/**
 * Whether Keiko may touch a Windows host path at all: an absolute path on a local drive letter,
 * whose every component is ordinary.
 */
export function isWindowsLocalDriveFilePath(path: string): boolean {
  if (!/^[A-Za-z]:[\\/]/u.test(path) || /[\0\r\n]/u.test(path)) return false;
  return path.slice(3).split(/[\\/]/u).every(isWindowsOrdinaryPathComponent);
}
