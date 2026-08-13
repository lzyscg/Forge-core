#!/usr/bin/env python3
"""Validate hard chapter constraints against writeable outline sections."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


CHAPTER_HEADING = re.compile(
    r"(?m)^## (?P<id>00|0[1-9]|[1-9]\d)｜[^\r\n]+（B\d{3}）\s*$"
)
SUBHEADING = re.compile(r"(?m)^### ")


class ConstraintError(ValueError):
    pass


def load_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConstraintError(f"cannot read chapter contract: {exc}") from exc
    if not isinstance(value, dict):
        raise ConstraintError("chapter contract must be a JSON object")
    return value


def split_chapters(outline: str) -> dict[str, str]:
    matches = list(CHAPTER_HEADING.finditer(outline))
    result: dict[str, str] = {}
    for index, match in enumerate(matches):
        chapter_id = match.group("id")
        end = matches[index + 1].start() if index + 1 < len(matches) else len(outline)
        if chapter_id in result:
            raise ConstraintError(f"duplicate chapter heading: {chapter_id}")
        result[chapter_id] = outline[match.end() : end]
    return result


def subsection(chapter: str, title: str) -> str:
    heading = re.search(rf"(?m)^### [^\r\n]*{re.escape(title)}[^\r\n]*$", chapter)
    if not heading:
        return ""
    next_heading = SUBHEADING.search(chapter, heading.end())
    end = next_heading.start() if next_heading else len(chapter)
    return chapter[heading.end() : end]


def writeable_evidence(chapter: str) -> str:
    causal = subsection(chapter, "因果与篇幅")
    knowledge = subsection(chapter, "事实与知识边界")
    selected_knowledge = "\n".join(
        line
        for line in knowledge.splitlines()
        if line.lstrip().startswith(("- 本章新证据", "- 允许推断", "- 首次揭示位置"))
    )
    return causal + "\n" + selected_knowledge


def validate(contract: dict, outline: str) -> dict:
    if contract.get("version") != 1:
        raise ConstraintError("version must equal 1")
    chapters = split_chapters(outline)
    rules = contract.get("chapters")
    if not isinstance(rules, dict) or not rules:
        raise ConstraintError("chapters must be a non-empty object")
    checked = []
    for chapter_id, rule in rules.items():
        if chapter_id not in chapters:
            raise ConstraintError(f"missing chapter in outline: {chapter_id}")
        if not isinstance(rule, dict):
            raise ConstraintError(f"chapter rule must be an object: {chapter_id}")
        evidence = writeable_evidence(chapters[chapter_id])
        if not evidence.strip():
            raise ConstraintError(
                f"chapter {chapter_id} has no causal/new-evidence sections"
            )
        required_terms = rule.get("required_terms", [])
        forbidden_terms = rule.get("forbidden_terms", [])
        if not isinstance(required_terms, list) or not all(
            isinstance(term, str) and term for term in required_terms
        ):
            raise ConstraintError(f"invalid required_terms in chapter {chapter_id}")
        if not isinstance(forbidden_terms, list) or not all(
            isinstance(term, str) and term for term in forbidden_terms
        ):
            raise ConstraintError(f"invalid forbidden_terms in chapter {chapter_id}")
        missing = [term for term in required_terms if term not in evidence]
        leaked = [term for term in forbidden_terms if term in evidence]
        if missing:
            raise ConstraintError(
                f"chapter {chapter_id} missing required terms: {', '.join(missing)}"
            )
        if leaked:
            raise ConstraintError(
                f"chapter {chapter_id} contains forbidden early terms: "
                + ", ".join(leaked)
            )
        checked.append(
            {
                "chapter": chapter_id,
                "required_count": len(required_terms),
                "forbidden_count": len(forbidden_terms),
            }
        )
    return {"status": "pass", "chapters": checked}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--outline", type=Path, required=True)
    parser.add_argument("--contract", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = validate(
            load_json(args.contract),
            args.outline.read_text(encoding="utf-8-sig"),
        )
    except (OSError, ConstraintError) as exc:
        print(json.dumps({"status": "fail", "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
