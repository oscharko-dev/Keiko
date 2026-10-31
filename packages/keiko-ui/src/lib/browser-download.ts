"use client";

// Some browser engines cancel a programmatic Blob download when the object URL is revoked in the
// same task as the synthetic click, so it is released a moment later.
const DOWNLOAD_URL_REVOKE_DELAY_MS = 250;

export interface TextDownload {
  readonly content: string;
  readonly fileName: string;
  readonly mediaType: string;
}

/** Saves text through the browser's own download path; nothing leaves the device. */
export function saveTextDownload(file: TextDownload): void {
  const url = URL.createObjectURL(
    new Blob([file.content], { type: `${file.mediaType};charset=utf-8` }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_REVOKE_DELAY_MS);
}
