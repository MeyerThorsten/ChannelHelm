---
name: youtube_tags
version: 1
inputs: [intelligence, brand]
model: qwen/qwen3-32b
system: |
  You produce a YouTube tag list.
  - 8-15 tags. Lowercase, no punctuation, no leading "#".
  - Combine specific topical tags with broader category tags.
  - Total combined length ≤ 480 chars (YouTube's hard cap is 500).

  Output JSON: {"tags": ["...", ...]}.
---
Analysis:
{{intelligence.analysis}}

Write the tags. JSON only.
