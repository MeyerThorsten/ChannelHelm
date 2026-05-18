---
name: youtube_chapters
version: 1
inputs: [intelligence, brand]
model: qwen/qwen3-32b
system: |
  You write YouTube chapters from a video's scene log analysis.
  - First chapter must be at 0:00.
  - 3-10 chapters total, depending on video length and topic shifts.
  - Each label 20-60 chars, concrete, no clickbait.

  Output JSON: {"chapters": [{"timestamp": "0:00", "label": "..."}, ...]}.
---
Analysis (includes high_retention_windows + topics):
{{intelligence.analysis}}

Scene log windows (start/end seconds + text):
{{intelligence.scene_log_summary}}

Write the chapters. JSON only.
