#!/usr/bin/env python3
"""Build the minimum authoritative ledger view needed by the packet compiler.

The full ledger remains controller-side.  The language model receives current
facts and states, but not repeated prose evidence that only increases context
cost and competes with the packet output budget.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


FIELD_MAP = {
    "ordinary_facts": ("id", "text"),
    "active_states": ("id", "kind", "text", "last_confirmed_chapter"),
    "open_obligations": ("id", "kind", "text", "last_confirmed_chapter"),
    "pending_signals": ("id", "text", "last_confirmed_chapter", "payoff_condition"),
    "closed_items": (
        "source_id",
        "source_section",
        "disposition",
        "closed_chapter",
        "resolution",
    ),
}


def project_item(item: dict[str, Any], fields: tuple[str, ...]) -> dict[str, Any]:
    return {field: item[field] for field in fields if field in item}


def build_view(ledger: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(ledger.get("chapter"), dict):
        raise ValueError("ledger.chapter must be an object")
    view: dict[str, Any] = {
        "schema_version": ledger.get("schema_version"),
        "chapter": ledger["chapter"],
    }
    for section, fields in FIELD_MAP.items():
        items = ledger.get(section)
        if not isinstance(items, list):
            raise ValueError(f"ledger.{section} must be an array")
        if any(not isinstance(item, dict) for item in items):
            raise ValueError(f"ledger.{section} must contain objects")
        view[section] = [project_item(item, fields) for item in items]
    return view


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    ledger = json.loads(args.input.read_text(encoding="utf-8-sig"))
    view = build_view(ledger)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(view, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        "OK packet-ledger-view "
        + " ".join(f"{name}={len(view[name])}" for name in FIELD_MAP)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
