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
