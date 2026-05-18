"""Shared CLI scaffolding for the ml/ scripts.

Per §5.6 of the contract: every script writes a single JSON line to stdout
indicating completion status, durations, and any small metadata. Verbose logs
go to stderr. Exit 0 on success, exit 1 on failure.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from typing import Any


def make_parser(prog: str, description: str) -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog=prog, description=description)
    ap.add_argument("--input", required=True, help="Input file path")
    ap.add_argument("--output", required=True, help="Output file path")
    return ap


def emit_ok(extra: dict[str, Any]) -> None:
    payload = {"ok": True, **extra}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.exit(0)


def emit_error(error: str, extra: dict[str, Any] | None = None) -> None:
    payload: dict[str, Any] = {"ok": False, "error": error}
    if extra:
        payload.update(extra)
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.exit(1)


def hostname() -> str:
    return socket.gethostname()


class Stopwatch:
    """Tiny ms timer for the duration_ms envelope field."""

    def __init__(self) -> None:
        self._t0 = time.time()

    def ms(self) -> int:
        return int((time.time() - self._t0) * 1000)
