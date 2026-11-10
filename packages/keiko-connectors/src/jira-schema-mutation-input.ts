import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asRecord } from "./atlassian-sync-classify.js";
import { jiraNativeId } from "./jira-native-values.js";
import { savedExactKeys, savedName, savedText } from "./jira-saved-configuration-values.js";
import {
  schemaArgs,
  schemaFieldSnapshot,
  schemaIdList,
  schemaIssueTypeSnapshot,
  schemaLinkTypeSnapshot,
  schemaList,
  schemaReviewed,
  schemaTerminologySnapshot,
  type FieldSnapshot,
  type IssueTypeSnapshot,
  type JiraSchemaMutation,
  type LinkTypeSnapshot,
  type TerminologySnapshot,
} from "./jira-schema-mutation-values.js";

interface Common {
  readonly operation: JiraSchemaMutation;
  readonly actor: string;
}
interface Metadata {
  readonly name?: string;
  readonly description?: string;
}
export type IssueTypeInput = Common &
  (
    | {
        readonly family: "issue-type";
        readonly kind: "create";
        readonly name: string;
        readonly description: string;
        readonly type: "standard" | "subtask";
      }
    | {
        readonly family: "issue-type";
        readonly kind: "update";
        readonly expected: IssueTypeSnapshot;
        readonly target: Metadata;
      }
    | {
        readonly family: "issue-type";
        readonly kind: "delete";
        readonly expected: IssueTypeSnapshot;
        readonly alternative: IssueTypeSnapshot | null;
      }
  );
export type LinkTypeInput = Common &
  (
    | {
        readonly family: "link-type";
        readonly kind: "create";
        readonly target: Omit<LinkTypeSnapshot, "id">;
      }
    | {
        readonly family: "link-type";
        readonly kind: "update";
        readonly expected: LinkTypeSnapshot;
        readonly target: Omit<LinkTypeSnapshot, "id">;
      }
    | { readonly family: "link-type"; readonly kind: "delete"; readonly expected: LinkTypeSnapshot }
    | {
        readonly family: "link-type";
        readonly kind: "order";
        readonly expectedTypes: readonly LinkTypeSnapshot[];
        readonly direction: "asc" | "desc";
      }
    | {
        readonly family: "link-type";
        readonly kind: "move";
        readonly expectedTypes: readonly LinkTypeSnapshot[];
        readonly id: string;
        readonly newPosition: number;
      }
  );
export type FieldInput = Common &
  (
    | {
        readonly family: "field";
        readonly kind: "create";
        readonly name: string;
        readonly description: string;
        readonly type: string;
        readonly searcherKey: string;
        readonly projectIds: readonly string[];
        readonly issueTypeIds: readonly string[];
      }
    | {
        readonly family: "field";
        readonly kind: "delete";
        readonly expectedFields: readonly FieldSnapshot[];
      }
  );
export interface TerminologyTarget {
  readonly originalName: "epic" | "sprint";
  readonly newName: string;
  readonly newNamePlural: string;
}
export interface TerminologyInput extends Common {
  readonly family: "terminology";
  readonly expectedEntries: readonly TerminologySnapshot[];
  readonly entries: readonly TerminologyTarget[];
}
export type SchemaInput = IssueTypeInput | LinkTypeInput | FieldInput | TerminologyInput;
const ISSUE_KEYS = ["expectedIssueType"];
function metadata(args: CatalogJsonObject): Metadata | undefined {
  const result: { name?: string; description?: string } = {};
  if (Object.hasOwn(args, "name")) {
    if (!savedName(args.name)) return undefined;
    result.name = args.name;
  }
  if (Object.hasOwn(args, "description")) {
    if (!savedText(args.description, 32768, true)) return undefined;
    result.description = args.description;
  }
  return Object.keys(result).length > 0 ? Object.freeze(result) : undefined;
}
function issueCreate(
  operation: JiraSchemaMutation,
  args: CatalogJsonObject,
): IssueTypeInput | undefined {
  if (
    !schemaArgs(args, ["name", "description", "type"]) ||
    !savedName(args.name) ||
    !savedText(args.description, 32768, true)
  )
    return undefined;
  if (args.type !== "standard" && args.type !== "subtask") return undefined;
  return {
    family: "issue-type",
    kind: "create",
    operation,
    actor: args.expectedActorKey,
    name: args.name,
    description: args.description,
    type: args.type,
  };
}
function issueUpdate(
  operation: JiraSchemaMutation,
  args: CatalogJsonObject,
): IssueTypeInput | undefined {
  if (!schemaArgs(args, [...ISSUE_KEYS, "name", "description"])) return undefined;
  const expected = schemaReviewed(args.expectedIssueType, schemaIssueTypeSnapshot);
  const target = metadata(args);
  return expected === undefined || target === undefined
    ? undefined
    : {
        family: "issue-type",
        kind: "update",
        operation,
        actor: args.expectedActorKey,
        expected,
        target,
      };
}
function issueDelete(
  operation: JiraSchemaMutation,
  args: CatalogJsonObject,
): IssueTypeInput | undefined {
  if (
    !schemaArgs(args, [...ISSUE_KEYS, "expectedAlternative", "confirmUnverifiedMigration"]) ||
    args.confirmUnverifiedMigration !== true
  )
    return undefined;
  const expected = schemaReviewed(args.expectedIssueType, schemaIssueTypeSnapshot);
  const alternative =
    args.expectedAlternative === null
      ? null
      : schemaReviewed(args.expectedAlternative, schemaIssueTypeSnapshot);
  if (expected === undefined || alternative === undefined || alternative?.id === expected.id)
    return undefined;
  return {
    family: "issue-type",
    kind: "delete",
    operation,
    actor: args.expectedActorKey,
    expected,
    alternative,
  };
}
function linkTarget(args: CatalogJsonObject): Omit<LinkTypeSnapshot, "id"> | undefined {
  if (!savedName(args.name) || !savedText(args.inward, 255) || !savedText(args.outward, 255))
    return undefined;
  return Object.freeze({ name: args.name, inward: args.inward, outward: args.outward });
}
function linkCreate(
  operation: JiraSchemaMutation,
  args: CatalogJsonObject,
): LinkTypeInput | undefined {
  if (!schemaArgs(args, ["name", "inward", "outward"])) return undefined;
  const target = linkTarget(args);
  return target === undefined
    ? undefined
    : { family: "link-type", kind: "create", operation, actor: args.expectedActorKey, target };
}
function linkExisting(
  operation: JiraSchemaMutation,
  args: CatalogJsonObject,
): LinkTypeInput | undefined {
  const removing = operation === "jira.delete-link-type";
  if (
    !schemaArgs(args, [
      "expectedLinkType",
      ...(removing ? ["confirmUnverifiedDeletion"] : ["name", "inward", "outward"]),
    ])
  )
    return undefined;
  const expected = schemaReviewed(args.expectedLinkType, schemaLinkTypeSnapshot);
  if (expected === undefined) return undefined;
  const common = {
    family: "link-type" as const,
    operation,
    actor: args.expectedActorKey,
    expected,
  };
  if (removing)
    return args.confirmUnverifiedDeletion === true ? { ...common, kind: "delete" } : undefined;
  const target = linkTarget(args);
  return target === undefined ? undefined : { ...common, kind: "update", target };
}
function reviewedLinks(value: unknown): readonly LinkTypeSnapshot[] | undefined {
  return schemaList(
    value,
    (raw) => schemaReviewed(raw, schemaLinkTypeSnapshot),
    (item) => item.id,
  );
}
function linkOrder(
  operation: JiraSchemaMutation,
  args: CatalogJsonObject,
): LinkTypeInput | undefined {
  if (!schemaArgs(args, ["expectedLinkTypes", "direction"])) return undefined;
  const expectedTypes = reviewedLinks(args.expectedLinkTypes);
  if (expectedTypes === undefined || (args.direction !== "asc" && args.direction !== "desc"))
    return undefined;
  return {
    family: "link-type",
    kind: "order",
    operation,
    actor: args.expectedActorKey,
    expectedTypes,
    direction: args.direction,
  };
}
function linkMove(
  operation: JiraSchemaMutation,
  args: CatalogJsonObject,
): LinkTypeInput | undefined {
  if (
    !schemaArgs(args, ["expectedLinkTypes", "linkTypeId", "newPosition"]) ||
    !jiraNativeId(args.linkTypeId)
  )
    return undefined;
  const expectedTypes = reviewedLinks(args.expectedLinkTypes);
  const position = args.newPosition;
  if (
    expectedTypes === undefined ||
    typeof position !== "number" ||
    !Number.isSafeInteger(position)
  )
    return undefined;
  if (
    position < 1 ||
    position > expectedTypes.length ||
    !expectedTypes.some((type) => type.id === args.linkTypeId)
  )
    return undefined;
  return {
    family: "link-type",
    kind: "move",
    operation,
    actor: args.expectedActorKey,
    expectedTypes,
    id: args.linkTypeId,
    newPosition: position,
  };
}
function moduleKey(value: unknown): value is string {
  return savedText(value, 1024) && /^[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+$/u.test(value);
}
function fieldCreate(
  operation: JiraSchemaMutation,
  args: CatalogJsonObject,
): FieldInput | undefined {
  if (
    !schemaArgs(args, ["name", "description", "type", "searcherKey", "projectIds", "issueTypeIds"])
  )
    return undefined;
  if (
    !savedName(args.name) ||
    !savedText(args.description, 32768, true) ||
    !moduleKey(args.type) ||
    !moduleKey(args.searcherKey)
  )
    return undefined;
  const projectIds = schemaIdList(args.projectIds);
  const issueTypeIds = schemaIdList(args.issueTypeIds);
  if (
    projectIds === undefined ||
    issueTypeIds === undefined ||
    projectIds.some((id) => !Number.isSafeInteger(Number(id)))
  )
    return undefined;
  return {
    family: "field",
    kind: "create",
    operation,
    actor: args.expectedActorKey,
    name: args.name,
    description: args.description,
    type: args.type,
    searcherKey: args.searcherKey,
    projectIds,
    issueTypeIds,
  };
}
function fieldDelete(
  operation: JiraSchemaMutation,
  args: CatalogJsonObject,
): FieldInput | undefined {
  if (
    !schemaArgs(args, ["expectedFields", "confirmUnverifiedDeletion"]) ||
    args.confirmUnverifiedDeletion !== true
  )
    return undefined;
  const expectedFields = schemaList(
    args.expectedFields,
    (raw) => schemaReviewed(raw, schemaFieldSnapshot),
    (field) => field.id,
    50,
  );
  return expectedFields === undefined || expectedFields.length === 0
    ? undefined
    : { family: "field", kind: "delete", operation, actor: args.expectedActorKey, expectedFields };
}
function terminologyTarget(value: unknown): TerminologyTarget | undefined {
  const raw = asRecord(value);
  if (
    raw === undefined ||
    !savedExactKeys(raw, new Set(["originalName", "newName", "newNamePlural"]))
  )
    return undefined;
  if (raw.originalName !== "epic" && raw.originalName !== "sprint") return undefined;
  // Native TerminologyEntryWriter trims and lowercases. Review its canonical desired spelling.
  if (!term(raw.newName) || !term(raw.newNamePlural)) return undefined;
  return Object.freeze({
    originalName: raw.originalName,
    newName: raw.newName,
    newNamePlural: raw.newNamePlural,
  });
}
function term(value: unknown): value is string {
  return (
    savedText(value, 100) && value === value.trim().toLowerCase() && /^[a-z0-9 ]+$/u.test(value)
  );
}
function terminology(
  operation: JiraSchemaMutation,
  args: CatalogJsonObject,
): TerminologyInput | undefined {
  if (!schemaArgs(args, ["expectedEntries", "entries"])) return undefined;
  const expectedEntries = schemaList(
    args.expectedEntries,
    (raw) => schemaReviewed(raw, schemaTerminologySnapshot),
    (entry) => entry.originalName.toLowerCase(),
    2,
  );
  const entries = schemaList(args.entries, terminologyTarget, (entry) => entry.originalName, 2);
  if (expectedEntries?.length !== 2 || entries === undefined || entries.length === 0)
    return undefined;
  return {
    family: "terminology",
    operation,
    actor: args.expectedActorKey,
    expectedEntries,
    entries,
  };
}
const PARSERS = {
  "jira.create-custom-field": fieldCreate,
  "jira.delete-custom-fields": fieldDelete,
  "jira.create-issue-type": issueCreate,
  "jira.update-issue-type": issueUpdate,
  "jira.delete-issue-type": issueDelete,
  "jira.create-link-type": linkCreate,
  "jira.update-link-type": linkExisting,
  "jira.delete-link-type": linkExisting,
  "jira.reset-link-type-order": linkOrder,
  "jira.move-link-type": linkMove,
  "jira.set-terminology": terminology,
} satisfies Readonly<
  Record<
    JiraSchemaMutation,
    (operation: JiraSchemaMutation, args: CatalogJsonObject) => SchemaInput | undefined
  >
>;
export function parseSchemaMutation(
  operation: JiraSchemaMutation,
  args: CatalogJsonObject,
): SchemaInput | undefined {
  return PARSERS[operation](operation, args);
}
