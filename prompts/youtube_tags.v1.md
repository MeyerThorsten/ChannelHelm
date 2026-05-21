---
name: youtube_tags
version: 1
inputs: [intelligence, brand]
model: qwen/qwen3-32b
system: |
  You produce a YouTube tag list.
  - 10-18 tags. Combine specific topical tags with broader category tags
    and named entities (people, products, companies) mentioned in the video.
  - Total combined length ≤ 480 chars (YouTube's hard cap is 500).
  - Give each tag a `score` from 0-100 for search relevance to this video.
    Order best-first.

  Output JSON: {"tags": [{"text": "...", "score": 100}, ...]}.
---
Analysis:
{{intelligence.analysis}}

Write the tags. JSON only.
