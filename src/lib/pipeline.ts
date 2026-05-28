import type { PipelineDetails, PipelineProgress } from '@/components/ui';

/**
 * Derive the 4-layer pipeline progress (audio · visual · fusion · intelligence)
 * from a package's intelligence artifacts + status. Each layer is 1 when its
 * artifact exists, 0 otherwise; while a package is still working, the first
 * incomplete layer is shown at 0.5 ("in progress") so the indicator reads as
 * live rather than stalled.
 */
export function pipelineProgress(intelligence: unknown, status: string): PipelineProgress {
  const intel = (intelligence ?? {}) as Record<string, unknown>;
  const has = (k: string) => intel[k] != null;

  const layers: PipelineProgress = {
    audio: has('transcript') ? 1 : 0,
    visual: has('frame_index') ? 1 : 0,
    fusion: has('scene_log') ? 1 : 0,
    intelligence: has('analysis') ? 1 : 0,
  };

  const working = [
    'draft',
    'ingested',
    'transcribing',
    'analyzing_visual',
    'analyzing',
    'fused',
  ].includes(status);
  if (working) {
    for (const k of ['audio', 'visual', 'fusion', 'intelligence'] as const) {
      if (layers[k] === 0) {
        layers[k] = 0.5;
        break;
      }
    }
  }
  return layers;
}

/**
 * Per-layer "what's done" / "what's coming" strings to render under each
 * Pipeline row. Read from the package's intelligence artifacts when present,
 * fall back to status-derived "preparing" hints while the worker is running.
 */
export function pipelineDetails(
  intelligence: unknown,
  status: string,
  progress: PipelineProgress,
): PipelineDetails {
  const intel = (intelligence ?? {}) as Record<string, unknown>;
  const out: PipelineDetails = {};

  // Audio — transcript word count, diarization flag when available
  const transcript = intel.transcript as
    | { text?: string; speakers?: { id: string }[]; segments?: unknown[] }
    | undefined;
  if (transcript?.text) {
    const words = transcript.text.trim().split(/\s+/).filter(Boolean).length;
    const speakers = transcript.speakers?.length ?? 0;
    out.audio = {
      produced: speakers > 0
        ? `transcript · ${words.toLocaleString()} words · ${speakers} speakers`
        : `transcript · ${words.toLocaleString()} words`,
    };
  } else if (progress.audio > 0 && progress.audio < 1) {
    out.audio = {
      preparing: status === 'ingested' ? 'queued — extracting audio' : 'transcribing (MLX Whisper)',
    };
  }

  // Visual — keyframe count + OCR coverage
  const frameIndex = intel.frame_index as
    | { frames?: { description?: string; on_screen_text_joined?: string }[]; frame_count?: number }
    | undefined;
  if (frameIndex?.frames && frameIndex.frames.length > 0) {
    const frames = frameIndex.frames;
    const ocrFrames = frames.filter((f) => f.on_screen_text_joined).length;
    // Unique descriptions = keyframes (each keyframe's description is propagated
    // forward across dense OCR rows by analyze_visual's nearest-keyframe merge).
    const uniqueDescriptions = new Set(frames.map((f) => f.description ?? '').filter(Boolean));
    const keyframeCount = uniqueDescriptions.size;
    out.visual = {
      produced: `${keyframeCount} keyframes described · OCR on ${ocrFrames}/${frames.length} frames`,
    };
  } else if (progress.visual > 0 && progress.visual < 1) {
    out.visual = { preparing: 'sampling frames + describing keyframes (mlx-vlm)' };
  } else if (progress.visual === 0) {
    out.visual = { idle: progress.audio < 1 ? 'queued — runs in parallel with audio' : 'queued' };
  }

  // Fusion — scene log window count
  const sceneLog = intel.scene_log as { windows?: unknown[] } | undefined;
  if (sceneLog?.windows) {
    out.fusion = { produced: `scene log · ${sceneLog.windows.length} windows` };
  } else if (progress.fusion > 0 && progress.fusion < 1) {
    out.fusion = { preparing: 'merging transcript + visual into scene log' };
  } else if (progress.fusion === 0) {
    out.fusion = { idle: 'needs audio + visual' };
  }

  // Intelligence — analysis summary
  const analysis = intel.analysis as
    | { topics?: unknown[]; hooks?: unknown[]; retention?: unknown }
    | undefined;
  if (analysis) {
    const bits: string[] = [];
    if (Array.isArray(analysis.topics)) bits.push(`${analysis.topics.length} topics`);
    if (Array.isArray(analysis.hooks)) bits.push(`${analysis.hooks.length} hooks`);
    if (analysis.retention) bits.push('retention');
    out.intelligence = {
      produced: bits.length > 0 ? `analysis · ${bits.join(' · ')}` : 'analysis ready',
    };
  } else if (progress.intelligence > 0 && progress.intelligence < 1) {
    out.intelligence = { preparing: 'analyzing topics, hooks, retention (LLM)' };
  } else if (progress.intelligence === 0) {
    out.intelligence = { idle: 'needs fusion' };
  }

  return out;
}

/** True when the pipeline has reached the point where per-asset generation is happening or done. */
export function pipelineReadyToGenerate(intelligence: unknown): boolean {
  const intel = (intelligence ?? {}) as Record<string, unknown>;
  return intel.analysis != null;
}

export function progressPct(p: PipelineProgress): number {
  return Math.round(((p.audio + p.visual + p.fusion + p.intelligence) / 4) * 100);
}

/** Format seconds as M:SS (or H:MM:SS). */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
