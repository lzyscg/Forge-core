#!/usr/bin/env python3
"""Fail-closed artifacts for the Zhihu Salt chapter controller.

The script intentionally uses only the Python standard library.  It extracts
source chapter boundaries, validates a blueprint against those boundaries, and
accepts packet/audit/ledger output only when Markdown and a JSON sidecar agree.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
SCHEMA_DIR = SCRIPT_DIR.parent / "references" / "schemas"
MARKDOWN_MARKER = "<<<ZH-SALT-MARKDOWN>>>"
SIDECAR_MARKER = "<<<ZH-SALT-SIDECAR>>>"
END_MARKER = "<<<ZH-SALT-END>>>"

if os.name == "nt":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


class ArtifactError(ValueError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_markdown(text: str) -> str:
    return text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").strip() + "\n"


def read_source(path: Path) -> tuple[str, str]:
    data = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    raise ArtifactError(f"无法识别文本编码：{path}")


def normalize_digits(value: str) -> str:
    return value.translate(str.maketrans("０１２３４５６７８９", "0123456789"))


def chapter_marker(text: str) -> str | None:
    value = text.strip()
    if not value:
        return None
    normalized = normalize_digits(value)
    if re.fullmatch(r"\d{1,3}(?:[.．、])?(?:\s+(?:尾声|番外|后记|终章))?", normalized):
        return value
    if re.fullmatch(r"第[一二三四五六七八九十百零〇两\d]{1,8}[章节回](?:[：:].*)?", normalized):
        return value
    if re.fullmatch(r"(?:序章|楔子|尾声|后记|终章|番外(?:[一二三四五六七八九十百零〇两\d]+)?)", normalized):
        return value
    return None


def nonempty_bounds(lines: list[str], start: int, end: int) -> tuple[int, int]:
    while start <= end and not lines[start - 1].strip():
        start += 1
    while end >= start and not lines[end - 1].strip():
        end -= 1
    if start > end:
        raise ArtifactError(f"章节范围 {start}-{end} 没有正文")
    return start, end


def line_offsets(lines: list[str]) -> list[int]:
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line) + 1)
    return offsets


def anchor(text: str) -> str:
    compact = re.sub(r"\s+", " ", text.strip())
    return compact[:200]


def extract_boundary_map(source_path: Path) -> dict[str, Any]:
    text, encoding = read_source(source_path)
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.split("\n")
    if lines and lines[-1] == "":
        lines = lines[:-1]
    if not lines:
        raise ArtifactError("源文本为空")

    markers: list[tuple[int, str]] = []
    for index, line in enumerate(lines, start=1):
        label = chapter_marker(line)
        if label is not None:
            markers.append((index, label))

    raw_ranges: list[tuple[int | None, str | None, int, int]] = []
    first_nonempty = next((i for i, line in enumerate(lines, start=1) if line.strip()), None)
    if first_nonempty is None:
        raise ArtifactError("源文本只有空白")

    if not markers:
        start, end = nonempty_bounds(lines, first_nonempty, len(lines))
        raw_ranges.append((None, None, start, end))
    else:
        first_marker_line = markers[0][0]
        if first_nonempty < first_marker_line:
            start, end = nonempty_bounds(lines, first_nonempty, first_marker_line - 1)
            raw_ranges.append((None, None, start, end))
        for marker_index, (heading_line, label) in enumerate(markers):
            next_heading = markers[marker_index + 1][0] if marker_index + 1 < len(markers) else len(lines) + 1
            start, end = nonempty_bounds(lines, heading_line + 1, next_heading - 1)
            raw_ranges.append((heading_line, label, start, end))

    has_cold = raw_ranges[0][0] is None and raw_ranges[0][1] is None and bool(markers)
    offsets = line_offsets(lines)
    chapters: list[dict[str, Any]] = []
    for ordinal, (heading_line, label, start, end) in enumerate(raw_ranges):
        if has_cold:
            sequence = ordinal
        else:
            sequence = ordinal + 1
        boundary_id = f"B{sequence:03d}"
        display = "冷开场" if has_cold and ordinal == 0 else (label or "全文")
        segment = "\n".join(lines[start - 1 : end])
        segment_hash = sha256_bytes(segment.encode("utf-8"))
        payload = f"{boundary_id}|{display}|{heading_line}|{start}|{end}|{segment_hash}"
        chapters.append(
            {
                "id": boundary_id,
                "sequence": sequence,
                "display": display,
                "source_label": label,
                "heading_line": heading_line,
                "content_start_line": start,
                "content_end_line": end,
                "content_start_offset": offsets[start - 1],
                "content_end_offset": offsets[end - 1] + len(lines[end - 1]),
                "start_anchor": anchor(lines[start - 1]),
                "end_anchor": anchor(lines[end - 1]),
                "last_non_crossable_action": anchor(lines[end - 1]),
                "next_forbidden_action": None,
                "segment_sha256": segment_hash,
                "boundary_signature": sha256_bytes(payload.encode("utf-8")),
            }
        )
    for current, following in zip(chapters, chapters[1:]):
        current["next_forbidden_action"] = following["start_anchor"]

    source_bytes = source_path.read_bytes()
    return {
        "$schema": "https://openai.local/zhihu-salt/chapter-boundaries.schema.json",
        "schema_version": "1.0",
        "operation": "chapter-boundary-map",
        "valid": True,
        "source": {
            "path": str(source_path.resolve()),
            "file_name": source_path.name,
            "encoding": encoding,
            "sha256": sha256_bytes(source_bytes),
            "line_count": len(lines),
            "character_count": len(normalized),
        },
        "chapters": chapters,
    }


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ArtifactError(f"无法读取 JSON {path}: {exc}") from exc


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def schema_type_matches(value: Any, expected: str) -> bool:
    return {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
        "null": value is None,
    }.get(expected, False)


def validate_schema(value: Any, schema: dict[str, Any], path: str = "$") -> list[str]:
    errors: list[str] = []
    expected_type = schema.get("type")
    if expected_type is not None:
        allowed = expected_type if isinstance(expected_type, list) else [expected_type]
        if not any(schema_type_matches(value, item) for item in allowed):
            return [f"{path}: 类型应为 {allowed}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: 必须等于 {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: 不在允许值 {schema['enum']!r} 中")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{path}: 字符串过短")
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            errors.append(f"{path}: 不匹配 {schema['pattern']!r}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: 小于最小值 {schema['minimum']}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{path}: 项目数不足")
        item_schema = schema.get("items")
        if item_schema:
            for index, item in enumerate(value):
                errors.extend(validate_schema(item, item_schema, f"{path}[{index}]"))
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: 缺少字段 {key!r}")
        properties = schema.get("properties", {})
        for key, item in value.items():
            if key in properties:
                errors.extend(validate_schema(item, properties[key], f"{path}.{key}"))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: 不允许字段 {key!r}")
    return errors


def resolve_local_schema_refs(value: Any, root: dict[str, Any]) -> Any:
    if isinstance(value, list):
        return [resolve_local_schema_refs(item, root) for item in value]
    if not isinstance(value, dict):
        return value
    if "$ref" in value:
        reference = value["$ref"]
        if not reference.startswith("#/"):
            raise ArtifactError(f"仅支持本地 schema 引用：{reference}")
        target: Any = root
        for part in reference[2:].split("/"):
            key = part.replace("~1", "/").replace("~0", "~")
            if not isinstance(target, dict) or key not in target:
                raise ArtifactError(f"schema 引用不存在：{reference}")
            target = target[key]
        merged = json.loads(json.dumps(target))
        for key, item in value.items():
            if key != "$ref":
                merged[key] = item
        return resolve_local_schema_refs(merged, root)
    return {
        key: resolve_local_schema_refs(item, root)
        for key, item in value.items()
    }


def validate_against_schema(value: Any, schema_name: str) -> None:
    schema_path = SCHEMA_DIR / schema_name
    raw_schema = load_json(schema_path)
    schema = resolve_local_schema_refs(raw_schema, raw_schema)
    errors = validate_schema(value, schema)
    if errors:
        raise ArtifactError("Schema 校验失败：\n- " + "\n- ".join(errors))


LEDGER_LIVE_SECTIONS = ("active_states", "open_obligations", "pending_signals")


def ledger_live_index(value: dict[str, Any]) -> dict[str, tuple[str, dict[str, Any]]]:
    index: dict[str, tuple[str, dict[str, Any]]] = {}
    for section in LEDGER_LIVE_SECTIONS:
        for item in value[section]:
            item_id = item["id"]
            if item_id in index:
                raise ArtifactError(f"账本活跃 ID 重复：{item_id}")
            index[item_id] = (section, item)
    return index


def validate_ledger_state(value: dict[str, Any]) -> None:
    validate_against_schema(value, "ledger-state.schema.json")
    live = ledger_live_index(value)
    fact_ids = {item["id"] for item in value["ordinary_facts"]}
    if len(fact_ids) != len(value["ordinary_facts"]):
        raise ArtifactError("账本普通事实 ID 重复")
    overlap = fact_ids.intersection(live)
    if overlap:
        raise ArtifactError("账本普通事实与活跃项 ID 冲突：" + "、".join(sorted(overlap)))
    closed_keys: set[tuple[str, str]] = set()
    for item in value["closed_items"]:
        key = (item["source_section"], item["source_id"])
        if key in closed_keys:
            raise ArtifactError(f"账本闭合记录重复：{key[0]} {key[1]}")
        closed_keys.add(key)
        if item["source_id"] in live:
            raise ArtifactError(f"账本项目同时处于活跃与闭合状态：{item['source_id']}")


def validate_ledger_transition(previous: dict[str, Any], current: dict[str, Any]) -> None:
    validate_ledger_state(previous)
    validate_ledger_state(current)
    if current["chapter"]["sequence"] <= previous["chapter"]["sequence"]:
        raise ArtifactError("新账本章节顺序没有前进")

    previous_live = ledger_live_index(previous)
    current_live = ledger_live_index(current)
    current_closed = {
        (item["source_section"], item["source_id"]): item
        for item in current["closed_items"]
    }
    missing: list[str] = []
    for item_id, (section, _) in previous_live.items():
        if item_id in current_live:
            current_section, _ = current_live[item_id]
            if current_section != section:
                raise ArtifactError(
                    f"账本项目无结算跨区移动：{item_id} {section} -> {current_section}"
                )
            continue
        closure = current_closed.get((section, item_id))
        if closure is None:
            missing.append(f"{section}:{item_id}")
            continue
        if closure["closed_chapter"] != current["chapter"]["id"]:
            raise ArtifactError(f"闭合记录章节不是当前章：{item_id}")
        allowed = {
            "active_states": {"completed", "invalidated"},
            "open_obligations": {"completed", "invalidated"},
            "pending_signals": {"paid_off", "invalidated"},
        }[section]
        if closure["disposition"] not in allowed:
            raise ArtifactError(
                f"闭合类型不适用于 {section}：{item_id} {closure['disposition']}"
            )
    if missing:
        raise ArtifactError("账本静默丢失活跃项：" + "、".join(missing))


def draft_paragraphs(markdown: str) -> list[str]:
    normalized = canonical_markdown(markdown)
    blocks = [item.strip() for item in re.split(r"\n\s*\n", normalized) if item.strip()]
    if not blocks:
        raise ArtifactError("正文为空")
    first_lines = blocks[0].splitlines()
    if first_lines[0].lstrip().startswith("#") or re.fullmatch(
        r"(?:第\s*)?\d{1,3}[.．、]?", first_lines[0].strip()
    ):
        remainder = "\n".join(first_lines[1:]).strip()
        blocks = ([remainder] if remainder else []) + blocks[1:]
    return blocks


def validate_draft_audit(
    draft: str, evidence: dict[str, Any], require_pass: bool
) -> None:
    validate_against_schema(evidence, "draft-audit-evidence.schema.json")
    canonical = canonical_markdown(draft)
    top_titles = re.findall(r"(?m)^#(?!#)\s+\S.*$", canonical)
    if len(top_titles) > 1:
        raise ArtifactError(f"正文一级标题最多为 1，实际为 {len(top_titles)}")
    if evidence["draft_sha256"] != sha256_bytes(canonical.encode("utf-8")):
        raise ArtifactError("正文哈希与审核证据不一致")
    expected_chinese = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]", canonical))
    if evidence["chinese_chars"] != expected_chinese:
        raise ArtifactError("审核证据的汉字数与正文不一致")

    paragraphs = draft_paragraphs(canonical)
    if len(evidence["paragraphs"]) != len(paragraphs):
        raise ArtifactError(
            f"段落功能归属未覆盖全文：正文 {len(paragraphs)}，证据 {len(evidence['paragraphs'])}"
        )
    seen_indices: set[int] = set()
    for item in evidence["paragraphs"]:
        index = item["index"]
        if index in seen_indices or index < 1 or index > len(paragraphs):
            raise ArtifactError(f"段落索引重复或越界：{index}")
        seen_indices.add(index)
        expected_hash = sha256_bytes(paragraphs[index - 1].encode("utf-8"))
        if item["text_sha256"] != expected_hash:
            raise ArtifactError(f"第 {index} 段哈希不一致")
    if seen_indices != set(range(1, len(paragraphs) + 1)):
        raise ArtifactError("段落功能归属存在编号缺口")

    unit_ids: set[str] = set()
    for unit in evidence["units"]:
        if unit["id"] in unit_ids:
            raise ArtifactError(f"场景单元 ID 重复：{unit['id']}")
        unit_ids.add(unit["id"])
        for field in ("trigger", "response", "feedback", "new_state"):
            for quote in unit[field]:
                if quote not in canonical:
                    raise ArtifactError(f"{unit['id']}.{field} 引用不在正文中：{quote}")
        if unit["status"] == "complete" and unit["weight"] in {"high", "standard"} and any(
            not unit[field] for field in ("trigger", "response", "feedback", "new_state")
        ):
            raise ArtifactError(f"{unit['id']} 没有提供完整闭环证据")
        if unit["status"] == "complete" and unit["weight"] == "light" and (
            not unit["trigger"] or not unit["new_state"]
        ):
            raise ArtifactError(f"{unit['id']} 轻过渡缺少触发或状态桥")
        if unit["status"] == "complete" and unit.get("repair_instruction"):
            raise ArtifactError(f"{unit['id']} 自报完整但仍携带返修指令")
        if unit["status"] != "complete" and not unit.get("repair_instruction"):
            raise ArtifactError(f"{unit['id']} 未完成但缺少安全返修指令")

    for item in evidence["direct_writes"]:
        for quote in item["evidence"]:
            if quote not in canonical:
                raise ArtifactError(f"直接写出 {item['id']} 的引用不在正文中：{quote}")

    bad_authorization = []
    for item in evidence["authorization_findings"]:
        quote = item["quote"]
        if quote not in canonical:
            raise ArtifactError(f"授权溯源引用不在正文中：{quote}")
        if item["verdict"] == "authorized" and not item["source_refs"]:
            raise ArtifactError(f"授权溯源声称已授权但没有来源：{quote}")
        if item["verdict"] == "authorized" and any(
            phrase in item.get("reason", "")
            for phrase in (
                "符合常识",
                "自然公共区域",
                "自然包含",
                "必然工具",
                "必要携带物",
                "局部闭合即可",
                "为了画面完整",
            )
        ):
            raise ArtifactError(f"授权理由使用隐含常识替代明确来源：{quote}")
        if item["verdict"] != "authorized":
            bad_authorization.append(quote)

    if require_pass:
        bad_units = [item["id"] for item in evidence["units"] if item["status"] != "complete"]
        bad_paragraphs = [
            str(item["index"])
            for item in evidence["paragraphs"]
            if item["verdict"] != "keep"
        ]
        if bad_units:
            raise ArtifactError("审核 pass 仍有未完成场景单元：" + "、".join(bad_units))
        if bad_paragraphs:
            raise ArtifactError("审核 pass 仍有无功能或待修段落：" + "、".join(bad_paragraphs))
        if bad_authorization:
            raise ArtifactError("审核 pass 仍有未解决授权项：" + "、".join(bad_authorization))


def parse_json_document(text: str) -> dict[str, Any]:
    normalized = text.lstrip("\ufeff").strip()
    fence = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", normalized, re.DOTALL)
    if fence:
        normalized = fence.group(1)
    try:
        value = json.loads(normalized)
    except json.JSONDecodeError as exc:
        raise ArtifactError(f"审核语义不是有效 JSON：{exc}") from exc
    if not isinstance(value, dict):
        raise ArtifactError("审核语义 JSON 顶层必须是对象")
    return value


def build_draft_audit_evidence(
    draft: str,
    semantics: dict[str, Any],
    chapter: dict[str, Any],
) -> dict[str, Any]:
    """Attach controller-owned identity, hashes and measurements to semantics."""
    semantics = normalize_semantic_enums(semantics)
    validate_against_schema(semantics, "draft-audit-semantics.schema.json")
    semantics = normalize_semantic_quotes(semantics, canonical_markdown(draft))
    paragraphs = draft_paragraphs(draft)
    enriched_paragraphs = []
    for item in semantics["paragraphs"]:
        index = item["index"]
        if index < 1 or index > len(paragraphs):
            raise ArtifactError(f"审核语义段落索引越界：{index}")
        enriched_paragraphs.append(
            {
                "index": index,
                "text_sha256": sha256_bytes(paragraphs[index - 1].encode("utf-8")),
                "owners": item["owners"],
                "effect": item["effect"],
                "verdict": item["verdict"],
            }
        )
    canonical = canonical_markdown(draft)
    evidence = {
        "schema_version": "1.1",
        "chapter": chapter,
        "draft_sha256": sha256_bytes(canonical.encode("utf-8")),
        "units": semantics["units"],
        "paragraphs": enriched_paragraphs,
        "direct_writes": semantics["direct_writes"],
        "authorization_findings": semantics["authorization_findings"],
        "chinese_chars": chinese_char_count(canonical),
    }
    validate_draft_audit(canonical, evidence, False)
    return evidence


def audit_sentence_records(draft: str) -> list[dict[str, Any]]:
    """Split numbered draft paragraphs into deterministic, exact sentence records."""
    records: list[dict[str, Any]] = []
    for paragraph_index, paragraph in enumerate(draft_paragraphs(draft), start=1):
        parts = [
            match.group(0).strip()
            for match in re.finditer(r".+?(?:[。！？!?]+[”’\"]?|$)", paragraph)
            if match.group(0).strip()
        ]
        if not parts:
            parts = [paragraph]
        for sentence_index, text in enumerate(parts, start=1):
            records.append(
                {
                    "id": f"P{paragraph_index:03d}-S{sentence_index:03d}",
                    "paragraph_index": paragraph_index,
                    "text": text,
                }
            )
    return records


def audit_sentence_reference_map(draft: str) -> dict[str, str]:
    return {item["id"]: item["text"] for item in audit_sentence_records(draft)}


def resolve_semantic_quote(quote: str, draft: str) -> str:
    reference_map = audit_sentence_reference_map(draft)
    if quote in reference_map:
        return reference_map[quote]
    if quote in draft:
        return quote
    candidates: list[str] = []
    if len(quote) >= 2 and quote.startswith('"') and quote.endswith('"'):
        body = quote[1:-1]
        candidates.extend((f"“{body}”", f"「{body}」"))
    matching = [candidate for candidate in candidates if candidate in draft]
    if len(matching) == 1:
        return matching[0]
    return quote


def resolve_ledger_evidence_ref(
    evidence_ref: str,
    draft: str,
    previous: dict[str, Any],
    *,
    current_only: bool = False,
) -> str:
    sentence_map = audit_sentence_reference_map(draft)
    if evidence_ref in sentence_map:
        return sentence_map[evidence_ref]
    if current_only:
        raise ArtifactError(f"新账本项目证据不是当前正文句子 ID：{evidence_ref}")
    previous_items = {
        item["id"]: item
        for section in ("ordinary_facts",) + LEDGER_LIVE_SECTIONS
        for item in previous[section]
    }
    if evidence_ref in previous_items:
        return previous_items[evidence_ref]["evidence"]
    raise ArtifactError(f"账本证据引用不存在：{evidence_ref}")


def resolve_ledger_evidence_refs(
    evidence_refs: list[str],
    draft: str,
    previous: dict[str, Any],
    *,
    current_only: bool = False,
) -> str | list[str]:
    resolved: list[str] = []
    for reference in evidence_refs:
        value = resolve_ledger_evidence_ref(
            reference, draft, previous, current_only=current_only
        )
        candidates = value if isinstance(value, list) else [value]
        for candidate in candidates:
            if candidate not in resolved:
                resolved.append(candidate)
    if not resolved:
        raise ArtifactError("账本证据引用为空")
    return resolved[0] if len(resolved) == 1 else resolved


def validate_ledger_negative_claim(text: str, evidence: str | list[str]) -> None:
    source = "".join(evidence if isinstance(evidence, list) else [evidence])
    for marker in ("尚未", "未能", "没有", "无人", "未知", "未解除", "未恢复", "无法"):
        if marker in text and marker not in source:
            raise ArtifactError(f"账本负面状态没有原句证据：{marker} in {text}")


def validate_ledger_context_negative_claims(
    semantics: dict[str, Any], draft: str, previous: dict[str, Any]
) -> None:
    """Reject high-risk negative context claims that the cited source never states."""
    for field in (
        "accessible_people",
        "narrator_knowledge",
        "narrator_inferences",
        "unresolved",
        "required_continuity",
    ):
        for assertion in semantics.get("context", {}).get(field, []):
            refs = assertion.get("evidence_refs", [])
            if not refs:
                continue
            evidence = resolve_ledger_evidence_refs(refs, draft, previous)
            source = "".join(evidence if isinstance(evidence, list) else [evidence])
            if "未结束" in assertion.get("text", "") and "未结束" not in source:
                raise ArtifactError(
                    f"账本上下文把未明状态补成未结束：{assertion['text']}"
                )


REPAIR_SCOPE_PREFIX = "<!-- allowed-json-paths:"


def parse_repair_allowed_paths(memo: str) -> list[str]:
    lines = [line.strip() for line in memo.splitlines() if line.strip().startswith(REPAIR_SCOPE_PREFIX)]
    if len(lines) != 1 or not lines[0].endswith("-->"):
        raise ArtifactError("账本返修单缺少唯一 allowed-json-paths 机器权限声明")
    payload = lines[0][len(REPAIR_SCOPE_PREFIX) : -3].strip()
    try:
        paths = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ArtifactError("账本返修单 allowed-json-paths 不是合法 JSON") from exc
    if not isinstance(paths, list) or not paths or any(
        not isinstance(path, str) or not path.startswith("$.") for path in paths
    ):
        raise ArtifactError("账本返修单 allowed-json-paths 必须是非空 JSON path 数组")
    if len(paths) != len(set(paths)):
        raise ArtifactError("账本返修单 allowed-json-paths 含重复路径")
    return paths


def semantic_diff_paths(before: Any, after: Any, path: str = "$") -> list[str]:
    if type(before) is not type(after):
        return [path]
    if isinstance(before, dict):
        paths: list[str] = []
        for key in sorted(set(before) | set(after)):
            child = f"{path}.{key}"
            if key not in before or key not in after:
                paths.append(child)
            else:
                paths.extend(semantic_diff_paths(before[key], after[key], child))
        return paths
    if isinstance(before, list):
        def id_index(items: list[Any]) -> dict[str, Any] | None:
            if not all(isinstance(item, dict) and isinstance(item.get("id"), str) for item in items):
                return None
            index = {item["id"]: item for item in items}
            return index if len(index) == len(items) else None

        before_ids, after_ids = id_index(before), id_index(after)
        if before_ids is not None and after_ids is not None:
            paths = []
            for item_id in sorted(set(before_ids) | set(after_ids)):
                child = f"{path}[id={item_id}]"
                if item_id not in before_ids or item_id not in after_ids:
                    paths.append(child)
                else:
                    paths.extend(
                        semantic_diff_paths(before_ids[item_id], after_ids[item_id], child)
                    )
            return paths
        if len(before) != len(after):
            return [path]
        paths = []
        for index, (old, new) in enumerate(zip(before, after)):
            paths.extend(semantic_diff_paths(old, new, f"{path}[{index}]"))
        return paths
    return [] if before == after else [path]


def validate_ledger_repair_scope(before: dict[str, Any], after: dict[str, Any], memo: str) -> None:
    allowed = parse_repair_allowed_paths(memo)
    changed = semantic_diff_paths(before, after)
    if not changed:
        raise ArtifactError("账本返修没有产生任何变化")
    unauthorized = [
        path
        for path in changed
        if not any(
            path == prefix or path.startswith(prefix + ".") or path.startswith(prefix + "[")
            for prefix in allowed
        )
    ]
    if unauthorized:
        raise ArtifactError("账本返修越权修改：" + "、".join(unauthorized))


def normalize_semantic_quotes(
    semantics: dict[str, Any], draft: str
) -> dict[str, Any]:
    """Normalize only uniquely matching quote-mark variants, never wording."""
    normalized = json.loads(json.dumps(semantics))
    for unit in normalized["units"]:
        for field in ("trigger", "response", "feedback", "new_state"):
            resolved = [
                resolve_semantic_quote(quote, draft) for quote in unit[field]
            ]
            if unit["status"] != "complete":
                resolved = [quote for quote in resolved if quote in draft]
            unit[field] = resolved
    for item in normalized["direct_writes"]:
        item["evidence"] = [
            resolve_semantic_quote(quote, draft) for quote in item["evidence"]
        ]
    for item in normalized["authorization_findings"]:
        item["quote"] = resolve_semantic_quote(item["quote"], draft)
    return normalized


def normalize_semantic_enums(semantics: dict[str, Any]) -> dict[str, Any]:
    """Normalize only exact, lossless aliases for audit transport enums."""
    normalized = json.loads(json.dumps(semantics))
    category_aliases = {
        "action": "appearance_action",
        "appearance": "appearance_action",
        "time": "time_number",
        "number": "time_number",
        "location": "location_route",
        "route": "location_route",
        "cause": "cause_motive",
        "motive": "cause_motive",
        "knowledge": "knowledge_conclusion",
        "backstory": "backstory_habit",
        "habit": "backstory_habit",
    }
    for item in normalized.get("authorization_findings", []):
        category = item.get("category")
        if category in category_aliases:
            item["category"] = category_aliases[category]
    return normalized


def normalize_heading(value: str) -> str:
    value = value.strip().strip("`").strip()
    return re.sub(r"\s+", " ", value)


def blueprint_headings(path: Path) -> list[tuple[int, str]]:
    text = path.read_text(encoding="utf-8-sig")
    headings: list[tuple[int, str]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        match = re.match(r"^#{2,3}\s+(.+?)\s*$", line)
        if match:
            headings.append((line_number, normalize_heading(match.group(1))))
    return headings


def heading_matches(boundary: dict[str, Any], heading: str) -> bool:
    boundary_tag = f"[{boundary['id']}]"
    if heading.startswith(boundary_tag):
        return normalize_heading(heading[len(boundary_tag) :]) == boundary["display"]
    if boundary["source_label"] is None:
        return heading in {"冷开场", "冷开场（数字编号前）", "导语", "全文"}
    return heading == boundary["display"]


def validate_blueprint(boundaries: dict[str, Any], path: Path) -> None:
    headings = blueprint_headings(path)
    cursor = 0
    matched: list[tuple[str, int]] = []
    for boundary in boundaries["chapters"]:
        found = None
        for index in range(cursor, len(headings)):
            if heading_matches(boundary, headings[index][1]):
                found = index
                break
        if found is None:
            raise ArtifactError(
                f"蓝图缺少或错序章节：{boundary['id']} {boundary['display']}。"
                "可使用“## [边界 ID] 原标签”消除重复标签歧义。"
            )
        matched.append((boundary["id"], headings[found][0]))
        cursor = found + 1
    if len({item[1] for item in matched}) != len(matched):
        raise ArtifactError("多个源章节映射到了同一个蓝图标题")


def comparable_boundary_map(value: dict[str, Any]) -> dict[str, Any]:
    copied = json.loads(json.dumps(value))
    copied["source"].pop("path", None)
    return copied


def validate_boundary_map(source: Path, boundary_path: Path, blueprint: Path | None) -> dict[str, Any]:
    value = load_json(boundary_path)
    validate_against_schema(value, "chapter-boundaries.schema.json")
    expected = extract_boundary_map(source)
    if comparable_boundary_map(value) != comparable_boundary_map(expected):
        raise ArtifactError("边界 sidecar 与当前源文件机械提取结果不一致")
    if blueprint is not None:
        validate_blueprint(value, blueprint)
    return value


def find_boundary(boundaries: dict[str, Any], boundary_id: str) -> dict[str, Any]:
    matches = [item for item in boundaries["chapters"] if item["id"] == boundary_id]
    if len(matches) != 1:
        raise ArtifactError(f"边界 ID 不存在或不唯一：{boundary_id}")
    return matches[0]


def parse_envelope(text: str) -> tuple[str, dict[str, Any]]:
    normalized = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    if not normalized.startswith(MARKDOWN_MARKER + "\n"):
        raise ArtifactError("输出缺少结构化 Markdown 起始标记")
    sidecar_token = "\n" + SIDECAR_MARKER + "\n"
    end_token = "\n" + END_MARKER
    if normalized.count(sidecar_token) != 1 or normalized.count(end_token) != 1:
        raise ArtifactError("输出标记数量错误")
    markdown_part, remainder = normalized[len(MARKDOWN_MARKER) + 1 :].split(sidecar_token, 1)
    json_part, trailing = remainder.split(end_token, 1)
    if trailing.strip():
        raise ArtifactError("结构化输出结束标记后仍有说明文字")
    markdown = canonical_markdown(markdown_part)
    try:
        sidecar = json.loads(json_part.strip())
    except json.JSONDecodeError as exc:
        raise ArtifactError(f"sidecar 不是有效 JSON：{exc}") from exc
    sidecar["markdown_sha256"] = sha256_bytes(markdown.encode("utf-8"))
    return markdown, sidecar


def parse_packet_markdown_envelope(text: str) -> str:
    """Parse a packet-only envelope whose deterministic sidecar is controller-owned."""
    normalized = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    prefix = MARKDOWN_MARKER + "\n"
    end_token = "\n" + END_MARKER
    if not normalized.startswith(prefix):
        raise ArtifactError("packet-only 缺少 Markdown 起始标记")
    body = normalized[len(prefix) :]
    if end_token in body:
        if body.count(end_token) != 1:
            raise ArtifactError("packet-only 结束标记数量错误")
        markdown_part, trailing = body.split(end_token, 1)
        if trailing.strip():
            raise ArtifactError("packet-only 结束标记后仍有说明文字")
    else:
        markdown_part = body
        last_nonempty = next(
            (line.strip() for line in reversed(markdown_part.splitlines()) if line.strip()),
            "",
        )
        if re.fullmatch(r"<<<[A-Z_-]*ZH-SALT[A-Z_-]*>>>", last_nonempty):
            lines = markdown_part.rstrip().splitlines()
            markdown_part = "\n".join(lines[:-1])
        if re.search(r"(?m)^<<<[A-Z_-]*ZH-SALT[A-Z_-]*>>>\s*$", markdown_part):
            raise ArtifactError("packet-only 正文内部含控制标记")
    if SIDECAR_MARKER in markdown_part:
        raise ArtifactError("packet-only 输出不得包含模型生成 sidecar")
    markdown = canonical_markdown(markdown_part)
    # The shorter label is a lossless transport alias, not story content.
    markdown = re.sub(
        r"(?m)^(-\s*)正向有限清单([：:])",
        r"\1本单元正向有限清单\2",
        markdown,
    )
    markdown = re.sub(
        r"(?m)^(-\s*)(人物[：:].*；\s*在场对象[：:].*；\s*可用事实[：:].*)$",
        r"\1本单元正向有限清单：\2",
        markdown,
    )
    markdown = re.sub(
        r'"([^"\n]*[\u3400-\u9fff][^"\n]*)"',
        r"“\1”",
        markdown,
    )
    return canonical_markdown(markdown)


CAPACITY_FIELDS = (
    "变化",
    "写作链",
    "压力",
    "直接写出",
    "本单元正向有限清单",
)
CAPACITY_FIELD_LIMITS = {
    "变化": 60,
    "写作链": 180,
    "压力": 70,
    "直接写出": 100,
    "本单元正向有限清单": 130,
}
CAPACITY_CARRIER_WEIGHTS = {
    "dialogue_turns": 40,
    "action_feedback_loops": 25,
    "knowledge_or_perception_shifts": 25,
    "aftermath_beats": 25,
}
CAPACITY_CARRIER_LIMITS = {
    "dialogue_turns": 8,
    "action_feedback_loops": 4,
    "knowledge_or_perception_shifts": 4,
    "aftermath_beats": 2,
}
CAPACITY_UNIT_BASE = 10
CAPACITY_SAFE_LOWER_NUMERATOR = 4
CAPACITY_SAFE_LOWER_DENOMINATOR = 5
CAPACITY_MAX_NUMERATOR = 11
CAPACITY_MAX_DENOMINATOR = 10


def chinese_char_count(text: str) -> int:
    return len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]", text))


def packet_capacity_budget(markdown: str) -> dict[str, Any]:
    """Derive a conservative prose ceiling from the packet's authorized payload.

    The budget deliberately ignores unit count and expansion labels.  Only the
    carrier declaration contributes capacity.  Structured field character
    counts are retained only as anti-inflation diagnostics; verbose control
    prose cannot raise the budget.
    """
    length_matches = list(
        re.finditer(r"(\d+)\s*[–—-]\s*(\d+)\s*汉字", markdown)
    )
    if len(length_matches) != 1:
        raise ArtifactError(
            "新版正文可见 packet 必须且只能有一处“下限–上限 汉字”篇幅范围"
        )
    target_min, target_max = (int(item) for item in length_matches[0].groups())
    if target_min <= 0 or target_max < target_min:
        raise ArtifactError("packet 篇幅范围上下限无效")

    unit_matches = list(re.finditer(r"(?m)^###\s+(U\d+)[^\n]*\n", markdown))
    if not unit_matches:
        raise ArtifactError("packet 没有可计算容量的场景单元")

    units: list[dict[str, Any]] = []
    source_total = 0
    raw_capacity_total = 0
    for index, match in enumerate(unit_matches):
        unit_id = match.group(1)
        end = unit_matches[index + 1].start() if index + 1 < len(unit_matches) else len(markdown)
        block = markdown[match.end() : end].split("\n## ", 1)[0]
        field_counts: dict[str, int] = {}
        for field in CAPACITY_FIELDS:
            field_matches = re.findall(
                rf"(?m)^-\s*{re.escape(field)}[：:]\s*(.+?)\s*$",
                block,
            )
            if len(field_matches) != 1:
                raise ArtifactError(
                    f"{unit_id} 容量字段 {field} 必须且只能出现一次，实际 {len(field_matches)}"
                )
            count = chinese_char_count(field_matches[0])
            if count == 0:
                raise ArtifactError(f"{unit_id} 容量字段 {field} 为空")
            if count > CAPACITY_FIELD_LIMITS[field]:
                raise ArtifactError(
                    f"{unit_id} 容量字段 {field} 过长：{count} > {CAPACITY_FIELD_LIMITS[field]}；"
                    "请压缩控制说明，不能靠写长执行包抬高正文容量"
                )
            field_counts[field] = count
        unit_chars = sum(field_counts.values())
        source_total += unit_chars
        carrier_matches = re.findall(
            r"(?m)^-\s*授权容量载体[：:]\s*"
            r"对白轮次\s*(\d+)\s*[；;]\s*"
            r"动作反馈闭环\s*(\d+)\s*[；;]\s*"
            r"认知或感知转折\s*(\d+)\s*[；;]\s*"
            r"事后反应\s*(\d+)\s*[。.]?\s*$",
            block,
        )
        if len(carrier_matches) != 1:
            raise ArtifactError(
                f"{unit_id} 必须且只能有一行结构化授权容量载体："
                "对白轮次 N；动作反馈闭环 N；认知或感知转折 N；事后反应 N"
            )
        carrier_values = tuple(int(item) for item in carrier_matches[0])
        carriers = dict(zip(CAPACITY_CARRIER_WEIGHTS, carrier_values))
        if not any(carriers.values()):
            raise ArtifactError(f"{unit_id} 授权容量载体不能全部为 0")
        for carrier, value in carriers.items():
            limit = CAPACITY_CARRIER_LIMITS[carrier]
            if value > limit:
                raise ArtifactError(
                    f"{unit_id} 授权容量载体 {carrier} 超过单元上限：{value} > {limit}"
                )
        raw_capacity = CAPACITY_UNIT_BASE + sum(
            carriers[name] * CAPACITY_CARRIER_WEIGHTS[name]
            for name in CAPACITY_CARRIER_WEIGHTS
        )
        raw_capacity_total += raw_capacity
        units.append(
            {
                "id": unit_id,
                "authorized_source_chinese_chars": unit_chars,
                "field_chinese_chars": field_counts,
                "carriers": carriers,
                "raw_capacity_chinese_chars": raw_capacity,
            }
        )

    safe_lower_ceiling = (
        raw_capacity_total
        * CAPACITY_SAFE_LOWER_NUMERATOR
        // CAPACITY_SAFE_LOWER_DENOMINATOR
    )
    authorized_max = (
        raw_capacity_total * CAPACITY_MAX_NUMERATOR // CAPACITY_MAX_DENOMINATOR
    )
    if target_min > safe_lower_ceiling:
        raise ArtifactError(
            "packet 篇幅下限超过授权内容的安全承载值："
            f"目标下限 {target_min} 汉字，安全下限上界 {safe_lower_ceiling} 汉字；"
            "即使把上限调低，硬下限仍会制造补字压力，请降低下限或补齐可展演的对白、"
            "动作反馈与余波"
        )
    if target_max > authorized_max:
        raise ArtifactError(
            "packet 篇幅上限超过授权容量："
            f"目标 {target_min}–{target_max} 汉字，授权上限 {authorized_max} 汉字；"
            "请降低篇幅范围或补齐真正需要展演的授权链，不能把补字压力交给正文模型"
        )
    return {
        "method": "authorized-carriers-v1",
        "target_min_chinese_chars": target_min,
        "target_max_chinese_chars": target_max,
        "authorized_source_chinese_chars": source_total,
        "raw_capacity_chinese_chars": raw_capacity_total,
        "authorized_safe_lower_ceiling_chinese_chars": safe_lower_ceiling,
        "authorized_max_chinese_chars": authorized_max,
        "safe_lower_ratio": "4/5",
        "maximum_ratio": "11/10",
        "units": units,
    }


def strip_capacity_carriers(markdown: str) -> str:
    """Remove compiler-private capacity declarations before writer delivery."""
    cleaned = re.sub(
        r"(?m)^-\s*授权容量载体[：:].*(?:\n|$)",
        "",
        canonical_markdown(markdown),
    )
    return canonical_markdown(cleaned)


def alias_writer_hard_fact_ids(markdown: str) -> str:
    """Replace private hard-fact identifiers with deterministic writer aliases."""
    aliases: dict[str, str] = {}

    def replace(match: re.Match[str]) -> str:
        source_id = match.group(0)
        if source_id not in aliases:
            aliases[source_id] = f"H-{len(aliases) + 1:02d}"
        return aliases[source_id]

    cleaned = re.sub(r"H-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*", replace, markdown)
    if aliases:
        final_alias = f"H-{len(aliases):02d}"
        cleaned = re.sub(
            r"(?m)(^- 新确证硬事实：)H-\d+(\s+至\s+)H-\d+",
            rf"\g<1>H-01\g<2>{final_alias}",
            cleaned,
        )
    return canonical_markdown(cleaned)


def writer_packet_markdown(markdown: str) -> str:
    """Build the deterministic packet actually exposed to the prose model."""
    return alias_writer_hard_fact_ids(strip_capacity_carriers(markdown))


def validate_capacity_budget_sidecar(budget: dict[str, Any]) -> None:
    source_total = 0
    raw_total = 0
    seen: set[str] = set()
    for unit in budget["units"]:
        unit_id = unit["id"]
        if unit_id in seen:
            raise ArtifactError(f"授权容量单元 ID 重复：{unit_id}")
        seen.add(unit_id)
        field_total = sum(unit["field_chinese_chars"].values())
        if field_total != unit["authorized_source_chinese_chars"]:
            raise ArtifactError(f"{unit_id} 授权字段汉字数合计不一致")
        source_total += field_total
        carriers = unit["carriers"]
        for carrier, value in carriers.items():
            if value > CAPACITY_CARRIER_LIMITS[carrier]:
                raise ArtifactError(f"{unit_id} 授权容量载体越过单元上限：{carrier}")
        expected_raw = CAPACITY_UNIT_BASE + sum(
            carriers[name] * CAPACITY_CARRIER_WEIGHTS[name]
            for name in CAPACITY_CARRIER_WEIGHTS
        )
        if unit["raw_capacity_chinese_chars"] != expected_raw:
            raise ArtifactError(f"{unit_id} 原始授权容量复算不一致")
        raw_total += expected_raw
    if budget["authorized_source_chinese_chars"] != source_total:
        raise ArtifactError("授权字段汉字数总计不一致")
    if budget["raw_capacity_chinese_chars"] != raw_total:
        raise ArtifactError("原始授权容量总计不一致")
    expected_safe = (
        raw_total * CAPACITY_SAFE_LOWER_NUMERATOR // CAPACITY_SAFE_LOWER_DENOMINATOR
    )
    expected_max = raw_total * CAPACITY_MAX_NUMERATOR // CAPACITY_MAX_DENOMINATOR
    if budget["authorized_safe_lower_ceiling_chinese_chars"] != expected_safe:
        raise ArtifactError("授权安全下限上界复算不一致")
    if budget["authorized_max_chinese_chars"] != expected_max:
        raise ArtifactError("授权绝对上限复算不一致")
    if budget["target_min_chinese_chars"] > expected_safe:
        raise ArtifactError("packet sidecar 的篇幅下限仍超过授权安全承载值")
    if budget["target_max_chinese_chars"] > expected_max:
        raise ArtifactError("packet sidecar 的篇幅上限仍超过授权绝对上限")


def build_packet_sidecar(markdown: str, boundary: dict[str, Any]) -> dict[str, Any]:
    """Build deterministic packet transport fields after Markdown validation."""
    writer_visible = "## 声音与正文边界" in markdown
    capacity_budget = packet_capacity_budget(markdown) if writer_visible else None
    writer_markdown = writer_packet_markdown(markdown) if writer_visible else markdown
    return {
        "schema_version": "1.1" if writer_visible else "1.0",
        "valid": True,
        "operation": "packet",
        "chapter": {
            "id": boundary["id"],
            "display": boundary["display"],
            "sequence": boundary["sequence"],
            "boundary_signature": boundary["boundary_signature"],
        },
        "verdict": "ready",
        "missing_units": [],
        "out_of_bounds_facts": [],
        "repair_scope": {"mode": "none", "targets": []},
        "checks": {
            "required_sections": True,
            "scene_units": True,
            "hard_facts": True,
            "boundary_match": True,
            **({"capacity_budget": True} if writer_visible else {}),
        },
        **({"capacity_budget": capacity_budget} if writer_visible else {}),
        "markdown_sha256": sha256_bytes(canonical_markdown(writer_markdown).encode("utf-8")),
    }


def require_sections(markdown: str, sections: list[str]) -> None:
    missing = [section for section in sections if section not in markdown]
    if missing:
        raise ArtifactError("Markdown 缺少必要部分：" + "、".join(missing))


def validate_markdown(markdown: str, sidecar: dict[str, Any]) -> None:
    operation = sidecar["operation"]
    display = sidecar["chapter"]["display"]
    first_line = markdown.splitlines()[0].strip()
    if not first_line.startswith("#"):
        raise ArtifactError("Markdown 第一行不是一级标题")
    if display not in first_line and not (display == "冷开场" and "冷开场" in first_line):
        raise ArtifactError(f"Markdown 标题与 sidecar 章节不一致：{display}")

    if operation == "packet":
        if "执行包" not in first_line:
            raise ArtifactError("packet 第一行不是执行包标题")
        require_sections(markdown, ["## 本章唯一任务", "## 场景功能单元", "## 章尾状态"])
        writer_visible = "## 声音与正文边界" in markdown
        if "## 硬事实保真" not in markdown and not writer_visible:
            raise ArtifactError("packet 缺少旧版硬事实保真或新版声音与正文边界")
        if writer_visible and (
            "## 硬事实保真" in markdown or "## 私有审核层" in markdown
        ):
            raise ArtifactError("新版正文可见 packet 混入私有审核内容")
        if writer_visible:
            current_sequence = sidecar["chapter"]["sequence"]
            future_ids = sorted(
                {
                    int(value)
                    for value in re.findall(r"\bB(\d{3})\b", markdown)
                    if int(value) > current_sequence
                }
            )
            if future_ids:
                formatted = "、".join(f"B{value:03d}" for value in future_ids)
                raise ArtifactError("正文可见 packet 泄露未来章节 ID：" + formatted)
            exposed_control_phrases = [
                phrase
                for phrase in (
                    "最多一句带过",
                    "本章仍不写",
                    "本章不到",
                    "下一章禁止",
                    "不可跨越的下一步",
                )
                if phrase in markdown
            ]
            if exposed_control_phrases:
                raise ArtifactError(
                    "新版正文可见 packet 混入控制语言："
                    + "、".join(exposed_control_phrases)
                )
            exact_layout_patterns = (
                r"\d+\s*[–—-]\s*\d+\s*段",
                r"(?:[一二两三四五六七八九十百]+|\d+)\s*(?:句|段)\s*(?:分别|各自)?\s*(?:独立|单独)?\s*(?:成段|落段)",
                r"(?:[一二两三四五六七八九十百]+|\d+)\s*(?:到|至|[–—-])\s*(?:[一二两三四五六七八九十百]+|\d+)\s*个?\s*(?:短句段|句|段)",
                r"(?:允许|必须|要求|限定|保留)\s*(?:[一二两三四五六七八九十百]+|\d+)\s*(?:句|段)",
            )
            if any(re.search(pattern, markdown) for pattern in exact_layout_patterns):
                raise ArtifactError("新版正文可见 packet 混入精确段句指标")
            if "授权容量载体" in markdown:
                raise ArtifactError("正文可见 packet 泄露了编译器私有容量载体")
            if sidecar.get("schema_version") != "1.1":
                raise ArtifactError("新版正文可见 packet 必须使用 1.1 sidecar")
            capacity_budget = sidecar.get("capacity_budget")
            if not isinstance(capacity_budget, dict):
                raise ArtifactError("新版正文可见 packet 缺少授权容量 sidecar")
            validate_capacity_budget_sidecar(capacity_budget)
            length_match = re.search(r"(\d+)\s*[–—-]\s*(\d+)\s*汉字", markdown)
            if length_match is None or tuple(map(int, length_match.groups())) != (
                capacity_budget["target_min_chinese_chars"],
                capacity_budget["target_max_chinese_chars"],
            ):
                raise ArtifactError("正文可见篇幅范围与授权容量 sidecar 不一致")
            if sidecar.get("checks", {}).get("capacity_budget") is not True:
                raise ArtifactError("packet 授权容量检查未通过")
            unit_count = len(re.findall(r"(?m)^###\s+U\d+", markdown))
            allowlist_lines = re.findall(
                r"(?m)^-\s*本单元正向有限清单[：:].*$", markdown
            )
            structured_allowlists = [
                line
                for line in allowlist_lines
                if re.search(r"人物[：:]", line)
                and re.search(r"在场对象[：:]", line)
                and re.search(r"可用事实[：:]", line)
            ]
            if unit_count == 0 or len(structured_allowlists) != unit_count:
                raise ArtifactError(
                    "新版正文可见 packet 的单元状态清单不完整："
                    f"单元 {unit_count}，结构化清单 {len(structured_allowlists)}"
                )
        if re.search(r"(?m)^###\s+U\d+", markdown) is None or "H-" not in markdown:
            raise ArtifactError("packet 缺少场景单元或硬事实 ID")
    elif operation == "audit":
        if "审核" not in first_line:
            raise ArtifactError("audit 第一行不是审核标题")
        require_sections(markdown, ["场景单元完成矩阵", "段落功能归属", "当前章问题", "安全返修单"])
        conclusion = "通过" if sidecar["verdict"] == "pass" else "返修"
        if re.search(rf"(?m)^结论[：:]\s*{conclusion}\s*$", markdown) is None:
            raise ArtifactError("audit Markdown 结论与 sidecar verdict 不一致")
    elif operation == "ledger":
        if "通过后的状态账本" not in first_line:
            raise ArtifactError("ledger 第一行不是通过后的状态账本")
        require_sections(markdown, ["## 时空与在场", "## 已成立事实", "## 知识状态", "## 关系与持续状态", "## 下一章承接"])


def all_true(value: dict[str, Any]) -> bool:
    return all(item is True for item in value.values())


def validate_result_semantics(
    sidecar: dict[str, Any],
    expected_operation: str,
    boundary: dict[str, Any] | None,
    require_pass: bool,
    approved_audit: dict[str, Any] | None,
) -> None:
    if sidecar["operation"] != expected_operation:
        raise ArtifactError(f"操作错误：期望 {expected_operation}，实际 {sidecar['operation']}")
    if sidecar["valid"] is not True:
        raise ArtifactError("sidecar valid 不是 true，产物不得进入下一阶段")
    if boundary is not None:
        chapter = sidecar["chapter"]
        expected = {
            "id": boundary["id"],
            "display": boundary["display"],
            "sequence": boundary["sequence"],
            "boundary_signature": boundary["boundary_signature"],
        }
        if chapter != expected:
            raise ArtifactError(f"sidecar 章节身份与边界 map 不一致：{chapter!r} != {expected!r}")

    verdict = sidecar["verdict"]
    if expected_operation == "packet":
        if verdict != "ready" or sidecar["missing_units"] or sidecar["out_of_bounds_facts"]:
            raise ArtifactError("packet 未达到 ready 或仍有缺失/越界")
        if sidecar["repair_scope"]["mode"] != "none" or not all_true(sidecar["checks"]):
            raise ArtifactError("packet 检查未全通过")
    elif expected_operation == "audit":
        if require_pass and verdict != "pass":
            raise ArtifactError("audit 结论不是 pass，流程不得继续")
        if verdict == "pass":
            if sidecar["missing_units"] or sidecar["out_of_bounds_facts"]:
                raise ArtifactError("audit 声称 pass 但仍列出缺失或越界事实")
            if sidecar["repair_scope"]["mode"] != "none" or not all_true(sidecar["checks"]):
                raise ArtifactError("audit 声称 pass 但检查或返修范围不一致")
        elif sidecar["repair_scope"]["mode"] == "none":
            raise ArtifactError("audit 需要返修却没有返修范围")
    elif expected_operation == "ledger":
        if verdict != "updated" or sidecar["missing_units"] or sidecar["out_of_bounds_facts"]:
            raise ArtifactError("ledger 未达到 updated 或仍有缺失/越界")
        if sidecar["repair_scope"]["mode"] != "none" or not all_true(sidecar["checks"]):
            raise ArtifactError("ledger 检查未全通过")
        if approved_audit is None:
            raise ArtifactError("ledger 必须提供已通过 audit sidecar")
        if approved_audit.get("operation") != "audit" or approved_audit.get("verdict") != "pass":
            raise ArtifactError("ledger 的 audit 前置条件不是 pass")
        if approved_audit.get("chapter") != sidecar.get("chapter"):
            raise ArtifactError("ledger 与 audit 章节身份不一致")


def validate_result(
    markdown: str,
    sidecar: dict[str, Any],
    operation: str,
    boundary: dict[str, Any] | None,
    require_pass: bool,
    approved_audit: dict[str, Any] | None,
) -> None:
    validate_against_schema(sidecar, f"{operation}-result.schema.json")
    expected_hash = sha256_bytes(canonical_markdown(markdown).encode("utf-8"))
    if sidecar["markdown_sha256"] != expected_hash:
        raise ArtifactError("Markdown 哈希与 sidecar 不一致")
    validate_markdown(canonical_markdown(markdown), sidecar)
    validate_result_semantics(sidecar, operation, boundary, require_pass, approved_audit)


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def command_extract(args: argparse.Namespace) -> None:
    value = extract_boundary_map(Path(args.source))
    validate_against_schema(value, "chapter-boundaries.schema.json")
    write_json(Path(args.output), value)
    print(f"OK boundaries={len(value['chapters'])} output={args.output}")


def command_validate_boundaries(args: argparse.Namespace) -> None:
    value = validate_boundary_map(
        Path(args.source),
        Path(args.boundaries),
        Path(args.blueprint) if args.blueprint else None,
    )
    print(f"OK boundaries={len(value['chapters'])} source={value['source']['file_name']}")


def command_slice(args: argparse.Namespace) -> None:
    source = Path(args.source)
    boundaries = validate_boundary_map(source, Path(args.boundaries), None)
    boundary = find_boundary(boundaries, args.chapter_id)
    text, _ = read_source(source)
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    body = "\n".join(lines[boundary["content_start_line"] - 1 : boundary["content_end_line"]])
    heading = boundary["source_label"]
    output = (heading + "\n\n" if heading else "") + body.strip() + "\n"
    atomic_write(Path(args.output), output)
    print(f"OK chapter={boundary['id']} display={boundary['display']} output={args.output}")


def result_context(args: argparse.Namespace) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    boundary = None
    if args.boundaries:
        boundaries = load_json(Path(args.boundaries))
        validate_against_schema(boundaries, "chapter-boundaries.schema.json")
        boundary = find_boundary(boundaries, args.chapter_id)
    approved_audit = load_json(Path(args.approved_audit)) if args.approved_audit else None
    if approved_audit is not None:
        validate_against_schema(approved_audit, "audit-result.schema.json")
    return boundary, approved_audit


def command_accept(args: argparse.Namespace) -> None:
    raw = Path(args.raw).read_text(encoding="utf-8-sig")
    boundary, approved_audit = result_context(args)
    if args.controller_owned_packet_sidecar:
        if args.operation != "packet" or boundary is None:
            raise ArtifactError("控制器生成 sidecar 只适用于带边界 map 的 packet")
        compiler_markdown = parse_packet_markdown_envelope(raw)
        sidecar = build_packet_sidecar(compiler_markdown, boundary)
        markdown = (
            writer_packet_markdown(compiler_markdown)
            if sidecar["schema_version"] == "1.1"
            else compiler_markdown
        )
    else:
        markdown, sidecar = parse_envelope(raw)
    validate_result(markdown, sidecar, args.operation, boundary, args.require_pass, approved_audit)
    atomic_write(Path(args.markdown_out), markdown)
    atomic_write(Path(args.sidecar_out), json.dumps(sidecar, ensure_ascii=False, indent=2) + "\n")
    print(f"OK operation={args.operation} chapter={sidecar['chapter']['id']} verdict={sidecar['verdict']}")


def command_validate_result(args: argparse.Namespace) -> None:
    markdown = Path(args.markdown).read_text(encoding="utf-8-sig")
    sidecar = load_json(Path(args.sidecar))
    boundary, approved_audit = result_context(args)
    validate_result(markdown, sidecar, args.operation, boundary, args.require_pass, approved_audit)
    print(f"OK operation={args.operation} chapter={sidecar['chapter']['id']} verdict={sidecar['verdict']}")


def command_build_packet_sidecar(args: argparse.Namespace) -> None:
    boundaries = load_json(Path(args.boundaries))
    validate_against_schema(boundaries, "chapter-boundaries.schema.json")
    boundary = find_boundary(boundaries, args.chapter_id)
    markdown = Path(args.markdown).read_text(encoding="utf-8-sig")
    sidecar = build_packet_sidecar(markdown, boundary)
    writer_markdown = (
        strip_capacity_carriers(markdown)
        if "## 声音与正文边界" in markdown
        else canonical_markdown(markdown)
    )
    validate_result(writer_markdown, sidecar, "packet", boundary, False, None)
    write_json(Path(args.output), sidecar)
    print(f"OK packet-sidecar={boundary['id']} schema={sidecar['schema_version']}")


def command_validate_ledger_state(args: argparse.Namespace) -> None:
    current = load_json(Path(args.current))
    if args.previous:
        previous = load_json(Path(args.previous))
        validate_ledger_transition(previous, current)
        print(
            "OK ledger-transition="
            f"{previous['chapter']['id']}->{current['chapter']['id']} "
            f"live={len(ledger_live_index(current))}"
        )
    else:
        validate_ledger_state(current)
        print(
            f"OK ledger={current['chapter']['id']} "
            f"live={len(ledger_live_index(current))}"
        )


def command_validate_draft_audit(args: argparse.Namespace) -> None:
    draft = Path(args.draft).read_text(encoding="utf-8-sig")
    evidence = load_json(Path(args.evidence))
    validate_draft_audit(draft, evidence, args.require_pass)
    if args.packet:
        packet = Path(args.packet).read_text(encoding="utf-8-sig")
        validate_locked_packet_quotes(draft, packet)
    print(
        f"OK draft-audit={evidence['chapter']['id']} "
        f"units={len(evidence['units'])} paragraphs={len(evidence['paragraphs'])}"
    )


def locked_packet_quotes(packet: str) -> list[str]:
    locked: list[str] = []
    for line in canonical_markdown(packet).splitlines():
        if not (
            line.startswith("- 直接写出：")
            or line.startswith("- 章节结尾落点：")
        ):
            continue
        for match in re.finditer(r"“([^”\n]+)”", line):
            suffix = line[match.end() :].lstrip()
            if suffix.startswith("语义等值"):
                continue
            if match.group(1) not in locked:
                locked.append(match.group(1))
    return locked


def validate_locked_packet_quotes(draft: str, packet: str) -> None:
    missing = [quote for quote in locked_packet_quotes(packet) if quote not in draft]
    if missing:
        raise ArtifactError("正文缺少锁定台词原文：" + "、".join(missing))


def apply_authorized_deletions(draft: str, evidence: dict[str, Any]) -> str:
    """Apply only exact audit-authorized deletions; reject broader repair scopes."""
    validate_draft_audit(draft, evidence, False)
    if any(unit["status"] != "complete" for unit in evidence["units"]):
        raise ArtifactError("deterministic deletion repair requires all units complete")
    delete_quotes = [
        item["quote"]
        for item in evidence["authorization_findings"]
        if item["verdict"] == "delete"
    ]
    unsupported = [
        item["quote"]
        for item in evidence["authorization_findings"]
        if item["verdict"] not in {"authorized", "delete"}
    ]
    if unsupported:
        raise ArtifactError(
            "deterministic deletion repair cannot handle non-delete findings: "
            + " | ".join(unsupported)
        )
    if not delete_quotes:
        raise ArtifactError("deterministic deletion repair has no delete findings")

    repaired = canonical_markdown(draft)
    paragraphs = draft_paragraphs(repaired)
    for item in evidence["paragraphs"]:
        if item["verdict"] == "keep":
            continue
        paragraph = paragraphs[item["index"] - 1]
        if item["verdict"] == "delete":
            if paragraph not in delete_quotes:
                raise ArtifactError(
                    "whole-paragraph deletion requires an exact matching finding: "
                    + str(item["index"])
                )
            continue
        if item["verdict"] != "repair":
            raise ArtifactError(
                "deterministic deletion repair found unsupported paragraph verdict"
            )
        if not any(quote in paragraph for quote in delete_quotes):
            raise ArtifactError(
                "repair paragraph is not explained by an exact delete finding: "
                + str(item["index"])
            )

    for quote in delete_quotes:
        if repaired.count(quote) != 1:
            raise ArtifactError(
                f"delete finding must occur exactly once before repair: {quote}"
            )
        repaired = repaired.replace(quote, "", 1)

    # Removing a phrase after a comma may leave `，。`; collapse only this
    # mechanically created punctuation seam. Do not rewrite any surrounding text.
    while True:
        cleaned = re.sub(r"([，、；：])\s*\1+", r"\1", repaired)
        cleaned = re.sub(r"[，、；：]\s*([。！？])", r"\1", cleaned)
        if cleaned == repaired:
            break
        repaired = cleaned
    repaired = canonical_markdown(repaired)
    if any(quote in repaired for quote in delete_quotes):
        raise ArtifactError("deterministic deletion repair did not remove every finding")
    return repaired


def build_audit_view(draft: str) -> dict[str, Any]:
    """Create controller-numbered paragraph transport without changing prose."""
    canonical = canonical_markdown(draft)
    paragraphs = draft_paragraphs(canonical)
    sentences = audit_sentence_records(canonical)
    return {
        "schema_version": "1.1",
        "draft_sha256": sha256_bytes(canonical.encode("utf-8")),
        "paragraph_count": len(paragraphs),
        "paragraphs": [
            {"index": index, "text": text}
            for index, text in enumerate(paragraphs, start=1)
        ],
        "sentences": sentences,
    }


def command_build_audit_view(args: argparse.Namespace) -> None:
    draft = Path(args.draft).read_text(encoding="utf-8-sig")
    view = build_audit_view(draft)
    write_json(Path(args.output), view)
    print(
        f"OK audit-view paragraphs={view['paragraph_count']} "
        f"draft_sha256={view['draft_sha256']}"
    )


def command_apply_audit_deletions(args: argparse.Namespace) -> None:
    draft = Path(args.draft).read_text(encoding="utf-8-sig")
    evidence = load_json(Path(args.evidence))
    repaired = apply_authorized_deletions(draft, evidence)
    atomic_write(Path(args.output), repaired)
    print(
        f"OK audit-deletions={evidence['chapter']['id']} "
        f"removed={sum(item['verdict'] == 'delete' for item in evidence['authorization_findings'])}"
    )


def command_accept_draft_audit_semantics(args: argparse.Namespace) -> None:
    draft = Path(args.draft).read_text(encoding="utf-8-sig")
    raw = Path(args.raw).read_text(encoding="utf-8-sig")
    packet_sidecar = load_json(Path(args.packet_sidecar))
    validate_against_schema(packet_sidecar, "packet-result.schema.json")
    if packet_sidecar["operation"] != "packet" or packet_sidecar["verdict"] != "ready":
        raise ArtifactError("审核语义必须绑定 ready packet sidecar")
    semantics = parse_json_document(raw)
    evidence = build_draft_audit_evidence(
        draft,
        semantics,
        packet_sidecar["chapter"],
    )
    atomic_write(
        Path(args.output),
        json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
    )
    print(
        f"OK audit-semantics={evidence['chapter']['id']} "
        f"units={len(evidence['units'])} paragraphs={len(evidence['paragraphs'])}"
    )


def normalize_unknown_ledger_context(semantics: dict[str, Any]) -> None:
    context = semantics.setdefault("context", {})
    for field, fallback in (
        ("current_time", "正文未明确具体时间"),
        ("current_location", "正文未明确具体地点"),
    ):
        assertion = context.setdefault(field, {})
        if not assertion.get("evidence_refs"):
            assertion["text"] = fallback


def canonicalize_ledger_voice_anchors(
    semantics: dict[str, Any], draft: str, previous: dict[str, Any]
) -> None:
    for anchor in semantics.get("context", {}).get("voice_anchors", []):
        if len(anchor.get("evidence_refs", [])) != 1:
            raise ArtifactError("声音锚点必须且只能引用一个正文句子 ID")
        resolved = resolve_ledger_evidence_ref(anchor["evidence_refs"][0], draft, previous)
        if not isinstance(resolved, str):
            raise ArtifactError("声音锚点证据必须解析为一个正文句子")
        anchor["text"] = resolved


def build_ledger_state_from_semantics(
    draft: str,
    audit: dict[str, Any],
    previous: dict[str, Any],
    semantics: dict[str, Any],
) -> dict[str, Any]:
    semantics = json.loads(json.dumps(semantics))
    normalize_unknown_ledger_context(semantics)
    for signal in semantics.get("new_signals", []):
        signal.pop("payoff_condition", None)
    validate_against_schema(semantics, "ledger-semantics.schema.json")
    validate_ledger_state(previous)
    validate_draft_audit(draft, audit, True)
    validate_ledger_context_negative_claims(semantics, draft, previous)
    chapter = audit["chapter"]
    if chapter["sequence"] != previous["chapter"]["sequence"] + 1:
        raise ArtifactError("账本语义必须紧接上一章，不允许跳章")

    display_id = re.sub(r"\D", "", chapter["display"]).lstrip("0") or "0"
    for section in ("new_facts", "new_active_states", "new_obligations", "new_signals"):
        for item in semantics[section]:
            match = re.fullmatch(r"([FAOS])-0*([0-9]+)-(.+)", item["id"])
            if match and (match.group(2).lstrip("0") or "0") == display_id:
                item["id"] = f"{match.group(1)}-{chapter['id']}-{match.group(3)}"

    sentence_map = audit_sentence_reference_map(draft)
    submitted_coverage: dict[str, set[str]] = {}
    for item in semantics["direct_write_coverage"]:
        if item["id"] in submitted_coverage:
            raise ArtifactError(f"直接写出覆盖重复：{item['id']}")
        refs = set(item["evidence_refs"])
        unknown_refs = refs - set(sentence_map)
        if unknown_refs:
            raise ArtifactError("直接写出覆盖含未知句子 ID：" + "、".join(sorted(unknown_refs)))
        submitted_coverage[item["id"]] = {sentence_map[ref] for ref in refs}
    required_coverage = {item["id"]: set(item["evidence"]) for item in audit["direct_writes"]}
    if set(submitted_coverage) != set(required_coverage):
        missing = sorted(set(required_coverage) - set(submitted_coverage))
        extra = sorted(set(submitted_coverage) - set(required_coverage))
        raise ArtifactError(f"直接写出覆盖 ID 不完整：missing={missing} extra={extra}")
    for item_id, evidence in required_coverage.items():
        if not submitted_coverage[item_id].intersection(evidence):
            raise ArtifactError(f"直接写出覆盖没有引用该项真实证据：{item_id}")
    max_new_facts = max(3, len(required_coverage) + 2)
    if len(semantics["new_facts"]) > max_new_facts:
        raise ArtifactError(
            f"新增普通事实过度拆分：{len(semantics['new_facts'])} > {max_new_facts}"
        )
    canonicalize_ledger_voice_anchors(semantics, draft, previous)

    previous_live = ledger_live_index(previous)
    operations: dict[str, dict[str, Any]] = {}
    for operation in semantics["live_operations"]:
        source_id = operation["source_id"]
        if source_id in operations:
            raise ArtifactError(f"同一活跃项提交了多个操作：{source_id}")
        if source_id not in previous_live:
            raise ArtifactError(f"账本操作引用未知活跃项：{source_id}")
        operations[source_id] = operation
    missing_operations = sorted(set(previous_live) - set(operations))
    if missing_operations:
        raise ArtifactError("上一章活跃项未逐项表态：" + "、".join(missing_operations))

    state: dict[str, Any] = {
        "schema_version": "1.0",
        "chapter": chapter,
        "ordinary_facts": json.loads(json.dumps(previous["ordinary_facts"])),
        "active_states": [],
        "open_obligations": [],
        "pending_signals": [],
        "closed_items": json.loads(json.dumps(previous["closed_items"])),
    }
    for item in semantics["new_facts"]:
        evidence = resolve_ledger_evidence_refs(
            item["evidence_refs"], draft, previous, current_only=True
        )
        validate_ledger_negative_claim(item["text"], evidence)
        state["ordinary_facts"].append(
            {
                "id": item["id"],
                "text": item["text"],
                "established_chapter": chapter["id"],
                "evidence": evidence,
            }
        )

    for source_id, (section, old_item) in previous_live.items():
        operation = operations[source_id]
        action = operation["action"]
        if action == "carry":
            forbidden = {"text", "payoff_condition", "evidence_refs", "disposition", "resolution"}
            if forbidden.intersection(operation):
                raise ArtifactError(f"carry 不得附带修订字段：{source_id}")
            state[section].append(json.loads(json.dumps(old_item)))
            continue
        if action in {"confirm", "revise"}:
            required = {"evidence_refs"}
            if action == "revise":
                required.add("text")
            missing = required - set(operation)
            if missing:
                raise ArtifactError(f"{action} 缺少字段 {sorted(missing)}：{source_id}")
            if "disposition" in operation or "resolution" in operation:
                raise ArtifactError(f"{action} 不得附带闭合字段：{source_id}")
            updated = json.loads(json.dumps(old_item))
            updated["last_confirmed_chapter"] = chapter["id"]
            updated["evidence"] = resolve_ledger_evidence_refs(
                operation["evidence_refs"], draft, previous, current_only=True
            )
            if action == "revise":
                updated["text"] = operation["text"]
                validate_ledger_negative_claim(updated["text"], updated["evidence"])
                if section == "pending_signals" and "payoff_condition" in operation:
                    updated["payoff_condition"] = operation["payoff_condition"]
            elif "text" in operation or "payoff_condition" in operation:
                raise ArtifactError(f"confirm 不得改写语义：{source_id}")
            state[section].append(updated)
            continue
        required = {"disposition", "resolution", "evidence_refs"}
        missing = required - set(operation)
        if missing:
            raise ArtifactError(f"close 缺少字段 {sorted(missing)}：{source_id}")
        if "text" in operation or "payoff_condition" in operation:
            raise ArtifactError(f"close 不得偷偷修订原项目：{source_id}")
        state["closed_items"].append(
            {
                "source_id": source_id,
                "source_section": section,
                "disposition": operation["disposition"],
                "closed_chapter": chapter["id"],
                "resolution": operation["resolution"],
                "evidence": resolve_ledger_evidence_refs(
                    operation["evidence_refs"], draft, previous, current_only=True
                ),
            }
        )

    new_specs = (
        ("new_active_states", "active_states", "A-"),
        ("new_obligations", "open_obligations", "O-"),
        ("new_signals", "pending_signals", "S-"),
    )
    for semantics_key, state_key, prefix in new_specs:
        for item in semantics[semantics_key]:
            if not item["id"].startswith(prefix):
                raise ArtifactError(f"{semantics_key} ID 前缀错误：{item['id']}")
            if chapter["id"] not in item["id"]:
                raise ArtifactError(f"新项目 ID 必须包含当前章号：{item['id']}")
            built = {
                "id": item["id"],
                "text": item["text"],
                "established_chapter": chapter["id"],
                "last_confirmed_chapter": chapter["id"],
                "evidence": resolve_ledger_evidence_refs(
                    item["evidence_refs"], draft, previous, current_only=True
                ),
            }
            validate_ledger_negative_claim(built["text"], built["evidence"])
            if state_key != "pending_signals":
                built["kind"] = item["kind"]
                if "payoff_condition" in item:
                    raise ArtifactError(f"非信号项目不得含 payoff_condition：{item['id']}")
            else:
                if item["kind"] != "signal":
                    raise ArtifactError(f"新信号必须使用 kind=signal：{item['id']}")
                built["payoff_condition"] = "后续执行包授权处理当前表层异常"
            state[state_key].append(built)

    all_new_ids = [
        item["id"]
        for section in ("ordinary_facts",) + LEDGER_LIVE_SECTIONS
        for item in state[section]
    ]
    if len(all_new_ids) != len(set(all_new_ids)):
        raise ArtifactError("账本含重复 ID")
    validate_ledger_transition(previous, state)
    return state


def render_ledger_markdown(
    state: dict[str, Any],
    semantics: dict[str, Any],
    draft: str,
    previous: dict[str, Any],
) -> str:
    def assertion_text(assertion: dict[str, Any]) -> str:
        evidence: list[str] = []
        for reference in assertion["evidence_refs"]:
            value = resolve_ledger_evidence_ref(reference, draft, previous)
            for item in value if isinstance(value, list) else [value]:
                if item not in evidence:
                    evidence.append(item)
        if not evidence:
            return assertion["text"]
        rendered = "、".join(quote_evidence(item) for item in evidence)
        return f"{assertion['text']}；证据：{rendered}"

    def quote_evidence(evidence: str) -> str:
        if evidence.startswith("“") and evidence.endswith("”"):
            return evidence
        return f"“{evidence}”"

    def render_evidence(evidence: str | list[str]) -> str:
        values = evidence if isinstance(evidence, list) else [evidence]
        return "、".join(quote_evidence(item) for item in values)

    def list_or_none(lines: list[str]) -> list[str]:
        return [f"- {line}" for line in lines] if lines else ["- 无。"]

    context = semantics["context"]
    lines = [
        f"# {state['chapter']['display']} 通过后的状态账本",
        "",
        "## 时空与在场",
        "",
        f"- 当前时间：{assertion_text(context['current_time'])}",
        f"- 当前地点：{assertion_text(context['current_location'])}",
        *list_or_none(["可访问人物：" + assertion_text(item) for item in context["accessible_people"]]),
        "",
        "## 普通已成立事实",
        "",
        *list_or_none([
            f"{item['id']}：{item['text']}；建立章 {item['established_chapter']}；证据：{render_evidence(item['evidence'])}"
            for item in state["ordinary_facts"]
        ]),
        "",
        "## 知识状态",
        "",
        *list_or_none(["苏岩已知：" + assertion_text(item) for item in context["narrator_knowledge"]]),
        *list_or_none(["苏岩判断：" + assertion_text(item) for item in context["narrator_inferences"]]),
        *list_or_none(["仍悬置：" + assertion_text(item) for item in context["unresolved"]]),
        "",
        "## 当前活跃状态",
        "",
        *list_or_none([
            f"{item['id']}：{item['text']}；最近确认章 {item['last_confirmed_chapter']}；证据：{render_evidence(item['evidence'])}"
            for item in state["active_states"]
        ]),
        "",
        "## 跨章未完成义务",
        "",
        *list_or_none([
            f"{item['id']}：{item['text']}；最近确认章 {item['last_confirmed_chapter']}；证据：{render_evidence(item['evidence'])}"
            for item in state["open_obligations"]
        ]),
        "",
        "## 待回收信号",
        "",
        *list_or_none([
            f"{item['id']}：{item['text']}；回收条件：{item['payoff_condition']}；证据：{render_evidence(item['evidence'])}"
            for item in state["pending_signals"]
        ]),
        "",
        "## 本章闭合项",
        "",
        *list_or_none([
            f"{item['source_id']}：{item['resolution']}；处置 {item['disposition']}；证据：{render_evidence(item['evidence'])}"
            for item in state["closed_items"]
            if item["closed_chapter"] == state["chapter"]["id"]
        ]),
        "",
        "## 下一章承接",
        "",
        f"- 最后可见动作：{assertion_text(context['last_visible_action'])}",
        *list_or_none(["必须连续：" + assertion_text(item) for item in context["required_continuity"]]),
        *list_or_none(["可选声音锚点：" + assertion_text(item) for item in context["voice_anchors"]]),
        "",
    ]
    return "\n".join(lines)


def command_accept_ledger_semantics(args: argparse.Namespace) -> None:
    draft = Path(args.draft).read_text(encoding="utf-8-sig")
    audit = load_json(Path(args.audit))
    previous = load_json(Path(args.previous))
    semantics = parse_json_document(Path(args.raw).read_text(encoding="utf-8-sig"))
    normalize_unknown_ledger_context(semantics)
    canonicalize_ledger_voice_anchors(semantics, draft, previous)
    state = build_ledger_state_from_semantics(draft, audit, previous, semantics)
    markdown = render_ledger_markdown(state, semantics, draft, previous)
    write_json(Path(args.sidecar_out), state)
    atomic_write(Path(args.markdown_out), markdown)
    print(
        f"OK ledger-semantics={state['chapter']['id']} "
        f"live={len(ledger_live_index(state))}"
    )


def command_validate_ledger_repair_scope(args: argparse.Namespace) -> None:
    before = parse_json_document(Path(args.before).read_text(encoding="utf-8-sig"))
    after = parse_json_document(Path(args.after).read_text(encoding="utf-8-sig"))
    memo = Path(args.memo).read_text(encoding="utf-8-sig")
    validate_ledger_repair_scope(before, after, memo)
    print(f"OK ledger-repair-scope changes={len(semantic_diff_paths(before, after))}")


def command_recommend_length_range(args: argparse.Namespace) -> None:
    draft = Path(args.draft).read_text(encoding="utf-8-sig")
    evidence = load_json(Path(args.evidence))
    packet = Path(args.packet).read_text(encoding="utf-8-sig")
    validate_draft_audit(draft, evidence, True)
    matches = list(
        re.finditer(
            r"(\d+)\s*[–—~～至-]\s*(\d+)\s*(?:汉字|字)?",
            packet,
        )
    )
    if len(matches) != 1:
        raise ArtifactError("packet 必须且只能有一处机器可读篇幅范围")
    current_min, current_max = (int(item) for item in matches[0].groups())
    measured = evidence["chinese_chars"]
    if measured < current_min:
        recommended_min = max(1, measured * 9 // 10)
        recommended_max = max(measured, (measured * 6 + 4) // 5)
        status = "reestimate"
        reason = "audit-pass-complete-below-lower-bound"
    else:
        recommended_min = current_min
        recommended_max = current_max
        status = "keep"
        reason = "audit-pass-within-or-above-lower-bound"
    result = {
        "schema_version": "1.0",
        "status": status,
        "chapter": evidence["chapter"],
        "draft_sha256": evidence["draft_sha256"],
        "measured_chinese_chars": measured,
        "current_min_chinese_chars": current_min,
        "current_max_chinese_chars": current_max,
        "recommended_min_chinese_chars": recommended_min,
        "recommended_max_chinese_chars": recommended_max,
        "reason": reason,
    }
    write_json(Path(args.output), result)
    print(
        f"OK length-range={status} measured={measured} "
        f"recommended={recommended_min}-{recommended_max}"
    )


def add_result_context(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--operation", choices=("packet", "audit", "ledger"), required=True)
    parser.add_argument("--boundaries")
    parser.add_argument("--chapter-id")
    parser.add_argument("--require-pass", action="store_true")
    parser.add_argument("--approved-audit")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    extract = sub.add_parser("extract-boundaries")
    extract.add_argument("--source", required=True)
    extract.add_argument("--output", required=True)
    extract.set_defaults(func=command_extract)

    validate_boundaries = sub.add_parser("validate-boundaries")
    validate_boundaries.add_argument("--source", required=True)
    validate_boundaries.add_argument("--boundaries", required=True)
    validate_boundaries.add_argument("--blueprint")
    validate_boundaries.set_defaults(func=command_validate_boundaries)

    slice_parser = sub.add_parser("slice-source")
    slice_parser.add_argument("--source", required=True)
    slice_parser.add_argument("--boundaries", required=True)
    slice_parser.add_argument("--chapter-id", required=True)
    slice_parser.add_argument("--output", required=True)
    slice_parser.set_defaults(func=command_slice)

    accept = sub.add_parser("accept-result")
    accept.add_argument("--raw", required=True)
    accept.add_argument("--markdown-out", required=True)
    accept.add_argument("--sidecar-out", required=True)
    accept.add_argument("--controller-owned-packet-sidecar", action="store_true")
    add_result_context(accept)
    accept.set_defaults(func=command_accept)

    validate_result_parser = sub.add_parser("validate-result")
    validate_result_parser.add_argument("--markdown", required=True)
    validate_result_parser.add_argument("--sidecar", required=True)
    add_result_context(validate_result_parser)
    validate_result_parser.set_defaults(func=command_validate_result)

    build_packet = sub.add_parser("build-packet-sidecar")
    build_packet.add_argument("--markdown", required=True)
    build_packet.add_argument("--boundaries", required=True)
    build_packet.add_argument("--chapter-id", required=True)
    build_packet.add_argument("--output", required=True)
    build_packet.set_defaults(func=command_build_packet_sidecar)

    validate_ledger = sub.add_parser("validate-ledger-state")
    validate_ledger.add_argument("--current", required=True)
    validate_ledger.add_argument("--previous")
    validate_ledger.set_defaults(func=command_validate_ledger_state)

    validate_draft = sub.add_parser("validate-draft-audit")
    validate_draft.add_argument("--draft", required=True)
    validate_draft.add_argument("--evidence", required=True)
    validate_draft.add_argument("--packet")
    validate_draft.add_argument("--require-pass", action="store_true")
    validate_draft.set_defaults(func=command_validate_draft_audit)

    apply_deletions = sub.add_parser("apply-audit-deletions")
    apply_deletions.add_argument("--draft", required=True)
    apply_deletions.add_argument("--evidence", required=True)
    apply_deletions.add_argument("--output", required=True)
    apply_deletions.set_defaults(func=command_apply_audit_deletions)

    audit_view = sub.add_parser("build-audit-view")
    audit_view.add_argument("--draft", required=True)
    audit_view.add_argument("--output", required=True)
    audit_view.set_defaults(func=command_build_audit_view)

    accept_audit_semantics = sub.add_parser("accept-draft-audit-semantics")
    accept_audit_semantics.add_argument("--draft", required=True)
    accept_audit_semantics.add_argument("--raw", required=True)
    accept_audit_semantics.add_argument("--packet-sidecar", required=True)
    accept_audit_semantics.add_argument("--output", required=True)
    accept_audit_semantics.set_defaults(func=command_accept_draft_audit_semantics)

    accept_ledger_semantics = sub.add_parser("accept-ledger-semantics")
    accept_ledger_semantics.add_argument("--draft", required=True)
    accept_ledger_semantics.add_argument("--audit", required=True)
    accept_ledger_semantics.add_argument("--previous", required=True)
    accept_ledger_semantics.add_argument("--raw", required=True)
    accept_ledger_semantics.add_argument("--markdown-out", required=True)
    accept_ledger_semantics.add_argument("--sidecar-out", required=True)
    accept_ledger_semantics.set_defaults(func=command_accept_ledger_semantics)

    validate_ledger_repair = sub.add_parser("validate-ledger-repair-scope")
    validate_ledger_repair.add_argument("--before", required=True)
    validate_ledger_repair.add_argument("--after", required=True)
    validate_ledger_repair.add_argument("--memo", required=True)
    validate_ledger_repair.set_defaults(func=command_validate_ledger_repair_scope)

    recommend_length = sub.add_parser("recommend-length-range")
    recommend_length.add_argument("--draft", required=True)
    recommend_length.add_argument("--evidence", required=True)
    recommend_length.add_argument("--packet", required=True)
    recommend_length.add_argument("--output", required=True)
    recommend_length.set_defaults(func=command_recommend_length_range)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command in {"accept-result", "validate-result"} and getattr(args, "boundaries", None) and not getattr(args, "chapter_id", None):
        raise ArtifactError("--boundaries 与 --chapter-id 必须同时提供")
    args.func(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ArtifactError as exc:
        print(f"INVALID: {exc}", file=sys.stderr)
        raise SystemExit(2)
