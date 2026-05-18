"""Apple Vision OCR over a list of frame images.

CLI per §5.6. Reads --input (a JSON file containing {"frames": [{"timestamp",
"path"}, ...]}) and writes --output (JSON list of {"timestamp", "path",
"text", "blocks": [{"text", "confidence", "bbox": [x, y, w, h]}]}).

Backed by `ocrmac`, a thin wrapper around pyobjc-framework-Vision. Mac-only
by design — falling back to Tesseract would meaningfully hurt OCR quality
on overlay text and lower-thirds (the things that matter for shorts), and
this whole pipeline is Apple Silicon-only anyway.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from _lib import Stopwatch, emit_error, emit_ok, hostname, make_parser


def main() -> None:
    ap = make_parser("ocr.py", "Frame images → Apple Vision OCR JSON")
    ap.add_argument(
        "--level",
        choices=["fast", "accurate"],
        default="accurate",
        help="Vision recognition level",
    )
    args = ap.parse_args()

    sw = Stopwatch()
    try:
        from ocrmac import ocrmac  # type: ignore

        manifest = json.loads(Path(args.input).read_text(encoding="utf-8"))
        frames = manifest.get("frames") or []
        if not isinstance(frames, list):
            raise ValueError("input.frames must be a list")

        results: list[dict] = []
        for frame in frames:
            path = frame.get("path")
            timestamp = frame.get("timestamp")
            if not path or not Path(path).exists():
                results.append(
                    {"timestamp": timestamp, "path": path, "text": "", "blocks": []}
                )
                continue

            annotations = ocrmac.OCR(
                path, recognition_level=args.level
            ).recognize()
            # ocrmac returns [(text, confidence, [x, y, w, h]), ...] in normalized coords
            blocks = [
                {"text": str(text), "confidence": float(conf), "bbox": list(bbox)}
                for (text, conf, bbox) in annotations
            ]
            joined = " ".join(b["text"] for b in blocks).strip()
            results.append(
                {
                    "timestamp": timestamp,
                    "path": path,
                    "text": joined,
                    "blocks": blocks,
                }
            )

        Path(args.output).write_text(
            json.dumps({"frames": results}, ensure_ascii=False), encoding="utf-8"
        )
        non_empty = sum(1 for r in results if r["text"])
        emit_ok(
            {
                "output_path": args.output,
                "duration_ms": sw.ms(),
                "frame_count": len(results),
                "frames_with_text": non_empty,
                "level": args.level,
                "host": hostname(),
                "provider": "apple-vision",
                "model": "vision-3.0",
            }
        )
    except Exception as e:
        print(f"[ocr.py] error: {e}", file=sys.stderr)
        emit_error(
            f"{type(e).__name__}: {e}",
            {"duration_ms": sw.ms(), "host": hostname(), "provider": "apple-vision"},
        )


if __name__ == "__main__":
    main()
