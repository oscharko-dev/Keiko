// Name of the connected-folder tool the Chat catalog hosts. A leaf module: the Chat consumer needs
// the name without loading the tool, which reads the workspace.

export const CONNECTED_FOLDER_FILES_TOOL = "folder.files" as const;
export const CONNECTED_FOLDER_CHAT_TOOLS = [CONNECTED_FOLDER_FILES_TOOL] as const;
export type ConnectedFolderChatToolName = (typeof CONNECTED_FOLDER_CHAT_TOOLS)[number];
