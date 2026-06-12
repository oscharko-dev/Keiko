// Compatibility entry point for old /local-knowledge bookmarks.
// The Local Knowledge Connector lives inside the Workspace as a singleton tool window; AppShell
// opens it from this path and normalizes the URL back to "/" after hydration.

export { KeikoDesktop as default } from "@/app/components/desktop/KeikoDesktop";
