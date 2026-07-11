import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

async function walkRuntimeTree(dir, removed) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkRuntimeTree(fullPath, removed);
        return;
      }
      if (entry.isFile() && entry.name.endsWith(".js.map")) {
        await rm(fullPath, { force: true });
        removed.push(fullPath);
      }
    }),
  );
}

export async function removeRuntimeJavaScriptSourceMaps(staticDir) {
  const removed = [];
  await walkRuntimeTree(staticDir, removed);
  return removed.sort((a, b) => a.localeCompare(b));
}
