#!/usr/bin/env python3
"""Validate the stable Markdown contract of an extracted reconstruction outline."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


SOURCE_LABEL = re.compile(r"^\s*(\d{2})\s*$")
OUTLINE_CHAPTER = re.compile(
    r"(?m)^## (?P<seq>00|0[1-9]|[1-9]\d)｜(?P<label>.+?)（(?P<boundary>B\d{3})）\s*$"
)
SUBHEADING = re.compile(r"(?m)^### ")
SOURCE_TAG = re.compile(
    r"\[(?:FACT|OBS|INFER|PRIVATE|REPAIR)\s+@L\d+(?:-L?\d+|(?:,L?\d+)+)?\]"
)

GLOBAL_HEADINGS = [
    "## 提取基准与章节边界",
    "## 一句话主线",
    "## 叙述契约",
    "## 主题与价值冲突",
    "## 叙事指纹",
    "## 原文事实冲突与处理决定",
    "## 源文功能覆盖总表",
    "## 全局信息揭示表",
    "## 全局生命周期调度",
    "## 分章执行卡",
    "## 主要人物与关系状态",
    "## 伏笔与回收",
    "## 复现门禁报告",
]

CHAPTER_SECTIONS = [
    "章节目的与退出状态",
    "事实与知识边界",
    "因果与篇幅",
    "情绪执行与读者压力",
    "声音、判断与对白",
    "场景连续性与生命周期",
    "章末钩子",
]

REQUIRED_FIELDS = {
    "章节目的与退出状态": ["核心目的", "P0", "退出状态"],
    "事实与知识边界": [
        "章首已知",
        "本章新证据",
        "风险假设",
        "允许推断",
        "禁止结论",
        "首次揭示",
    ],
    "因果与篇幅": ["因果链", "功能篇幅", "细写时刻", "压缩信息"],
    "情绪执行与读者压力": ["人物情绪链", "读者压力链", "情绪收据"],
    "声音、判断与对白": ["必须落地的叙述判断", "对白链", "语言呼吸"],
    "场景连续性与生命周期": ["场景连续性", "生命周期引用"],
    "章末钩子": ["钩子与下章驱动"],
}


class OutlineError(ValueError):
    pass


def source_labels(source: str) -> list[str]:
    return [match.group(1) for line in source.splitlines() if (match := SOURCE_LABEL.fullmatch(line))]


def split_sections(chapter: str) -> dict[str, str]:
    matches = list(re.finditer(r"(?m)^### (?P<title>[^\r\n]+)\s*$", chapter))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(chapter)
        sections[match.group("title")] = chapter[match.end() : end]
    return sections


def require_field(body: str, field: str, chapter_id: str) -> None:
    match = re.search(
        rf"(?m)^- (?:\*\*)?{re.escape(field)}(?:\*\*)?：(?P<value>.*)$",
        body,
    )
    if not match:
        raise OutlineError(f"chapter {chapter_id} missing field: {field}")
    if not match.group("value").strip():
        raise OutlineError(f"chapter {chapter_id} has empty field: {field}")


def validate(source: str, outline: str) -> dict:
    for heading in GLOBAL_HEADINGS:
        if heading not in outline:
            raise OutlineError(f"missing global heading: {heading}")

    matches = list(OUTLINE_CHAPTER.finditer(outline))
    if not matches:
        raise OutlineError("no chapter execution cards found")

    labels = source_labels(source)
    expected_count = len(labels) + 1
    if len(matches) != expected_count:
        raise OutlineError(
            f"chapter count mismatch: expected {expected_count}, found {len(matches)}"
        )

    expected_seqs = [f"{index:02d}" for index in range(expected_count)]
    actual_seqs = [match.group("seq") for match in matches]
    if actual_seqs != expected_seqs:
        raise OutlineError(f"chapter sequence mismatch: {actual_seqs}")

    expected_boundaries = [f"B{index + 1:03d}" for index in range(expected_count)]
    actual_boundaries = [match.group("boundary") for match in matches]
    if actual_boundaries != expected_boundaries:
        raise OutlineError(f"boundary sequence mismatch: {actual_boundaries}")

    if matches[0].group("label") != "冷开场":
        raise OutlineError("chapter 00 must be labeled 冷开场")

    checked: list[dict[str, object]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else outline.find(
            "## 主要人物与关系状态", match.end()
        )
        if end < 0:
            end = len(outline)
        chapter_id = match.group("seq")
        chapter = outline[match.end() : end]
        sections = split_sections(chapter)
        if list(sections) != CHAPTER_SECTIONS:
            raise OutlineError(
                f"chapter {chapter_id} section contract mismatch: {list(sections)}"
            )
        for title, fields in REQUIRED_FIELDS.items():
            body = sections[title]
            for field in fields:
                require_field(body, field, chapter_id)
        p0 = sections["章节目的与退出状态"]
        if not SOURCE_TAG.search(p0):
            raise OutlineError(f"chapter {chapter_id} P0 lacks a source tag")
        if not re.search(r"\[(?:FACT|OBS)\s+@L", p0):
            raise OutlineError(f"chapter {chapter_id} P0 lacks FACT/OBS evidence")
        if "同上" in chapter:
            raise OutlineError(f"chapter {chapter_id} uses forbidden shorthand: 同上")
        checked.append(
            {
                "chapter": chapter_id,
                "label": match.group("label"),
                "sections": len(sections),
                "source_tags": len(SOURCE_TAG.findall(chapter)),
            }
        )

    return {"status": "pass", "chapter_count": len(matches), "chapters": checked}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--outline", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = validate(
            args.source.read_text(encoding="utf-8-sig"),
            args.outline.read_text(encoding="utf-8-sig"),
        )
    except (OSError, OutlineError) as exc:
        print(json.dumps({"status": "fail", "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
