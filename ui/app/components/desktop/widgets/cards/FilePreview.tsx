"use client";

import type { ReactNode } from "react";
import { Icons } from "../../Icons";
import { FileIcon } from "../shared/projectTree";
import { fileContent } from "./shared/fileContent";
import { highlightLines, langOf } from "./shared/syntaxHighlight";

interface FilePreviewProps {
  name: string;
  onClose: () => void;
}

export function FilePreview({ name, onClose }: FilePreviewProps): ReactNode {
  const lang = langOf(name);
  const lines = highlightLines(fileContent(name), lang);
  return (
    <div className="fpv">
      <div className="fpv-bar">
        <button
          className="fpv-back"
          type="button"
          onClick={onClose}
          title="Back to files"
          aria-label="Back to files"
        >
          <Icons.back size={15} />
        </button>
        <FileIcon name={name} />
        <span className="fpv-name">{name}</span>
        <span className="fpv-lang mono">{lang}</span>
        <span className="spacer" />
        <button
          className="fpv-back"
          type="button"
          onClick={onClose}
          title="Close preview"
          aria-label="Close preview"
        >
          <Icons.close size={15} />
        </button>
      </div>
      <div className="fpv-code mono">
        {lines.map((toks, i) => (
          <div className="fpv-line" key={i}>
            <span className="fpv-num">{i + 1}</span>
            <span className="fpv-src">
              {toks.map((t, j) => (
                <span key={j} className={`hl-${t[0]}`}>
                  {t[1]}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
