#!/usr/bin/env python3
"""Fail-closed surface validation for a generated or repaired chapter."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path


if os.name == "nt":
    sys.stdout.reconfigure(encoding="utf-8")


class OutputError(ValueError):
    pass


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


def cjk_stream(text: str) -> str:
    return "".join(re.findall(r"[\u3400-\u9fff]", text))


def packet_range(packet: str) -> tuple[int, int]:
    matches = re.findall(r"(?<!\d)(\d+)\s*[–—-]\s*(\d+)\s*汉字", packet)
    if len(matches) != 1:
        raise OutputError(f"执行包必须且只能有一个汉字范围，实际 {len(matches)} 个")
    lower, upper = map(int, matches[0])
    if lower <= 0 or upper < lower:
        raise OutputError(f"非法汉字范围：{lower}–{upper}")
    return lower, upper


def normalize_ascii_dialogue_quotes(text: str) -> str:
    normalized = re.sub(r'"([^"\n]+)"', lambda match: f"“{match.group(1)}”", text)
    if '"' in normalized:
        raise OutputError("正文含无法安全配对的 ASCII 双引号")
    return normalized


def shared_sequences(source: str, output: str, width: int) -> list[str]:
    source_cjk = cjk_stream(source)
    output_cjk = cjk_stream(output)
    matches: list[str] = []
    seen: set[str] = set()
    for index in range(max(0, len(source_cjk) - width + 1)):
        candidate = source_cjk[index : index + width]
        if candidate in output_cjk and candidate not in seen:
            seen.add(candidate)
            matches.append(candidate)
    return matches


def validate(packet: str, output: str, source: str | None = None, overlap_width: int = 8) -> dict:
    lower, upper = packet_range(packet)
    cjk_count = len(cjk_stream(output))
    errors: list[str] = []
    h1_count = len(re.findall(r"(?m)^#\s+\S", output))
    if h1_count != 1:
        errors.append(f"一级标题数量必须为 1，实际 {h1_count}")
    if not (lower <= cjk_count <= upper):
        errors.append(f"汉字数 {cjk_count} 不在 {lower}–{upper} 范围")
    if '"' in output:
        errors.append("正文含 ASCII 双引号")
    shared_matches: list[str] = []
    if source is not None:
        shared_matches = shared_sequences(source, output, overlap_width)
        if shared_matches:
            errors.append(
                f"正文复用参考连续 {overlap_width} 汉字："
                + "、".join(shared_matches)
            )
    return {
        "valid": not errors,
        "cjk_count": cjk_count,
        "lower": lower,
        "upper": upper,
        "h1_count": h1_count,
        "shared_sequence": shared_matches[0] if shared_matches else None,
        "shared_sequences": shared_matches,
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--packet", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--overlap-width", type=int, default=8)
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--normalize-ascii-quotes", action="store_true")
    args = parser.parse_args()
    try:
        packet_text = read(args.packet)
        output_text = read(args.output)
        if args.normalize_ascii_quotes:
            output_text = normalize_ascii_dialogue_quotes(output_text)
            args.output.write_text(output_text, encoding="utf-8")
        result = validate(
            packet_text,
            output_text,
            read(args.source) if args.source else None,
            args.overlap_width,
        )
    except (OSError, OutputError) as exc:
        result = {"valid": False, "errors": [str(exc)]}
    payload = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(payload, encoding="utf-8")
    print(payload, end="")
    return 0 if result["valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
