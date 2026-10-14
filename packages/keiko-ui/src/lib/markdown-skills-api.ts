"use client";

import type {
  MarkdownSkillDocument,
  MarkdownSkillMetadata,
  MarkdownSkillReference,
  MarkdownSkillSelectionView,
  MarkdownSkillUpload,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import { codingAppSessionPairingSettled } from "./coding-app-session-client";
import { bffFetchJson } from "./http";

async function skillRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  await codingAppSessionPairingSettled();
  return bffFetchJson<T>(path, { signal: AbortSignal.timeout(15_000), ...init });
}

export async function fetchMarkdownSkills(): Promise<readonly MarkdownSkillMetadata[]> {
  return (await skillRequest<{ skills: readonly MarkdownSkillMetadata[] }>("/api/skills")).skills;
}

export async function readMarkdownSkill(
  skill: MarkdownSkillReference,
): Promise<MarkdownSkillDocument> {
  return (
    await skillRequest<{ skill: MarkdownSkillDocument }>(
      `/api/skills/${encodeURIComponent(skill.id)}?revision=${String(skill.revision)}`,
    )
  ).skill;
}

export async function saveMarkdownSkill(
  upload: MarkdownSkillUpload,
  previous?: MarkdownSkillReference,
): Promise<MarkdownSkillDocument> {
  const path =
    previous === undefined ? "/api/skills" : `/api/skills/${encodeURIComponent(previous.id)}`;
  return (
    await skillRequest<{ skill: MarkdownSkillDocument }>(path, {
      method: previous === undefined ? "POST" : "PUT",
      body: JSON.stringify({
        ...upload,
        ...(previous === undefined ? {} : { expectedRevision: previous.revision }),
      }),
    })
  ).skill;
}

export function deleteMarkdownSkill(skill: MarkdownSkillReference): Promise<void> {
  return skillRequest(`/api/skills/${encodeURIComponent(skill.id)}`, {
    method: "DELETE",
    body: JSON.stringify({ expectedRevision: skill.revision }),
  });
}

export function exportMarkdownSkill(
  skill: MarkdownSkillReference,
): Promise<{ fileName: string; content: string }> {
  return skillRequest(
    `/api/skills/${encodeURIComponent(skill.id)}/export?revision=${String(skill.revision)}`,
  );
}

export function fetchMarkdownSkillSelection(
  chatId: string,
  signal?: AbortSignal,
): Promise<MarkdownSkillSelectionView> {
  return skillRequest(
    `/api/chats/${encodeURIComponent(chatId)}/skill`,
    signal === undefined ? {} : { signal },
  );
}

export function changeMarkdownSkillSelection(
  chatId: string,
  skill: MarkdownSkillReference | null,
  expectedRevision: number,
): Promise<MarkdownSkillSelectionView> {
  return skillRequest(`/api/chats/${encodeURIComponent(chatId)}/skill`, {
    method: "PUT",
    body: JSON.stringify({ skill, expectedRevision }),
  });
}

/** Preserve exact bytes: UTF-8 validity and normalization belong to the private library. */
export async function markdownSkillUpload(file: File): Promise<MarkdownSkillUpload> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return { fileName: file.name, contentBase64: btoa(binary) };
}
