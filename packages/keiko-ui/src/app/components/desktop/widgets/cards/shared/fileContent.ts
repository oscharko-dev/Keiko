import { langOf, type Lang } from "./syntaxHighlight";

// Sample source for in-card preview. Verbatim from project/highlight.jsx —
// kept as plain string literals (no backticks) to avoid TS template-literal issues.
export const FILE_CONTENT: Readonly<Record<string, string>> = {
  "README.md":
    "# example-workspace\n\nEnterprise agent platform — **self-hosted**, runs behind your firewall.\n\n## Stack\n- Backend: Spring Boot (Java 21)\n- Frontend: React + TypeScript\n- Infra: Kubernetes, Prometheus\n\n## Quickstart\n\n    ./gradlew bootRun\n    npm --prefix frontend run dev\n\nSee `deploy/k8s` for production manifests.",
  "package.json":
    '{\n  "name": "example-frontend",\n  "version": "1.4.0",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "build": "tsc && vite build",\n    "test": "vitest run"\n  },\n  "dependencies": {\n    "react": "18.3.1",\n    "react-dom": "18.3.1"\n  },\n  "devDependencies": {\n    "typescript": "5.4.0",\n    "vite": "5.4.0"\n  }\n}',
  "App.tsx":
    'import React from "react";\nimport { Workspace } from "./components/Workspace";\nimport { useAgents } from "./api/client";\n\nexport default function App() {\n  const { agents, loading } = useAgents();\n  if (loading) return <Spinner label="Loading agents" />;\n  return (\n    <main className="app">\n      <Workspace agents={agents} />\n    </main>\n  );\n}',
  "client.ts":
    'import { z } from "zod";\n\nexport interface Agent {\n  id: string;\n  role: string;\n  status: "running" | "paused" | "done";\n}\n\nexport async function fetchAgents(): Promise<Agent[]> {\n  const res = await fetch("/api/agents");\n  if (!res.ok) throw new Error("agent fetch failed");\n  return res.json();\n}',
  "OrcaApplication.java":
    "package com.keiko.orca;\n\nimport org.springframework.boot.SpringApplication;\nimport org.springframework.boot.autoconfigure.SpringBootApplication;\n\n@SpringBootApplication\npublic class OrcaApplication {\n    // Bootstraps the agent platform\n    public static void main(String[] args) {\n        SpringApplication.run(OrcaApplication.class, args);\n    }\n}",
  "application.yml":
    "server:\n  port: 8443\nspring:\n  application:\n    name: example-workspace\n  datasource:\n    url: jdbc:postgresql://db.example.test:5432/app\nkeiko:\n  models:\n    chat: https://llm-gateway.example.com/v1\n    embedding: https://embeddings.example.com/v1",
  Dockerfile:
    '# Multi-stage build for the orca backend\nFROM eclipse-temurin:21-jdk AS build\nWORKDIR /app\nCOPY . .\nRUN ./gradlew bootJar\n\nFROM eclipse-temurin:21-jre\nWORKDIR /app\nCOPY --from=build /app/build/libs/*.jar app.jar\nEXPOSE 8443\nENTRYPOINT ["java", "-jar", "app.jar"]',
};

export function stub(name: string, lang: Lang): string {
  const base = name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]/g, "");
  const cap = base.charAt(0).toUpperCase() + base.slice(1) || "File";
  if (lang === "java") {
    return (
      "package com.keiko.orca;\n\n// " +
      name +
      "\npublic class " +
      cap +
      ' {\n    public String describe() {\n        return "' +
      name +
      '";\n    }\n}'
    );
  }
  if (lang === "kotlin") {
    return (
      "package com.keiko.orca\n\n// " +
      name +
      "\nclass " +
      cap +
      ' {\n    fun describe(): String = "' +
      name +
      '"\n}'
    );
  }
  if (lang === "ts") {
    return (
      "// " + name + "\nexport const " + base + ' = {\n  name: "' + name + '",\n  ready: true,\n};'
    );
  }
  if (lang === "js") {
    return (
      "// " +
      name +
      '\nimport React from "react";\nexport function ' +
      cap +
      '() {\n  return <div className="' +
      base +
      '">' +
      cap +
      "</div>;\n}"
    );
  }
  if (lang === "yaml") {
    return (
      "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: " +
      base +
      "\nspec:\n  replicas: 3   # " +
      name
    );
  }
  if (lang === "sql") {
    return (
      "-- " + name + "\nCREATE TABLE agents (\n  id   uuid PRIMARY KEY,\n  role text NOT NULL\n);"
    );
  }
  if (lang === "cobol") {
    return (
      "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. " +
      cap.toUpperCase() +
      '.\n       PROCEDURE DIVISION.\n           DISPLAY "' +
      name +
      '".\n           STOP RUN.'
    );
  }
  if (lang === "graphql") {
    return "type Agent {\n  id: ID!\n  role: String!\n  status: Status!\n}\n\nenum Status { RUNNING PAUSED DONE }";
  }
  if (lang === "css") {
    return "/* " + name + " */\n.workspace {\n  background: #0d0d0d;\n  color: #ededed;\n}";
  }
  if (lang === "props") {
    return (
      "# " + name + "\nkeiko.mode=autonomous\nkeiko.model.chat=https://llm-gateway.example.com/v1"
    );
  }
  return "// " + name + "\n// preview";
}

export function fileContent(name: string): string {
  return FILE_CONTENT[name] ?? stub(name, langOf(name));
}
