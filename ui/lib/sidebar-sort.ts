/**
 * Pure sort functions for sidebar display order. No side effects.
 *
 * Projects: favorites first, then lastOpenedAt descending, then path ascending.
 * Chats: updatedAt descending, then id ascending as tie-break.
 */

import type { ProjectWithAvailability, Chat } from "./types";

export function sortProjects(
  projects: readonly ProjectWithAvailability[],
): readonly ProjectWithAvailability[] {
  return [...projects].sort((a, b) => {
    // Favorites first
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    // Most recently opened first
    if (a.lastOpenedAt !== b.lastOpenedAt) return b.lastOpenedAt - a.lastOpenedAt;
    // Alphabetical by path as final tie-break
    return a.path.localeCompare(b.path);
  });
}

export function sortChats(chats: readonly Chat[]): readonly Chat[] {
  return [...chats].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id.localeCompare(b.id);
  });
}
