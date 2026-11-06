// Names of the local Knowledge tools the Chat catalog hosts (#4179). A leaf module: the Chat
// consumer needs the names without loading the tool, which reads the Knowledge store.

export const KNOWLEDGE_REQUIREMENTS_TOOL = "knowledge.requirements" as const;
export const KNOWLEDGE_DOCUMENTS_TOOL = "knowledge.documents" as const;
export const KNOWLEDGE_REVIEW_TOOL = "knowledge.review" as const;
export const KNOWLEDGE_CHAT_TOOLS = [
  KNOWLEDGE_REQUIREMENTS_TOOL,
  KNOWLEDGE_DOCUMENTS_TOOL,
  KNOWLEDGE_REVIEW_TOOL,
] as const;
export type KnowledgeChatToolName = (typeof KNOWLEDGE_CHAT_TOOLS)[number];
