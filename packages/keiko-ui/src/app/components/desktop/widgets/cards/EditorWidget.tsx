"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

import type { EditorRuntimeWidgetProps } from "./EditorRuntimeWidget";

const EditorRuntimeWidget = dynamic<EditorRuntimeWidgetProps>(
  () => import("./EditorRuntimeWidget"),
  {
    ssr: false,
    loading: () => <div className="ed-host-loading" aria-hidden="true" />,
  },
);

export type EditorWidgetProps = EditorRuntimeWidgetProps;

export function EditorWidget(props: EditorWidgetProps): ReactNode {
  return <EditorRuntimeWidget {...props} />;
}
