import type { JobState, ProcessingKind } from "../../domain/job";

export type QueueStatusTone = "neutral" | "working" | "success" | "danger";

export type QueueStatusPresentation = {
  icon: string;
  label: string;
  tone: QueueStatusTone;
};

const statusByKind: Record<JobState["kind"], QueueStatusPresentation> = {
  queued: { label: "待處理", icon: "○", tone: "neutral" },
  analyzing: { label: "分析中", icon: "…", tone: "working" },
  losslessRemux: { label: "無損封裝", icon: "↻", tone: "working" },
  losslessAudio: { label: "無損音訊轉換", icon: "↻", tone: "working" },
  transcoding: { label: "重新編碼", icon: "↻", tone: "working" },
  completed: { label: "已完成", icon: "✓", tone: "success" },
  cancelled: { label: "已取消", icon: "×", tone: "neutral" },
  failed: { label: "失敗", icon: "!", tone: "danger" },
};

const processingLabels: Record<ProcessingKind["kind"], string> = {
  losslessRemux: "無損封裝",
  losslessAudio: "無損音訊轉換",
  transcoding: "重新編碼",
};

export function queueStatusFor(state: JobState): QueueStatusPresentation {
  return statusByKind[state.kind];
}

export function processingKindVisibleLabel(kind: ProcessingKind | null): string {
  return kind ? processingLabels[kind.kind] : "尚未判定";
}

export function canCancelJob(kind: JobState["kind"]): boolean {
  return ["queued", "losslessRemux", "losslessAudio", "transcoding"].includes(kind);
}

export function canRetryJob(kind: JobState["kind"]): boolean {
  return kind === "failed";
}

export function canOpenOutput(kind: JobState["kind"]): boolean {
  return kind === "completed";
}

export function canReorderJob(kind: JobState["kind"]): boolean {
  return kind === "queued";
}
