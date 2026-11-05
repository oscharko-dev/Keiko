import { MAX_DOCUMENT_CONTEXT_ENTRIES } from "../chat-document-context.js";
// Both complementary indexes stay inside the canonical private Chat database.
const INDEXES = [
  { name: "chat_history_words", tokenizer: "unicode61 remove_diacritics 0" },
  { name: "chat_history_fragments", tokenizer: "trigram" },
] as const;

function indexWrites(command: "insert" | "delete", row: "new" | "old"): string {
  return INDEXES.map(({ name }) =>
    command === "insert"
      ? `INSERT INTO ${name}(rowid, content) VALUES (${row}.rowid, ${row}.content);`
      : `INSERT INTO ${name}(${name}, rowid, content) VALUES ('delete', ${row}.rowid, ${row}.content);`,
  ).join("\n");
}

export const CHAT_HISTORY_SEARCH_SCHEMA = [
  ...INDEXES.map(
    ({ name, tokenizer }) =>
      `CREATE VIRTUAL TABLE ${name} USING fts5(content, content='chat_messages', content_rowid='rowid', tokenize='${tokenizer}');
     INSERT INTO ${name}(${name}, rank) VALUES ('secure-delete', 1);
     INSERT INTO ${name}(${name}) VALUES ('rebuild');`,
  ),
  `CREATE TRIGGER chat_history_search_insert AFTER INSERT ON chat_messages
    BEGIN ${indexWrites("insert", "new")} END;`,
  `CREATE TRIGGER chat_history_search_delete AFTER DELETE ON chat_messages
    BEGIN ${indexWrites("delete", "old")} END;`,
  `CREATE TRIGGER chat_history_search_update AFTER UPDATE OF content ON chat_messages
    BEGIN ${indexWrites("delete", "old")} ${indexWrites("insert", "new")} END;`,
].join("\n");

// #4157: retain one private index over both the human draft and its untrusted attachments.
// Existing v56 installations rebuild transactionally after the additive document column exists.
const DOCUMENT_HISTORY_CONTENT = (row: string): string =>
  [
    `${row}.content`,
    ...Array.from({ length: MAX_DOCUMENT_CONTEXT_ENTRIES }, (_, index) =>
      ["displayName", "text", "truncationMarker"]
        .map(
          (field) =>
            `coalesce(json_extract(${row}.document_context_json, '$[${String(index)}].${field}'), '')`,
        )
        .join(" || char(10) || "),
    ),
  ].join(" || char(10) || ");
export const DROP_CHAT_HISTORY_SEARCH = `DROP TRIGGER chat_history_search_insert;
  DROP TRIGGER chat_history_search_delete; DROP TRIGGER chat_history_search_update;
  DROP TABLE chat_history_words; DROP TABLE chat_history_fragments;`;
export const CHAT_DOCUMENT_HISTORY_SEARCH_SCHEMA = [
  DROP_CHAT_HISTORY_SEARCH,
  `CREATE VIEW chat_history_search_source AS SELECT rowid, ${DOCUMENT_HISTORY_CONTENT("chat_messages")} AS content FROM chat_messages;`,
  ...INDEXES.map(
    ({ name, tokenizer }) =>
      `CREATE VIRTUAL TABLE ${name} USING fts5(content, content='chat_history_search_source', content_rowid='rowid', tokenize='${tokenizer}');
     INSERT INTO ${name}(${name}, rank) VALUES ('secure-delete', 1);
     INSERT INTO ${name}(${name}) VALUES ('rebuild');`,
  ),
  ...["insert", "delete", "update"].map((action) => {
    const writes = INDEXES.map(({ name }) => {
      const remove = `INSERT INTO ${name}(${name}, rowid, content) VALUES ('delete', old.rowid, ${DOCUMENT_HISTORY_CONTENT("old")});`;
      const insert = `INSERT INTO ${name}(rowid, content) VALUES (new.rowid, ${DOCUMENT_HISTORY_CONTENT("new")});`;
      if (action === "insert") return insert;
      if (action === "delete") return remove;
      return `${remove} ${insert}`;
    }).join("\n");
    return `CREATE TRIGGER chat_history_search_${action} AFTER ${action === "update" ? "UPDATE OF content, document_context_json" : action.toUpperCase()} ON chat_messages BEGIN ${writes} END;`;
  }),
].join("\n");
