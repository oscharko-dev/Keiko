"use client";

import type { ReactNode } from "react";
import { Icons } from "../../Icons";

interface FileIconRule {
  test: (n: string) => boolean;
  key: string;
}

const FILE_ICON_RULES: FileIconRule[] = [
  {
    test: (n) => n === "dockerfile" || n.includes("docker-compose") || n.endsWith(".dockerignore"),
    key: "docker",
  },
  { test: (n) => n.endsWith(".json"), key: "json" },
  { test: (n) => n.endsWith(".yml") || n.endsWith(".yaml"), key: "yaml" },
  { test: (n) => n.endsWith(".md"), key: "markdown" },
  {
    test: (n) => n.endsWith(".properties") || n.endsWith(".env") || n.startsWith(".env."),
    key: "properties",
  },
  { test: (n) => n.endsWith(".java"), key: "java" },
  { test: (n) => n.endsWith(".tsx"), key: "react" },
  { test: (n) => n.endsWith(".ts"), key: "typescript" },
  {
    test: (n) =>
      n.endsWith(".jsx") || n.endsWith(".js") || n.endsWith(".mjs") || n.endsWith(".cjs"),
    key: "javascript",
  },
  { test: (n) => n.endsWith(".py"), key: "python" },
  { test: (n) => n.endsWith(".go"), key: "go" },
  { test: (n) => n.endsWith(".rs"), key: "rust" },
  { test: (n) => n.endsWith(".gradle"), key: "gradle" },
  { test: (n) => n.endsWith(".sql"), key: "postgresql" },
  { test: (n) => n.endsWith(".html"), key: "html5" },
  { test: (n) => n.endsWith(".css"), key: "css3" },
  { test: (n) => n.endsWith(".graphql") || n.endsWith(".gql"), key: "graphql" },
  {
    test: (n) =>
      n.endsWith(".png") ||
      n.endsWith(".jpg") ||
      n.endsWith(".jpeg") ||
      n.endsWith(".gif") ||
      n.endsWith(".webp") ||
      n.endsWith(".svg"),
    key: "image",
  },
];

export function fileIconKey(name: string): string | null {
  const n = name.toLowerCase();
  const rule = FILE_ICON_RULES.find(({ test }) => test(n));
  return rule ? rule.key : null;
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
