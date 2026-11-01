// Vocabulary of requirement documents as data (#4179, Epic #4173).
//
// The words a specification uses for priority, acceptance criteria, modal obligations and table
// columns differ by language and house style. They live here as data with multilingual defaults
// (German, English, French, Spanish, Italian) and are compiled once into the patterns the inventory
// scans with, so adding a language or a house term changes data, never control flow. A caller can
// extend any list through `RequirementInventoryInput.vocabulary`.

export type TableColumnRole = "id" | "title" | "statement" | "priority" | "criteria";

export interface RequirementVocabulary {
  /** Keys that introduce a priority value (`Priorität: Muss`). */
  readonly priorityKeys: readonly string[];
  /** Values that name a priority; a table cell or a bracketed tag equal to one is a priority. */
  readonly priorityValues: readonly string[];
  /** Keys that introduce acceptance criteria. */
  readonly criteriaKeys: readonly string[];
  /** Keys whose line carries metadata, not statement text. */
  readonly metaKeys: readonly string[];
  /** Keys that label the statement itself (`Anforderung: ...`); the label is not content. */
  readonly statementKeys: readonly string[];
  /** Obligation phrases; a sentence containing one is a requirement statement. */
  readonly modalVerbs: readonly string[];
  /**
   * Obligation phrases that carry their own impersonal subject and may open a statement (`Il faut
   * chiffrer…`). Any other phrase that opens a sentence leaves it without a subject: a checklist
   * fragment (`Muss dem Epic zugeordnet sein`), not a requirement statement.
   */
  readonly impersonalModalVerbs: readonly string[];
  /** Identifier prefixes that name a standard or a technology, never a requirement. */
  readonly reservedPrefixes: readonly string[];
  /** Table header names per column role. */
  readonly tableColumns: Readonly<Record<TableColumnRole, readonly string[]>>;
}

export const DEFAULT_REQUIREMENT_VOCABULARY: RequirementVocabulary = Object.freeze({
  priorityKeys: [
    "Priorität",
    "Prioritaet",
    "Priority",
    "Prio",
    "Priorité",
    "Prioridad",
    "Priorità",
    "Verbindlichkeit",
  ],
  priorityValues: [
    "muss",
    "soll",
    "kann",
    "sollte",
    "must",
    "should",
    "could",
    "may",
    "shall",
    "mandatory",
    "optional",
    "essential",
    "must have",
    "should have",
    "could have",
    "hoch",
    "mittel",
    "niedrig",
    "kritisch",
    "high",
    "medium",
    "low",
    "critical",
    "doit",
    "devrait",
    "peut",
    "obligatoire",
    "facultatif",
    "haute",
    "moyenne",
    "basse",
    "debe",
    "debería",
    "puede",
    "obligatorio",
    "opcional",
    "alta",
    "media",
    "baja",
    "deve",
    "dovrebbe",
    "può",
    "obbligatorio",
    "facoltativo",
    "bassa",
    "p0",
    "p1",
    "p2",
    "p3",
  ],
  criteriaKeys: [
    "Abnahmekriterien",
    "Abnahmekriterium",
    "Akzeptanzkriterien",
    "Akzeptanzkriterium",
    "Acceptance criteria",
    "Acceptance criterion",
    "Critères d'acceptation",
    "Critère d'acceptation",
    "Criterios de aceptación",
    "Criterio de aceptación",
    "Criteri di accettazione",
    "Criterio di accettazione",
  ],
  metaKeys: [
    "Quelle",
    "Source",
    "Kapitel",
    "Chapter",
    "Status",
    "Hinweis",
    "Note",
    "Speaker notes",
    "Anmerkung",
    "Abhängigkeit",
    "Abhängigkeiten",
    "Dependency",
    "Dependencies",
    "Verantwortlich",
    "Owner",
    "Fuente",
    "Origine",
    "Remarque",
  ],
  statementKeys: [
    "Anforderung",
    "Anforderungstext",
    "Beschreibung",
    "Requirement",
    "Requirement text",
    "Description",
    "Statement",
    "Exigence",
    "Descripción",
    "Requisito",
    "Descrizione",
  ],
  modalVerbs: [
    "muss",
    "müssen",
    "muß",
    "soll",
    "sollen",
    "sollte",
    "sollten",
    "hat zu",
    "haben zu",
    "darf nicht",
    "dürfen nicht",
    "shall",
    "must",
    "should",
    "is required to",
    "are required to",
    "doit",
    "doivent",
    "devrait",
    "devraient",
    "il faut",
    "est tenu de",
    "debe",
    "deben",
    "debería",
    "deberían",
    "tiene que",
    "tienen que",
    "deve",
    "devono",
    "dovrebbe",
    "dovrebbero",
    "è necessario",
    "è richiesto",
  ],
  impersonalModalVerbs: ["il faut", "è necessario", "è richiesto"],
  reservedPrefixes: [
    "AC",
    "TC",
    "DRV",
    "ISO",
    "IEC",
    "RFC",
    "DIN",
    "SHA",
    "UTF",
    "MD",
    "TLS",
    "SSL",
    "IPV",
    "PCI",
    "HTTP",
    "HTTPS",
    "AES",
    "RSA",
    "DES",
    "SQL",
    "TCP",
    "UDP",
    "SMTP",
    "IMAP",
    "HTML",
    "CSS",
    "JSON",
    "XML",
    "SSH",
    "FTP",
    "DNS",
    "USB",
    "PDF",
    "WCAG",
  ],
  tableColumns: {
    id: [
      "id",
      "kennung",
      "nr",
      "nummer",
      "no",
      "number",
      "ref",
      "reference",
      "identifier",
      "req id",
    ],
    title: ["titel", "title", "name", "bezeichnung", "titre", "título", "titolo", "nom", "nombre"],
    statement: [
      "beschreibung",
      "description",
      "anforderung",
      "requirement",
      "text",
      "statement",
      "descripción",
      "descrizione",
    ],
    priority: ["priorität", "prioritaet", "priority", "prio", "priorité", "prioridad", "priorità"],
    criteria: [
      "abnahmekriterien",
      "akzeptanzkriterien",
      "acceptance criteria",
      "critères d'acceptation",
      "criterios de aceptación",
      "criteri di accettazione",
    ],
  },
});

/** The patterns one scan uses; compiled once per inventory call from the merged vocabulary. */
export interface CompiledVocabulary {
  /** `^<priority key>\s*[:=]` */
  readonly priorityKey: RegExp;
  /** `^<criteria key>` followed by an optional colon. */
  readonly criteriaKey: RegExp;
  /** `^<meta key>\s*:` */
  readonly metaKey: RegExp;
  /** `^<statement key>\s*:` */
  readonly statementKey: RegExp;
  /** Global zero-width split point in front of an inline priority or criteria key. */
  readonly inlineKey: RegExp;
  /** A sentence with an obligation phrase. */
  readonly modal: RegExp;
  /** A sentence that opens with a personal obligation phrase, so it names no subject. */
  readonly subjectlessModal: RegExp;
  /** A bracketed or parenthesized priority tag, e.g. `(MUSS)` or `[Must]`. */
  readonly priorityTag: RegExp;
  readonly priorityValues: ReadonlySet<string>;
  readonly reservedPrefixes: ReadonlySet<string>;
  readonly tableRoles: ReadonlyMap<string, TableColumnRole>;
}

const LETTER_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const LETTER_AFTER = String.raw`(?![\p{L}\p{N}])`;

function escapeTerm(term: string): string {
  return term
    .replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
    .replaceAll(/\s+/gu, String.raw`\s+`);
}

function alternation(terms: readonly string[]): string {
  return [...terms]
    .sort((a, b) => b.length - a.length)
    .map((term) => escapeTerm(term))
    .join("|");
}

/** Folds case and diacritics so a table header or value compares across spellings. */
export function foldTerm(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function merge(base: readonly string[], extra: readonly string[] | undefined): readonly string[] {
  return extra === undefined ? base : [...new Set([...base, ...extra])];
}

export function mergeRequirementVocabulary(
  extra: Partial<RequirementVocabulary> | undefined,
): RequirementVocabulary {
  const base = DEFAULT_REQUIREMENT_VOCABULARY;
  if (extra === undefined) return base;
  const columns = (role: TableColumnRole): readonly string[] =>
    merge(base.tableColumns[role], extra.tableColumns?.[role]);
  return {
    priorityKeys: merge(base.priorityKeys, extra.priorityKeys),
    priorityValues: merge(base.priorityValues, extra.priorityValues),
    criteriaKeys: merge(base.criteriaKeys, extra.criteriaKeys),
    metaKeys: merge(base.metaKeys, extra.metaKeys),
    statementKeys: merge(base.statementKeys, extra.statementKeys),
    modalVerbs: merge(base.modalVerbs, extra.modalVerbs),
    impersonalModalVerbs: merge(base.impersonalModalVerbs, extra.impersonalModalVerbs),
    reservedPrefixes: merge(base.reservedPrefixes, extra.reservedPrefixes),
    tableColumns: {
      id: columns("id"),
      title: columns("title"),
      statement: columns("statement"),
      priority: columns("priority"),
      criteria: columns("criteria"),
    },
  };
}

function tableRoleMap(vocabulary: RequirementVocabulary): ReadonlyMap<string, TableColumnRole> {
  const roles = new Map<string, TableColumnRole>();
  for (const [role, names] of Object.entries(vocabulary.tableColumns) as [
    TableColumnRole,
    readonly string[],
  ][])
    for (const name of names) roles.set(foldTerm(name), role);
  return roles;
}

/** Obligation phrases that need a subject before them: every one that is not impersonal. */
function personalModals(vocabulary: RequirementVocabulary): string {
  const impersonal = new Set(vocabulary.impersonalModalVerbs.map((term) => foldTerm(term)));
  return alternation(vocabulary.modalVerbs.filter((term) => !impersonal.has(foldTerm(term))));
}

export function compileRequirementVocabulary(
  extra?: Partial<RequirementVocabulary>,
): CompiledVocabulary {
  const vocabulary = mergeRequirementVocabulary(extra);
  const priorityKeys = alternation(vocabulary.priorityKeys);
  const criteriaKeys = alternation(vocabulary.criteriaKeys);
  const values = alternation(vocabulary.priorityValues);
  return {
    priorityKey: new RegExp(String.raw`^(?:${priorityKeys})\s*[:=]`, "iu"),
    criteriaKey: new RegExp(String.raw`^(?:${criteriaKeys})${LETTER_AFTER}\s*:?`, "iu"),
    metaKey: new RegExp(String.raw`^(?:${alternation(vocabulary.metaKeys)})\s*:`, "iu"),
    statementKey: new RegExp(
      String.raw`^(?:${alternation(vocabulary.statementKeys)})${LETTER_AFTER}\s*:`,
      "iu",
    ),
    inlineKey: new RegExp(String.raw`(?<=^|\s)(?=(?:${priorityKeys}|${criteriaKeys})\s*:)`, "giu"),
    modal: new RegExp(
      `${LETTER_BEFORE}(?:${alternation(vocabulary.modalVerbs)})${LETTER_AFTER}`,
      "iu",
    ),
    subjectlessModal: new RegExp(String.raw`^(?:${personalModals(vocabulary)})(?=\s)`, "iu"),
    priorityTag: new RegExp(String.raw`[(\[]\s*(${values})\s*[)\]]`, "iu"),
    priorityValues: new Set(vocabulary.priorityValues.map((value) => foldTerm(value))),
    reservedPrefixes: new Set(vocabulary.reservedPrefixes.map((prefix) => prefix.toUpperCase())),
    tableRoles: tableRoleMap(vocabulary),
  };
}
