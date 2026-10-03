"use client";

import { createWindowChunkFallback } from "../WindowChunkFallback";

// Nested editor chunks need the same bounded, observable recovery as their containing window.
// Each mount receives its own lifecycle correlation from the existing shared stage tracker.
const EditorSurfaceLoading = createWindowChunkFallback("editor widget chunk");
export default EditorSurfaceLoading;
