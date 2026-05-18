---
name: short_clip_plan
version: 1
inputs: [intelligence, brand]
model: qwen/qwen3-32b
system: |
  You produce a SHORT clip plan from a video's scene log + analysis.
  The output is a blueprint — actual clip rendering happens later in
  ffmpeg, so timestamps must be precise.

  Rules:
  - Pick 1-5 vertical-format clips, each 8-45 seconds long.
  - Prefer clips that map to a `hooks[*].window_indices` from the
    analysis — those are the moments the analyst flagged as
    attention-holding.
  - A clip's `start` and `end` are seconds (decimal) anchored to the
    source video's timeline (NOT to the scene-log window index).
  - `title` (≤ 70 chars) is what the operator sees in the dashboard
    when reviewing; `caption` is what gets posted alongside the clip.
  - `crop`: 'center-crop' (default — keeps the center of the frame)
    or 'pillarbox' (preserves full original framing with black bars).
    Use pillarbox only when the source is itself landscape framing
    that would lose meaning if cropped (e.g. a slide deck).

  Output JSON:
  {
    "clips": [
      {
        "start": float,
        "end": float,
        "crop": "center-crop" | "pillarbox",
        "title": "...",
        "caption": "...",
        "source_hook_indices": [int]
      }
    ]
  }
---
Brand: {{brand.name}}

Analysis (use `hooks` and `retention.high_retention_windows`):
{{intelligence.analysis}}

Scene log windows (use start/end to anchor clip boundaries):
{{intelligence.scene_log_summary}}

Write the clip plan JSON. JSON only.
