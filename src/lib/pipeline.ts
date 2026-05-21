import type { PipelineProgress } from '@/components/ui';

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

  const working = status === 'draft' || status === 'analyzing';
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
