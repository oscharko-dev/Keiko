import { Suspense } from "react";
import type { ReactNode } from "react";
import { CentralArea } from "./components/shell/CentralArea";
import { WorkspaceShellEntry } from "./components/shell/WorkspaceShellEntry";

/**
 * Root page — central area router.
 * CentralArea reads ?project= and ?chat= via useSearchParams(), which requires
 * a <Suspense> boundary in Next.js 15 App Router static export (ADR-0014).
 */
export default function Page(): ReactNode {
  return (
    <Suspense fallback={<WorkspaceShellEntry />}>
      <CentralArea />
    </Suspense>
  );
}
