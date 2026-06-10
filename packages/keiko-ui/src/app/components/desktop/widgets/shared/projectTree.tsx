"use client";

import type { ReactNode } from "react";
import { Icons } from "../../Icons";

export function fileIconKey(name: string): string | null {
  const n = name.toLowerCase();
  if (n === "dockerfile" || n.includes("docker-compose") || n.endsWith(".dockerignore"))
    return "docker";
  if (n.endsWith(".json")) return "json";
  if (n.endsWith(".yml") || n.endsWith(".yaml")) return "yaml";
  if (n.endsWith(".md")) return "markdown";
  if (n.endsWith(".properties") || n.endsWith(".env") || n.startsWith(".env.")) return "properties";
  if (n.endsWith(".java")) return "java";
  if (n.endsWith(".tsx")) return "react";
  if (n.endsWith(".ts")) return "typescript";
  if (n.endsWith(".jsx") || n.endsWith(".js") || n.endsWith(".mjs") || n.endsWith(".cjs"))
    return "javascript";
  if (n.endsWith(".py")) return "python";
  if (n.endsWith(".go")) return "go";
  if (n.endsWith(".rs")) return "rust";
  if (n.endsWith(".gradle")) return "gradle";
  if (n.endsWith(".sql")) return "postgresql";
  if (n.endsWith(".html")) return "html5";
  if (n.endsWith(".css")) return "css3";
  if (n.endsWith(".graphql") || n.endsWith(".gql")) return "graphql";
  if (
    n.endsWith(".png") ||
    n.endsWith(".jpg") ||
    n.endsWith(".jpeg") ||
    n.endsWith(".gif") ||
    n.endsWith(".webp") ||
    n.endsWith(".svg")
  )
    return "image";
  return null;
}

export function FileIcon({ name, icon }: { name: string; icon?: string | undefined }): ReactNode {
  const key = icon ?? fileIconKey(name);
  if (key !== null) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- design CSS sizes raw SVG via .fi-img; next/image breaks sizing.
      <img className="fi-img" src={`/assets/icons/${key}.svg`} width="15" height="15" alt="" />
    );
  }
  return (
    <span className="fi-fallback">
      <Icons.file size={14} />
    </span>
  );
}

/* uiux-fix F027 C040: the fabricated PROJECT_TREE demo data (Java/Spring "orca"
   project) and its TreeNodeComponent renderer were removed — SearchPanel was the
   only consumer and showed the fake tree under the REAL project name. */
