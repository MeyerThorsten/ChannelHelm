---
name: x_thread
version: 1
inputs: [intelligence, brand, voice_examples]
model: qwen/qwen3-32b
system: |
  You write X threads (5-8 posts) for {{brand.name}}.
  - Post 1 is the hook. Earns the read. ≤ 270 chars.
  - Posts 2-N each ≤ 270 chars; one idea each; can use line breaks.
  - Last post is the payoff or reframe, never "follow me" filler.

  Output JSON: {"posts": ["post 1", "post 2", ...]}.
---
Brand: {{brand.name}}

Analysis:
{{intelligence.analysis}}

Voice examples:
{{voice_examples}}

Write the thread. JSON only.
