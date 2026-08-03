import { constants, copyFileSync, linkSync } from "node:fs";

const HARD_LINK_UNAVAILABLE_CODES = new Set(["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"]);

export function publishFileWithoutReplacement(source: string, destination: string): void {
  try {
    linkSync(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined || !HARD_LINK_UNAVAILABLE_CODES.has(code)) throw error;
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  }
}
