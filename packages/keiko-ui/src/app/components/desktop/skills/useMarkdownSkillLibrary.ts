"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MARKDOWN_SKILL_LIMITS,
  type MarkdownSkillDocument,
  type MarkdownSkillMetadata,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  deleteMarkdownSkill,
  exportMarkdownSkill,
  fetchMarkdownSkills,
  markdownSkillUpload,
  readMarkdownSkill,
  saveMarkdownSkill,
} from "@/lib/markdown-skills-api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { correlationIdOf } from "@/lib/client-error-summary";
import { bffRequestErrorKind } from "@/lib/http";

export interface MarkdownSkillLibrary {
  readonly skills: readonly MarkdownSkillMetadata[];
  readonly preview: MarkdownSkillDocument | undefined;
  readonly busy: boolean;
  readonly error: "request" | "file" | undefined;
  readonly refresh: () => Promise<void>;
  readonly inspect: (skill: MarkdownSkillMetadata) => Promise<void>;
  readonly upload: (file: File, previous?: MarkdownSkillMetadata) => Promise<void>;
  readonly remove: (skill: MarkdownSkillMetadata) => Promise<void>;
  readonly download: (skill: MarkdownSkillMetadata) => Promise<void>;
}

export function downloadSkillMarkdown(content: string, name: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function useLibraryRequest(): {
  readonly busy: boolean;
  readonly error: MarkdownSkillLibrary["error"];
  readonly setError: (value: MarkdownSkillLibrary["error"]) => void;
  readonly active: { current: boolean };
  readonly run: (operation: () => Promise<void>) => Promise<void>;
} {
  const [error, setError] = useState<MarkdownSkillLibrary["error"]>();
  const [busy, setBusy] = useState(true);
  const active = useRef(true);
  const locked = useRef(false);
  useEffect(() => {
    active.current = true;
    return (): void => {
      active.current = false;
    };
  }, []);
  const run = useCallback(async (operation: () => Promise<void>): Promise<void> => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await operation();
    } catch (error_) {
      if (active.current) setError("request");
      reportClientDiagnostic("Private skill library request failed.", {
        correlationId: correlationIdOf(error_),
        errorKind: bffRequestErrorKind(error_),
        errorEvidence: clientErrorEvidence(error_),
      });
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }, []);
  return { busy, error, setError, active, run };
}

export function useMarkdownSkillLibrary(onChange: () => Promise<void>): MarkdownSkillLibrary {
  const [skills, setSkills] = useState<readonly MarkdownSkillMetadata[]>([]);
  const [preview, setPreview] = useState<MarkdownSkillDocument>();
  const request = useLibraryRequest();
  const { active, run } = request;
  const reload = useCallback(async (): Promise<void> => {
    const next = await fetchMarkdownSkills();
    if (active.current) setSkills(next);
  }, [active]);
  const refresh = useCallback(() => run(reload), [run, reload]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return {
    skills,
    preview,
    busy: request.busy,
    error: request.error,
    refresh,
    ...libraryActions({ ...request, reload, setPreview, onChange }),
  };
}

function libraryActions({
  active,
  run,
  reload,
  setPreview,
  onChange,
  setError,
}: ReturnType<typeof useLibraryRequest> & {
  readonly reload: () => Promise<void>;
  readonly setPreview: (value: MarkdownSkillDocument | undefined) => void;
  readonly onChange: () => Promise<void>;
}): Pick<MarkdownSkillLibrary, "inspect" | "upload" | "remove" | "download"> {
  return {
    inspect: (skill) =>
      run(async () => {
        const result = await readMarkdownSkill(skill);
        if (active.current) setPreview(result);
      }),
    upload: (file, previous): Promise<void> => {
      if (
        file.size === 0 ||
        file.size > MARKDOWN_SKILL_LIMITS.importBytes ||
        !/\.md$/iu.test(file.name)
      ) {
        setError("file");
        return Promise.resolve();
      }
      return run(async () => {
        const result = await saveMarkdownSkill(await markdownSkillUpload(file), previous);
        if (active.current) setPreview(result);
        await reload();
        await onChange();
      });
    },
    remove: (skill) =>
      run(async () => {
        await deleteMarkdownSkill(skill);
        if (active.current) setPreview(undefined);
        await reload();
        await onChange();
      }),
    download: (skill) =>
      run(async () => {
        const result = await exportMarkdownSkill(skill);
        if (active.current) downloadSkillMarkdown(result.content, result.fileName);
      }),
  };
}
