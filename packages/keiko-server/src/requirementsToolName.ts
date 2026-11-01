// Names of the local Knowledge tools the Chat catalog hosts (#4179). A leaf module: the Chat
// consumer needs the names without loading the tool, which reads the Knowledge store.

export const KNOWLEDGE_REQUIREMENTS_TOOL = "knowledge.requirements" as const;
export type KnowledgeChatToolName = typeof KNOWLEDGE_REQUIREMENTS_TOOL;
export const KNOWLEDGE_CHAT_TOOLS: readonly KnowledgeChatToolName[] = [KNOWLEDGE_REQUIREMENTS_TOOL];
