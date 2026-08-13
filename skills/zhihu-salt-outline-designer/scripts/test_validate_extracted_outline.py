from __future__ import annotations

import unittest
from pathlib import Path

from validate_extracted_outline import (
    CHAPTER_SECTIONS,
    GLOBAL_HEADINGS,
    OutlineError,
    REQUIRED_FIELDS,
    validate,
)
from validate_outline_chapter_constraints import split_chapters
from validate_outline_lifecycle import ContractError, validate_contract


def chapter_card(seq: str, label: str, boundary: str) -> str:
    parts = [f"## {seq}｜{label}（{boundary}）"]
    for title in CHAPTER_SECTIONS:
        parts.append(f"### {title}")
        for field in REQUIRED_FIELDS[title]:
            if field == "P0":
                value = f"{boundary}-P0-1 [FACT @L1-L1] 源文事实"
            else:
                value = "无：测试用例"
            parts.append(f"- {field}：{value}")
    return "\n".join(parts)


def valid_outline() -> str:
    global_part = ["# 《测试》原文复现执行大纲", *GLOBAL_HEADINGS]
    cards = [chapter_card("00", "冷开场", "B001"), chapter_card("01", "01", "B002")]
    return "\n\n".join([*global_part, *cards])


class ExtractedOutlineValidatorTests(unittest.TestCase):
    def test_valid_contract_passes(self) -> None:
        result = validate("冷开\n01\n正文\n", valid_outline())
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["chapter_count"], 2)

    def test_missing_section_fails(self) -> None:
        broken = valid_outline().replace("### 章末钩子", "### 被改名的钩子", 1)
        with self.assertRaisesRegex(OutlineError, "section contract mismatch"):
            validate("冷开\n01\n正文\n", broken)

    def test_descriptive_public_label_is_allowed(self) -> None:
        broken = valid_outline().replace("## 01｜01（B002）", "## 01｜第一章（B002）")
        result = validate("冷开\n01\n正文\n", broken)
        self.assertEqual(result["status"], "pass")

    def test_bold_field_labels_are_allowed(self) -> None:
        bold = valid_outline().replace("- 核心目的：", "- **核心目的**：")
        result = validate("冷开\n01\n正文\n", bold)
        self.assertEqual(result["status"], "pass")

    def test_p0_without_source_evidence_fails(self) -> None:
        broken = valid_outline().replace("[FACT @L1-L1]", "[无来源]", 1)
        with self.assertRaisesRegex(OutlineError, "P0 lacks a source tag"):
            validate("冷开\n01\n正文\n", broken)

    def test_skill_and_validator_contract_stay_aligned(self) -> None:
        skill_root = Path(__file__).resolve().parent.parent
        skill = (skill_root / "SKILL.md").read_text(encoding="utf-8")
        assembly = (skill_root / "references" / "06-blueprint-assembly.md").read_text(
            encoding="utf-8"
        )
        contract = skill + "\n" + assembly
        for heading in GLOBAL_HEADINGS:
            self.assertIn(heading, contract)
        for section in CHAPTER_SECTIONS:
            self.assertIn(section, contract)
        for fields in REQUIRED_FIELDS.values():
            for field in fields:
                self.assertIn(field, contract)
        for obsolete in ("只有素材或方向", "目标故事标题", "确认这是仿写任务"):
            self.assertNotIn(obsolete, skill)

    def test_legacy_constraint_parser_accepts_new_heading(self) -> None:
        chapters = split_chapters("## 00｜冷开场（B001）\n内容\n")
        self.assertEqual(chapters, {"00": "\n内容\n"})

    def test_lifecycle_rejects_combined_entity_label(self) -> None:
        contract = {
            "version": 1,
            "story_id": "test",
            "entities": [
                {
                    "id": "SIG-01",
                    "kind": "signal",
                    "label": "攻略/招生组登门",
                    "initial_state": "未出现",
                    "final_state": "已回收",
                    "transitions": [
                        {
                            "order": 1,
                            "chapter": "01",
                            "scene": "测试",
                            "trigger": "测试",
                            "before": "未出现",
                            "after": "已回收",
                            "terminal": True,
                        }
                    ],
                }
            ],
        }
        with self.assertRaisesRegex(ContractError, "combines multiple entities"):
            validate_contract(contract, "SIG-01", [])


if __name__ == "__main__":
    unittest.main()
