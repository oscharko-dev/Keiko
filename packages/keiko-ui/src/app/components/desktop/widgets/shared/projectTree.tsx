"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { Icons } from "../../Icons";

export interface TreeNode {
  name: string;
  type: "folder" | "file";
  icon?: string;
  open?: boolean;
  mut?: string;
  children?: TreeNode[];
}

export function fileIconKey(name: string): string | null {
  const n = name.toLowerCase();
  if (n === "dockerfile" || n.includes("docker-compose") || n.endsWith(".dockerignore")) return "docker";
  if (n.endsWith(".json")) return "json";
  if (n.endsWith(".yml") || n.endsWith(".yaml")) return "yaml";
  if (n.endsWith(".md")) return "markdown";
  if (n.endsWith(".properties") || n.endsWith(".env") || n.startsWith(".env.")) return "properties";
  if (n.endsWith(".java")) return "java";
  if (n.endsWith(".tsx")) return "react";
  if (n.endsWith(".ts")) return "typescript";
  if (n.endsWith(".jsx") || n.endsWith(".js") || n.endsWith(".mjs") || n.endsWith(".cjs")) return "javascript";
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
  ) return "image";
  return null;
}

export function FileIcon({ name, icon }: { name: string; icon?: string | undefined }): ReactNode {
  const key = icon ?? fileIconKey(name);
  if (key !== null) {
    // eslint-disable-next-line @next/next/no-img-element -- design CSS sizes raw SVG via .fi-img; next/image breaks sizing
    return <img className="fi-img" src={`/assets/icons/${key}.svg`} width="15" height="15" alt="" />;
  }
  return (
    <span className="fi-fallback">
      <Icons.file size={14} />
    </span>
  );
}

export const PROJECT_TREE: TreeNode[] = [
  {
    name: "backend",
    type: "folder",
    icon: "spring",
    children: [
      {
        name: "src/main/java/com/keiko/orca",
        type: "folder",
        children: [
          { name: "OrcaApplication.java", type: "file" },
          {
            name: "api",
            type: "folder",
            open: false,
            children: [
              { name: "AgentController.java", type: "file" },
              { name: "WorkspaceController.java", type: "file" },
            ],
          },
          {
            name: "service",
            type: "folder",
            open: false,
            children: [
              { name: "InferenceService.java", type: "file" },
              { name: "AgentOrchestrator.java", type: "file" },
            ],
          },
          {
            name: "config",
            type: "folder",
            open: false,
            children: [{ name: "SecurityConfig.java", type: "file" }],
          },
        ],
      },
      {
        name: "src/main/resources",
        type: "folder",
        open: false,
        children: [
          { name: "application.yml", type: "file" },
          { name: "schema.sql", type: "file" },
        ],
      },
      { name: "build.gradle", type: "file" },
      { name: "Dockerfile", type: "file" },
    ],
  },
  {
    name: "frontend",
    type: "folder",
    icon: "react",
    children: [
      {
        name: "src",
        type: "folder",
        children: [
          { name: "App.tsx", type: "file" },
          {
            name: "components",
            type: "folder",
            open: false,
            children: [
              { name: "Workspace.tsx", type: "file" },
              { name: "WindowManager.tsx", type: "file" },
            ],
          },
          {
            name: "api",
            type: "folder",
            open: false,
            children: [
              { name: "client.ts", type: "file" },
              { name: "schema.graphql", type: "file" },
            ],
          },
          {
            name: "styles",
            type: "folder",
            open: false,
            children: [{ name: "theme.css", type: "file" }],
          },
        ],
      },
      { name: "package.json", type: "file", mut: "M" },
      { name: "tsconfig.json", type: "file" },
      { name: "Dockerfile", type: "file" },
    ],
  },
  {
    name: "deploy",
    type: "folder",
    icon: "kubernetes",
    children: [
      {
        name: "k8s",
        type: "folder",
        children: [
          { name: "deployment.yaml", type: "file", icon: "kubernetes" },
          { name: "service.yaml", type: "file", icon: "kubernetes" },
          { name: "ingress.yaml", type: "file", icon: "kubernetes" },
        ],
      },
      { name: "docker-compose.yml", type: "file" },
      { name: "prometheus.yml", type: "file", icon: "prometheus" },
    ],
  },
  {
    name: ".github/workflows",
    type: "folder",
    icon: "github",
    open: false,
    children: [
      { name: "ci.yml", type: "file" },
      { name: "release.yml", type: "file" },
    ],
  },
  { name: "README.md", type: "file" },
];

interface TreeNodeProps {
  node: TreeNode;
  depth: number;
  path: string;
  active: string | null;
  onPick: (path: string) => void;
}

export function TreeNodeComponent({ node, depth, path, active, onPick }: TreeNodeProps): ReactNode {
  const [open, setOpen] = useState(node.open !== false);
  const pad = 8 + depth * 13;
  const myPath = `${path}/${node.name}`;

  if (node.type === "folder") {
    return (
      <div>
        <button
          className="tr-row"
          style={{ paddingLeft: pad }}
          onClick={() => { setOpen((o) => !o); }}
        >
          <span className="tr-caret" data-open={open}>
            <Icons.chevronR size={11} />
          </span>
          {node.icon !== undefined ? (
            // eslint-disable-next-line @next/next/no-img-element -- design CSS sizes raw SVG via .fi-img; next/image breaks sizing
            <img
              className="fi-img"
              src={`/assets/icons/${node.icon}.svg`}
              width="15"
              height="15"
              alt=""
            />
          ) : (
            <span className="fi-fallback" style={{ color: "var(--accent)" }}>
              <Icons.folder size={14} />
            </span>
          )}
          <span className="tr-name tr-folder">{node.name}</span>
        </button>
        {open &&
          node.children?.map((child, i) => (
            <TreeNodeComponent
              key={`${myPath}/${child.name}-${String(i)}`}
              node={child}
              depth={depth + 1}
              path={myPath}
              active={active}
              onPick={onPick}
            />
          ))}
      </div>
    );
  }

  return (
    <button
      className="tr-row tr-file"
      data-active={active === myPath}
      style={{ paddingLeft: pad + 14 }}
      onClick={() => { onPick(myPath); }}
    >
      <FileIcon name={node.name} icon={node.icon} />
      <span className="tr-name">{node.name}</span>
      {node.mut !== undefined && <span className="file-mut">{node.mut}</span>}
    </button>
  );
}
