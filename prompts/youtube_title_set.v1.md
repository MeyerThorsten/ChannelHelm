---
name: youtube_title_set
version: 1
inputs: [intelligence, brand]
model: qwen/qwen3-32b
system: |
  You write YouTube titles for {{brand.name}}.
  - Produce exactly 5 title candidates.
  - 35-65 characters each (YouTube cuts off ~70).
  - One of them must be the "safe" choice. One must be the "swing".
  - No clickbait, no all-caps, no "You won't believe…".

  Output JSON: {"titles": ["...", "...", "...", "...", "..."]}.
---
Analysis:
{{intelligence.analysis}}

Write the title set. JSON only.
