#!/usr/bin/env python3
"""Fail closed unless a repaired chapter contains only contracted replacements."""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
from pathlib import Path


if os.name == "nt":
    sys.stdout.reconfigure(encoding="utf-8")


class ScopeError(ValueError):
    pass


def read_text(path: Path) -> str:
    text = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r'"([^"\n]+)"', lambda match: f"“{match.group(1)}”", text)
    if '"' in text:
        raise ScopeError("正文含无法安全配对的 ASCII 双引号")
    return text.rstrip("\n") + "\n"


def build_expected(before: str, contract: dict) -> str:
    if contract.get("schema_version") != "1.0":
        raise ScopeError("repair contract schema_version 必须为 1.0")
    if contract.get("mode") != "exact_replacements":
        raise ScopeError("repair contract mode 必须为 exact_replacements")
    replacements = contract.get("replacements")
    if not isinstance(replacements, list) or not replacements:
        raise ScopeError("repair contract replacements 必须是非空数组")

    expected = before
    for index, item in enumerate(replacements, start=1):
        if not isinstance(item, dict):
            raise ScopeError(f"replacement {index} 必须是对象")
        old = item.get("old")
        new = item.get("new")
        count = item.get("count", 1)
        if not isinstance(old, str) or not old:
            raise ScopeError(f"replacement {index} old 必须是非空字符串")
        if not isinstance(new, str):
            raise ScopeError(f"replacement {index} new 必须是字符串")
        if not isinstance(count, int) or count <= 0:
            raise ScopeError(f"replacement {index} count 必须是正整数")
        actual = expected.count(old)
        if actual != count:
            raise ScopeError(
                f"replacement {index} old 出现次数应为 {count}，实际 {actual}"
            )
        expected = expected.replace(old, new, count)
    return expected


def validate(before_path: Path, after_path: Path, contract_path: Path) -> dict:
    before = read_text(before_path)
    after = read_text(after_path)
    contract = json.loads(contract_path.read_text(encoding="utf-8-sig"))
    expected = build_expected(before, contract)
    valid = after == expected
    diff = []
    if not valid:
        diff = list(
            difflib.unified_diff(
                expected.splitlines(),
                after.splitlines(),
                fromfile="contract-expected",
                tofile="model-candidate",
                lineterm="",
            )
        )[:80]
    return {
        "valid": valid,
        "replacement_count": len(contract["replacements"]),
        "errors": [] if valid else ["候选稿包含合同外改动"],
        "diff": diff,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--json-out", type=Path)
    args = parser.parse_args()
    try:
        result = validate(args.before, args.after, args.contract)
    except (OSError, json.JSONDecodeError, ScopeError) as exc:
        result = {"valid": False, "replacement_count": 0, "errors": [str(exc)], "diff": []}
    rendered = json.dumps(result, ensure_ascii=False, indent=2)
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if result["valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
