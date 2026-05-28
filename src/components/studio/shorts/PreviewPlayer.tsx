'use client';

/**
 * Controlled HTML5 video player for the Shorts editor.
 *
 * Parent owns `currentTime` + `playing` as state and passes them in.
 * The component:
 *   - Syncs the underlying `<video>` element's `currentTime` / play
 *     state when the props change (but suppresses the matching
 *     `timeupdate` echo so we don't fight the parent's setState).
 *   - Emits `onTimeUpdate(t)` on each native `timeupdate` event (~4×/sec).
 *   - Clamps `currentTime` to `[trimStart, trimEnd]` and pauses at
 *     `trimEnd` so the operator hears exactly what the rendered clip
 *     will contain.
 */

import { useEffect, useRef } from 'react';

export function PreviewPlayer({
  src,
  currentTime,
  playing,
  trimStart,
  trimEnd,
  onTimeUpdate,
  onPlayingChange,
}: {
  src: string;
  /** Absolute time in source seconds. */
  currentTime: number;
  playing: boolean;
  /** Trim region in source seconds. Playback clamps to this window. */
  trimStart: number;
  trimEnd: number;
  onTimeUpdate: (t: number) => void;
  onPlayingChange: (p: boolean) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Track the last time we set currentTime programmatically so the
  // resulting `timeupdate` echo doesn't re-trigger setState in the parent.
  const syncTokenRef = useRef(0);

  // Sync prop → element when the gap is big enough to matter (>0.05s).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (Math.abs(v.currentTime - currentTime) > 0.05) {
      v.currentTime = currentTime;
      syncTokenRef.current = Date.now();
    }
  }, [currentTime]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing && v.paused) v.play().catch(() => {});
    else if (!playing && !v.paused) v.pause();
  }, [playing]);

  return (
    <video
      ref={videoRef}
      src={src}
      controls
      preload="metadata"
      style={{
        width: '100%',
        maxWidth: 360,
        aspectRatio: '9/16',
        background: 'black',
        borderRadius: 9,
      }}
      onTimeUpdate={(e) => {
        const v = e.currentTarget;
        // Pause at trim end so the operator hears exactly the rendered
        // clip. Hard-clamp to trim start when seeking before the start.
        if (v.currentTime >= trimEnd && !v.paused) {
          v.pause();
          v.currentTime = trimEnd;
        }
        if (v.currentTime < trimStart) {
          v.currentTime = trimStart;
        }
        // Suppress the echo from the just-set programmatic sync.
        if (Date.now() - syncTokenRef.current < 50) return;
        onTimeUpdate(v.currentTime);
      }}
      onPlay={() => onPlayingChange(true)}
      onPause={() => onPlayingChange(false)}
    />
  );
}
