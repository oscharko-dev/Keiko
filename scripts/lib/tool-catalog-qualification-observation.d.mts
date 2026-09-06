export interface ToolCatalogQualificationBinding {
  readonly catalogRevision: string;
  readonly profile: { readonly id: string; readonly version: number };
  readonly projectionDigest: string;
  readonly handlerSetDigest: string;
}

export type ToolCatalogQualificationConsumer =
  "native-harness-gateway" | "cli-server-sdk" | "managed-opencode" | "read-only-child" | "editor";

export interface WriteToolCatalogQualificationObservationInput {
  readonly consumer: ToolCatalogQualificationConsumer;
  readonly component:
    | "native-harness-gateway"
    | "cli"
    | "server"
    | "sdk"
    | "managed-opencode"
    | "read-only-child"
    | "editor";
  readonly binding: ToolCatalogQualificationBinding;
  readonly terminalStatus: "completed" | "unavailable";
  readonly settlementCount: number;
  readonly proof:
    | { readonly kind: "closed-unavailable" }
    | { readonly kind: "single-settlement" }
    | {
        readonly kind: "managed-search-read";
        readonly searchSettled: true;
        readonly boundedReadSettled: true;
        readonly causalHandoff: true;
      };
}

export const TOOL_CATALOG_QUALIFICATION_DIR_ENV: "KEIKO_TOOL_CATALOG_QUALIFICATION_DIR";
export const TOOL_CATALOG_QUALIFICATION_HEAD_ENV: "KEIKO_TOOL_CATALOG_QUALIFICATION_HEAD";
export const TOOL_CATALOG_QUALIFICATION_COMPONENTS: Readonly<
  Record<ToolCatalogQualificationConsumer, readonly string[]>
>;
export const TOOL_CATALOG_QUALIFICATION_PACKAGES: Readonly<
  Record<ToolCatalogQualificationConsumer, readonly string[]>
>;

export function captureToolCatalogQualificationBinding(
  binding: unknown,
): ToolCatalogQualificationBinding | undefined;

export function writeToolCatalogQualificationObservation(
  input: WriteToolCatalogQualificationObservationInput,
): void;

export function validToolCatalogQualificationOutcome(
  component: WriteToolCatalogQualificationObservationInput["component"],
  terminalStatus: WriteToolCatalogQualificationObservationInput["terminalStatus"],
  settlementCount: number,
  proof: WriteToolCatalogQualificationObservationInput["proof"],
): boolean;
