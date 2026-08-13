#!/usr/bin/env python3
"""Fail-closed validation for an outline lifecycle sidecar."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


ID_PATTERNS = {
    "object": re.compile(r"^OBJ-\d{2,}$"),
    "character": re.compile(r"^CHR-\d{2,}$"),
    "emotion": re.compile(r"^EMO-\d{2,}$"),
    "signal": re.compile(r"^SIG-\d{2,}$"),
}
CHAPTER_PATTERN = re.compile(r"^(?:00|0[1-9]|[1-9]\d)$")


class ContractError(ValueError):
    pass


def load_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ContractError(f"cannot read lifecycle JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ContractError("lifecycle contract must be a JSON object")
    return value


def require_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{field} must be a non-empty string")
    return value.strip()


def validate_contract(
    contract: dict,
    outline_text: str,
    required_labels: list[str],
    required_ids: list[str] | None = None,
) -> dict:
    version = contract.get("version")
    if version != 1:
        raise ContractError("version must equal 1")
    require_text(contract.get("story_id"), "story_id")
    entities = contract.get("entities")
    if not isinstance(entities, list) or not entities:
        raise ContractError("entities must be a non-empty array")

    seen_ids: set[str] = set()
    seen_labels: list[str] = []
    transition_count = 0

    for entity_index, entity in enumerate(entities):
        prefix = f"entities[{entity_index}]"
        if not isinstance(entity, dict):
            raise ContractError(f"{prefix} must be an object")
        entity_id = require_text(entity.get("id"), f"{prefix}.id")
        kind = require_text(entity.get("kind"), f"{prefix}.kind")
        label = require_text(entity.get("label"), f"{prefix}.label")
        initial = require_text(entity.get("initial_state"), f"{prefix}.initial_state")
        final = require_text(entity.get("final_state"), f"{prefix}.final_state")
        if kind not in ID_PATTERNS:
            raise ContractError(f"{prefix}.kind is unsupported: {kind}")
        if "/" in label or "／" in label:
            raise ContractError(
                f"{prefix}.label combines multiple entities with a slash: {label}"
            )
        if not ID_PATTERNS[kind].fullmatch(entity_id):
            raise ContractError(f"{prefix}.id does not match kind {kind}: {entity_id}")
        if entity_id in seen_ids:
            raise ContractError(f"duplicate lifecycle id: {entity_id}")
        seen_ids.add(entity_id)
        seen_labels.append(label)
        if entity_id not in outline_text:
            raise ContractError(f"outline does not reference lifecycle id: {entity_id}")
        transitions = entity.get("transitions")
        if not isinstance(transitions, list) or not transitions:
            raise ContractError(f"{prefix}.transitions must be a non-empty array")
        expected_before = initial
        for transition_index, transition in enumerate(transitions, start=1):
            item_prefix = f"{prefix}.transitions[{transition_index - 1}]"
            if not isinstance(transition, dict):
                raise ContractError(f"{item_prefix} must be an object")
            if transition.get("order") != transition_index:
                raise ContractError(
                    f"{item_prefix}.order must be contiguous and equal {transition_index}"
                )
            chapter = require_text(transition.get("chapter"), f"{item_prefix}.chapter")
            require_text(transition.get("scene"), f"{item_prefix}.scene")
            require_text(transition.get("trigger"), f"{item_prefix}.trigger")
            before = require_text(transition.get("before"), f"{item_prefix}.before")
            after = require_text(transition.get("after"), f"{item_prefix}.after")
            terminal = transition.get("terminal")
            if not CHAPTER_PATTERN.fullmatch(chapter):
                raise ContractError(
                    f"{item_prefix}.chapter must be 00 for a cold open "
                    "or use two-digit 01-99 numbering"
                )
            if before != expected_before:
                raise ContractError(
                    f"{entity_id} state gap at order {transition_index}: "
                    f"expected before={expected_before!r}, got {before!r}"
                )
            if before == after:
                raise ContractError(
                    f"{entity_id} transition {transition_index} does not change state"
                )
            is_last = transition_index == len(transitions)
            if terminal is not is_last:
                raise ContractError(
                    f"{entity_id} terminal must be false before the last transition "
                    "and true on the last transition"
                )
            expected_before = after
            transition_count += 1
        if expected_before != final:
            raise ContractError(
                f"{entity_id} final_state mismatch: expected {expected_before!r}, "
                f"got {final!r}"
            )

    missing_labels = [
        required
        for required in required_labels
        if not any(required in label for label in seen_labels)
    ]
    if missing_labels:
        raise ContractError(
            "missing required lifecycle labels: " + ", ".join(missing_labels)
        )
    missing_ids = sorted(set(required_ids or []) - seen_ids)
    if missing_ids:
        raise ContractError(
            "missing required lifecycle ids: " + ", ".join(missing_ids)
        )

    return {
        "status": "pass",
        "story_id": contract["story_id"],
        "entity_count": len(entities),
        "transition_count": transition_count,
        "ids": sorted(seen_ids),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--outline", type=Path, required=True)
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--required-label", action="append", default=[])
    parser.add_argument("--required-id", action="append", default=[])
    args = parser.parse_args()
    try:
        outline_text = args.outline.read_text(encoding="utf-8-sig")
        result = validate_contract(
            load_json(args.contract),
            outline_text,
            args.required_label,
            args.required_id,
        )
    except (OSError, ContractError) as exc:
        print(json.dumps({"status": "fail", "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
