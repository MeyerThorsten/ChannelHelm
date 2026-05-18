"""Transcribe an audio file with MLX Whisper.

CLI per §5.6. Reads --input (an audio file readable by ffmpeg, typically the
16 kHz mono WAV produced by the ingest worker), writes the full Whisper
result JSON to --output, and emits a status envelope on stdout.

Usage:
    uv run python transcribe.py \
        --input  /path/to/audio.wav \
        --output /path/to/transcript.json \
        --model  mlx-community/whisper-large-v3-mlx \
        --language auto
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from _lib import Stopwatch, emit_error, emit_ok, hostname, make_parser


def main() -> None:
    ap = make_parser("transcribe.py", "Audio → transcript JSON (MLX Whisper)")
    ap.add_argument(
        "--model",
        default="mlx-community/whisper-large-v3-mlx",
        help="HF repo / local path passed to mlx_whisper.transcribe",
    )
    ap.add_argument(
        "--language",
        default=None,
        help="ISO-639-1 code, or omit / pass 'auto' for auto-detection",
    )
    args = ap.parse_args()

    sw = Stopwatch()
    try:
        # Late import so the JSON error envelope still fires if mlx_whisper
        # itself failed to import (missing brew install, wrong arch, etc.).
        import mlx_whisper  # type: ignore

        language = None if not args.language or args.language == "auto" else args.language

        # mlx_whisper.transcribe writes nothing to stdout/stderr we care about,
        # but its underlying ffmpeg invocation can be chatty — let it go to
        # stderr where the Node wrapper logs it.
        result = mlx_whisper.transcribe(
            args.input,
            path_or_hf_repo=args.model,
            language=language,
            word_timestamps=True,
        )

        Path(args.output).write_text(
            json.dumps(result, ensure_ascii=False), encoding="utf-8"
        )

        emit_ok(
            {
                "output_path": args.output,
                "duration_ms": sw.ms(),
                "model": args.model,
                "language": result.get("language"),
                "segment_count": len(result.get("segments") or []),
                "text_length": len((result.get("text") or "").strip()),
                "host": hostname(),
                "provider": "mlx-whisper",
            }
        )
    except Exception as e:
        print(f"[transcribe.py] error: {e}", file=sys.stderr)
        emit_error(
            f"{type(e).__name__}: {e}",
            {"duration_ms": sw.ms(), "host": hostname(), "provider": "mlx-whisper"},
        )


if __name__ == "__main__":
    main()
