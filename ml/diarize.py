"""Speaker diarization via pyannote.audio.

CLI per §5.6. Reads --input (the same 16 kHz mono WAV that transcribe.py
consumes) and writes --output as:

    {
      "turns":    [{"start": float, "end": float, "speaker": "SPEAKER_00"}, ...],
      "speakers": int,
      "model":    "pyannote/speaker-diarization-3.1"
    }

Requires the environment variable `HF_TOKEN` to hold a HuggingFace access
token that has *already* accepted the pyannote model licenses at:
  - https://huggingface.co/pyannote/speaker-diarization-3.1
  - https://huggingface.co/pyannote/segmentation-3.0

Without that, this script emits a clean error envelope so the calling
worker can choose to continue without speaker labels (transcribe_audio
already does this).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from _lib import Stopwatch, emit_error, emit_ok, hostname, make_parser


def main() -> None:
    ap = make_parser("diarize.py", "Audio → speaker turns JSON (pyannote-audio)")
    ap.add_argument(
        "--model",
        default="pyannote/speaker-diarization-3.1",
        help="HF repo of a pyannote pipeline that supports `from_pretrained`",
    )
    ap.add_argument(
        "--min-speakers",
        type=int,
        default=None,
        help="Lower bound on detected speakers (helps when VAD is noisy)",
    )
    ap.add_argument(
        "--max-speakers",
        type=int,
        default=None,
        help="Upper bound on detected speakers",
    )
    args = ap.parse_args()

    sw = Stopwatch()
    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if not token:
        emit_error(
            "HF_TOKEN not set — diarize.py requires a HuggingFace token "
            "with pyannote/speaker-diarization-3.1 license accepted. "
            "See ml/diarize.py docstring.",
            {"duration_ms": sw.ms(), "host": hostname(), "provider": "pyannote-audio"},
        )

    try:
        # Late import — if pyannote isn't installed or fails on import we
        # still surface a JSON error envelope rather than a Python traceback
        # to stdout.
        import torch  # type: ignore
        from pyannote.audio import Pipeline  # type: ignore

        pipeline = Pipeline.from_pretrained(args.model, use_auth_token=token)
        if pipeline is None:
            raise RuntimeError(
                f"pipeline {args.model} returned None — usually means the HF token "
                "lacks access to the model. Accept the license at "
                "https://huggingface.co/" + args.model
            )

        # Apple Silicon: prefer MPS when available; fall back to CPU.
        if torch.backends.mps.is_available():
            pipeline.to(torch.device("mps"))

        kwargs: dict = {}
        if args.min_speakers is not None:
            kwargs["min_speakers"] = args.min_speakers
        if args.max_speakers is not None:
            kwargs["max_speakers"] = args.max_speakers

        result = pipeline(args.input, **kwargs)

        turns = []
        speakers = set()
        for segment, _, label in result.itertracks(yield_label=True):
            turns.append(
                {
                    "start": round(float(segment.start), 3),
                    "end": round(float(segment.end), 3),
                    "speaker": str(label),
                }
            )
            speakers.add(str(label))

        Path(args.output).write_text(
            json.dumps(
                {
                    "turns": turns,
                    "speakers": len(speakers),
                    "model": args.model,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        emit_ok(
            {
                "output_path": args.output,
                "duration_ms": sw.ms(),
                "turn_count": len(turns),
                "speaker_count": len(speakers),
                "model": args.model,
                "host": hostname(),
                "provider": "pyannote-audio",
            }
        )
    except Exception as e:
        print(f"[diarize.py] error: {e}", file=sys.stderr)
        emit_error(
            f"{type(e).__name__}: {e}",
            {"duration_ms": sw.ms(), "host": hostname(), "provider": "pyannote-audio"},
        )


if __name__ == "__main__":
    main()
