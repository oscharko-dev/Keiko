import {
  parseFigmaSnapshotLink,
  type FigmaTarget,
} from "@oscharko-dev/keiko-contracts/runtime/figma-url";

export type { FigmaTarget };

export function parseFigmaTarget(value: string): FigmaTarget | null {
  const result = parseFigmaSnapshotLink(value);
  return result.kind === "valid" ? result.target : null;
}
