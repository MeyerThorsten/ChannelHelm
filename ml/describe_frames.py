"""Per-frame visual descriptions via mlx-vlm.

CLI per §5.6. Reads --input (a JSON file with {"frames": [{"timestamp",
"path"}, ...]}) and writes --output as {"frames": [{"timestamp", "path",
"description"}, ...], "model": "..."}.

Uses mlx-vlm with a 4-bit Qwen2.5-VL model:
  - standard_audio_visual → mlx-community/Qwen2.5-VL-7B-Instruct-4bit (default)
  - premium_multimodal   → mlx-community/Qwen2.5-VL-32B-Instruct-4bit
  - fast_audio_only      → analyze_visual is skipped entirely (§5.5)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from _lib import Stopwatch, emit_error, emit_ok, hostname, make_parser

DEFAULT_PROMPT = (
    "Describe the visual content of this video frame in one concise sentence. "
    "Focus on what's on screen, the speaker's framing if any, and any visible "
    "text or graphics. No speculation about audio."
)


def main() -> None:
    ap = make_parser("describe_frames.py", "Frame images → mlx-vlm descriptions JSON")
    ap.add_argument(
        "--model",
        default="mlx-community/Qwen2.5-VL-7B-Instruct-4bit",
        help="HF repo of an mlx-vlm-compatible model (4-bit quant recommended)",
    )
    ap.add_argument("--max-tokens", type=int, default=120)
    ap.add_argument(
        "--prompt",
        default=DEFAULT_PROMPT,
        help="Instruction prompt to use for every frame",
    )
    args = ap.parse_args()

    sw = Stopwatch()
    try:
        from mlx_vlm import generate, load  # type: ignore
        from mlx_vlm.prompt_utils import apply_chat_template  # type: ignore
        from mlx_vlm.utils import load_config  # type: ignore

        manifest = json.loads(Path(args.input).read_text(encoding="utf-8"))
        frames = manifest.get("frames") or []
        if not isinstance(frames, list):
            raise ValueError("input.frames must be a list")

        model, processor = load(args.model)
        config = load_config(args.model)

        results: list[dict] = []
        for frame in frames:
            path = frame.get("path")
            timestamp = frame.get("timestamp")
            if not path or not Path(path).exists():
                results.append({"timestamp": timestamp, "path": path, "description": ""})
                continue

            formatted = apply_chat_template(processor, config, args.prompt, num_images=1)
            output = generate(
                model,
                processor,
                formatted,
                image=[path],
                max_tokens=args.max_tokens,
                verbose=False,
            )
            # Older mlx-vlm versions return str; newer return a GenerationResult.
            text = getattr(output, "text", None) or str(output)
            results.append(
                {
                    "timestamp": timestamp,
                    "path": path,
                    "description": text.strip(),
                }
            )

        Path(args.output).write_text(
            json.dumps(
                {"frames": results, "model": args.model, "prompt": args.prompt},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        emit_ok(
            {
                "output_path": args.output,
                "duration_ms": sw.ms(),
                "frame_count": len(results),
                "model": args.model,
                "host": hostname(),
                "provider": "mlx-vlm",
            }
        )
    except Exception as e:
        print(f"[describe_frames.py] error: {e}", file=sys.stderr)
        emit_error(
            f"{type(e).__name__}: {e}",
            {"duration_ms": sw.ms(), "host": hostname(), "provider": "mlx-vlm"},
        )


if __name__ == "__main__":
    main()
