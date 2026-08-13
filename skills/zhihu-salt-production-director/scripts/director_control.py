#!/usr/bin/env python3
"""Deterministic state, trace, rollback and delivery control for story production."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SKILL_ROOT = Path(__file__).resolve().parents[1]
REFERENCES = SKILL_ROOT / "references"
SCHEMAS = REFERENCES / "schemas"
ZERO_HASH = "0" * 64


class DirectorError(RuntimeError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DirectorError(f"cannot load JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise DirectorError(f"JSON top level must be an object: {path}")
    return value


def validate_schema_node(value: Any, schema: dict[str, Any], path: str) -> list[str]:
    errors: list[str] = []
    expected = schema.get("type")
    type_matches = {
        "object": isinstance(value, dict),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "boolean": isinstance(value, bool),
    }
    if expected in type_matches and not type_matches[expected]:
        return [f"{path}: expected {expected}"]
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: expected constant {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: value is not in the allowed set")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{path}: string is too short")
        pattern = schema.get("pattern")
        if pattern and re.fullmatch(pattern, value) is None:
            errors.append(f"{path}: string does not match {pattern}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{path}: array has too few items")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                errors.extend(
                    validate_schema_node(item, item_schema, f"{path}/{index}")
                )
    if isinstance(value, dict):
        required = schema.get("required", [])
        for key in required:
            if key not in value:
                errors.append(f"{path}: missing required property {key}")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in properties:
                    errors.append(f"{path}: unexpected property {key}")
        for key, child_schema in properties.items():
            if key in value:
                errors.extend(
                    validate_schema_node(
                        value[key], child_schema, f"{path}/{key}"
                    )
                )
    return errors


def validate_schema(value: dict[str, Any], name: str) -> None:
    errors = validate_schema_node(value, load_json(SCHEMAS / name), "<root>")
    if errors:
        raise DirectorError(
            f"{name} validation failed: {'; '.join(errors[:8])}"
        )


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


def snapshot_artifact(run_dir: Path, artifact_id: str, source: Path) -> Path:
    """Copy a registered artifact into an immutable run-local evidence vault."""
    safe_id = re.sub(r"[^A-Za-z0-9._-]+", "_", artifact_id).strip("._")
    if not safe_id:
        raise DirectorError("artifact id cannot produce a safe vault name")
    suffix = "".join(source.suffixes) or ".bin"
    vault_path = run_dir / "artifact-vault" / f"{safe_id}{suffix}"
    if vault_path.exists():
        raise DirectorError(f"artifact vault target already exists: {vault_path}")
    vault_path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(
        prefix=vault_path.name + ".", dir=vault_path.parent
    )
    os.close(handle)
    try:
        shutil.copyfile(source, temp_name)
        os.replace(temp_name, vault_path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return vault_path


def snapshot_attempt(run_dir: Path, attempt_id: str, source: Path) -> Path:
    """Copy a node attempt into a vault without occupying an artifact slot."""
    safe_id = re.sub(r"[^A-Za-z0-9._-]+", "_", attempt_id).strip("._")
    if not safe_id:
        raise DirectorError("attempt id cannot produce a safe vault name")
    suffix = "".join(source.suffixes) or ".bin"
    vault_path = run_dir / "attempt-vault" / f"{safe_id}{suffix}"
    if vault_path.exists():
        raise DirectorError(f"attempt vault target already exists: {vault_path}")
    vault_path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(
        prefix=vault_path.name + ".", dir=vault_path.parent
    )
    os.close(handle)
    try:
        shutil.copyfile(source, temp_name)
        os.replace(temp_name, vault_path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return vault_path


def write_json(path: Path, value: dict[str, Any]) -> None:
    atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def run_paths(run_dir: Path) -> tuple[Path, Path, Path, Path]:
    return (
        run_dir / "manifest.json",
        run_dir / "events.jsonl",
        run_dir / "decisions",
        run_dir / "node-registry.json",
    )


def load_run(run_dir: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    manifest_path, _, _, registry_path = run_paths(run_dir)
    if not manifest_path.exists():
        raise DirectorError(f"run is not initialized: {run_dir}")
    return load_json(manifest_path), load_json(registry_path)


def node_index(registry: dict[str, Any]) -> dict[str, dict[str, Any]]:
    nodes = registry.get("nodes")
    if not isinstance(nodes, list):
        raise DirectorError("node registry has no nodes array")
    result: dict[str, dict[str, Any]] = {}
    for item in nodes:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            raise DirectorError("invalid node registry item")
        if item["id"] in result:
            raise DirectorError(f"duplicate node: {item['id']}")
        result[item["id"]] = item
    return result


def artifact_index(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["artifact_id"]: item for item in manifest["artifacts"]}


def event_without_hash(event: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in event.items() if key != "event_hash"}


def append_event(
    run_dir: Path,
    manifest: dict[str, Any],
    event_type: str,
    node_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    _, events_path, _, _ = run_paths(run_dir)
    sequence = manifest["event_count"] + 1
    event = {
        "schema_version": "1.0",
        "sequence": sequence,
        "timestamp": now(),
        "event_type": event_type,
        "node_id": node_id,
        "prev_event_hash": manifest["event_chain_head"],
        "payload": payload,
    }
    event["event_hash"] = sha256_bytes(canonical(event))
    with events_path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n")
    manifest["event_count"] = sequence
    manifest["event_chain_head"] = event["event_hash"]
    manifest["updated_at"] = event["timestamp"]
    return event


def save_manifest(run_dir: Path, manifest: dict[str, Any]) -> None:
    write_json(run_paths(run_dir)[0], manifest)


def validate_event_chain(run_dir: Path, manifest: dict[str, Any]) -> None:
    events_path = run_paths(run_dir)[1]
    previous = ZERO_HASH
    count = 0
    if events_path.exists():
        for line_number, line in enumerate(
            events_path.read_text(encoding="utf-8-sig").splitlines(), start=1
        ):
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError as exc:
                raise DirectorError(f"invalid event JSON at line {line_number}") from exc
            count += 1
            if event.get("sequence") != count:
                raise DirectorError(f"event sequence gap at line {line_number}")
            if event.get("prev_event_hash") != previous:
                raise DirectorError(f"event chain break at line {line_number}")
            claimed = event.get("event_hash")
            actual = sha256_bytes(canonical(event_without_hash(event)))
            if claimed != actual:
                raise DirectorError(f"event hash mismatch at line {line_number}")
            previous = claimed
    if count != manifest["event_count"] or previous != manifest["event_chain_head"]:
        raise DirectorError("manifest event head/count does not match event log")


def validate_artifacts(manifest: dict[str, Any]) -> None:
    ids: set[str] = set()
    index = artifact_index(manifest)
    for artifact in manifest["artifacts"]:
        artifact_id = artifact["artifact_id"]
        if artifact_id in ids:
            raise DirectorError(f"duplicate artifact id: {artifact_id}")
        ids.add(artifact_id)
        path = Path(artifact["path"])
        if not path.is_file():
            raise DirectorError(f"artifact file missing: {artifact_id} -> {path}")
        if sha256_file(path) != artifact["sha256"]:
            raise DirectorError(f"artifact hash changed: {artifact_id}")
        for parent in artifact["parents"]:
            if parent not in index:
                raise DirectorError(f"artifact parent missing: {artifact_id} -> {parent}")


def validate_attempts(manifest: dict[str, Any]) -> None:
    ids: set[str] = set()
    for attempt in manifest.get("attempts", []):
        attempt_id = attempt["attempt_id"]
        if attempt_id in ids:
            raise DirectorError(f"duplicate attempt id: {attempt_id}")
        ids.add(attempt_id)
        path = Path(attempt["path"])
        if not path.is_file():
            raise DirectorError(f"attempt file missing: {attempt_id} -> {path}")
        if sha256_file(path) != attempt["sha256"]:
            raise DirectorError(f"attempt hash changed: {attempt_id}")


def command_init(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir).resolve()
    manifest_path, events_path, decisions_dir, registry_path = run_paths(run_dir)
    if manifest_path.exists() or events_path.exists():
        raise DirectorError(f"run already exists: {run_dir}")
    input_path = Path(args.input).resolve()
    if not input_path.is_file():
        raise DirectorError(f"input file does not exist: {input_path}")
    run_dir.mkdir(parents=True, exist_ok=True)
    decisions_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(REFERENCES / "node-registry.json", registry_path)
    created = now()
    artifact = {
        "artifact_id": "INPUT-v1",
        "artifact_type": "production_brief",
        "node_id": "intake",
        "chapter_id": None,
        "path": str(input_path),
        "sha256": sha256_file(input_path),
        "parents": [],
        "status": "current",
        "accepted": True,
        "created_at": created,
    }
    manifest = {
        "schema_version": "1.0",
        "run_id": args.run_id,
        "story_id": args.story_id,
        "mode": args.mode,
        "status": "initialized",
        "current_node": "outline_design",
        "created_at": created,
        "updated_at": created,
        "registry_sha256": sha256_file(registry_path),
        "event_count": 0,
        "event_chain_head": ZERO_HASH,
        "artifacts": [artifact],
        "attempts": [],
        "decisions": [],
        "delivery_certificate": None,
    }
    append_event(
        run_dir,
        manifest,
        "run_initialized",
        "intake",
        {
            "run_id": args.run_id,
            "story_id": args.story_id,
            "mode": args.mode,
            "input_artifact_id": artifact["artifact_id"],
            "input_sha256": artifact["sha256"],
        },
    )
    save_manifest(run_dir, manifest)
    print(f"OK run={args.run_id} story={args.story_id} status=initialized")


def parse_parents(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def command_register(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir).resolve()
    manifest, registry = load_run(run_dir)
    if manifest["status"] == "delivered":
        raise DirectorError("delivered run is immutable")
    nodes = node_index(registry)
    if args.node not in nodes:
        raise DirectorError(f"unknown node: {args.node}")
    node = nodes[args.node]
    if args.artifact_type not in node["output_types"]:
        raise DirectorError(
            f"node {args.node} cannot output {args.artifact_type}"
        )
    index = artifact_index(manifest)
    if args.artifact_id in index:
        raise DirectorError(f"artifact id already exists: {args.artifact_id}")
    parents = parse_parents(args.parents)
    parent_artifacts = []
    for parent_id in parents:
        parent = index.get(parent_id)
        if parent is None:
            raise DirectorError(f"parent does not exist: {parent_id}")
        if parent["status"] != "current" or not parent["accepted"]:
            raise DirectorError(f"parent is not current and accepted: {parent_id}")
        parent_artifacts.append(parent)
    parent_types = {item["artifact_type"] for item in parent_artifacts}
    missing = set(node["required_input_types"]) - parent_types
    if missing:
        raise DirectorError(
            f"node {args.node} missing direct input types: {sorted(missing)}"
        )
    source_path = Path(args.path).resolve()
    if not source_path.is_file():
        raise DirectorError(f"artifact file does not exist: {source_path}")
    path = snapshot_artifact(run_dir, args.artifact_id, source_path)
    for old in manifest["artifacts"]:
        if (
            old["status"] == "current"
            and old["artifact_type"] == args.artifact_type
            and old.get("chapter_id") == args.chapter_id
        ):
            old["status"] = "superseded"
    artifact = {
        "artifact_id": args.artifact_id,
        "artifact_type": args.artifact_type,
        "node_id": args.node,
        "chapter_id": args.chapter_id,
        "path": str(path),
        "sha256": sha256_file(path),
        "parents": parents,
        "status": "current",
        "accepted": False,
        "created_at": now(),
    }
    manifest["artifacts"].append(artifact)
    manifest["status"] = "active"
    manifest["current_node"] = args.node
    append_event(
        run_dir,
        manifest,
        "artifact_registered",
        args.node,
        {
            "artifact_id": args.artifact_id,
            "artifact_type": args.artifact_type,
            "chapter_id": args.chapter_id,
            "sha256": artifact["sha256"],
            "parents": parents,
            "source_path": str(source_path),
            "vault_path": str(path),
        },
    )
    save_manifest(run_dir, manifest)
    print(f"OK artifact={args.artifact_id} node={args.node} status=current")


def command_accept(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir).resolve()
    manifest, registry = load_run(run_dir)
    nodes = node_index(registry)
    if args.node not in nodes:
        raise DirectorError(f"unknown node: {args.node}")
    artifact = artifact_index(manifest).get(args.artifact_id)
    if artifact is None:
        raise DirectorError(f"artifact does not exist: {args.artifact_id}")
    if artifact["node_id"] != args.node or artifact["status"] != "current":
        raise DirectorError("accepted artifact must be current and belong to node")
    if sha256_file(Path(artifact["path"])) != artifact["sha256"]:
        raise DirectorError("artifact changed before acceptance")
    artifact["accepted"] = True
    manifest["current_node"] = args.node
    if artifact["artifact_type"] == "full_story_audit":
        manifest["status"] = "ready_for_final_review"
    append_event(
        run_dir,
        manifest,
        "node_accepted",
        args.node,
        {"artifact_id": args.artifact_id, "reason": args.reason},
    )
    save_manifest(run_dir, manifest)
    print(f"OK accepted={args.artifact_id} node={args.node}")


def command_attempt(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir).resolve()
    manifest, registry = load_run(run_dir)
    if manifest["status"] == "delivered":
        raise DirectorError("delivered run is immutable")
    nodes = node_index(registry)
    if args.node not in nodes:
        raise DirectorError(f"unknown node: {args.node}")
    attempts = manifest.setdefault("attempts", [])
    if any(item["attempt_id"] == args.attempt_id for item in attempts):
        raise DirectorError(f"attempt id already exists: {args.attempt_id}")
    source_path = Path(args.path).resolve()
    if not source_path.is_file():
        raise DirectorError(f"attempt file does not exist: {source_path}")
    path = snapshot_attempt(run_dir, args.attempt_id, source_path)
    record = {
        "attempt_id": args.attempt_id,
        "node_id": args.node,
        "chapter_id": args.chapter_id,
        "outcome": args.outcome,
        "path": str(path),
        "sha256": sha256_file(path),
        "reason": args.reason,
        "created_at": now(),
    }
    attempts.append(record)
    append_event(
        run_dir,
        manifest,
        "node_attempt_recorded",
        args.node,
        {
            "attempt_id": args.attempt_id,
            "chapter_id": args.chapter_id,
            "outcome": args.outcome,
            "reason": args.reason,
            "sha256": record["sha256"],
            "source_path": str(source_path),
            "vault_path": str(path),
        },
    )
    save_manifest(run_dir, manifest)
    print(f"OK attempt={args.attempt_id} node={args.node} outcome={args.outcome}")


def descendants(manifest: dict[str, Any], root_id: str) -> set[str]:
    children: dict[str, set[str]] = {}
    for artifact in manifest["artifacts"]:
        for parent in artifact["parents"]:
            children.setdefault(parent, set()).add(artifact["artifact_id"])
    found = {root_id}
    queue = [root_id]
    while queue:
        current = queue.pop()
        for child in children.get(current, set()):
            if child not in found:
                found.add(child)
                queue.append(child)
    return found


def command_rollback(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir).resolve()
    manifest, registry = load_run(run_dir)
    decision = load_json(Path(args.decision))
    validate_schema(decision, "rollback-decision.schema.json")
    if any(
        item["decision_id"] == decision["decision_id"]
        for item in manifest["decisions"]
    ):
        raise DirectorError(f"decision already exists: {decision['decision_id']}")
    nodes = node_index(registry)
    discovered = nodes.get(decision["discovered_at_node"])
    if discovered is None or decision["return_node"] not in discovered["allowed_return_targets"]:
        raise DirectorError(
            f"return node {decision['return_node']} is not allowed from "
            f"{decision['discovered_at_node']}"
        )
    index = artifact_index(manifest)
    for key in ("failed_artifact_id", "rollback_root_artifact_id"):
        if decision[key] not in index:
            raise DirectorError(f"decision artifact does not exist: {decision[key]}")
    affected = sorted(descendants(manifest, decision["rollback_root_artifact_id"]))
    for artifact_id in affected:
        index[artifact_id]["status"] = "invalidated"
        index[artifact_id]["accepted"] = False
    record = {
        **decision,
        "status": "open",
        "created_at": now(),
        "resolved_at": None,
        "replacement_artifact_id": None,
        "affected_artifact_ids": affected,
    }
    manifest["decisions"].append(record)
    manifest["status"] = "active"
    manifest["current_node"] = decision["return_node"]
    decisions_dir = run_paths(run_dir)[2]
    write_json(decisions_dir / f"{decision['decision_id']}.json", record)
    append_event(
        run_dir,
        manifest,
        "rollback_issued",
        decision["return_node"],
        {
            "decision_id": decision["decision_id"],
            "failed_artifact_id": decision["failed_artifact_id"],
            "rollback_root_artifact_id": decision["rollback_root_artifact_id"],
            "scope": decision["scope"],
            "affected_artifact_ids": affected,
            "reason": decision["reason"],
        },
    )
    save_manifest(run_dir, manifest)
    print(
        f"OK rollback={decision['decision_id']} return={decision['return_node']} "
        f"invalidated={len(affected)}"
    )


def command_resolve(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir).resolve()
    manifest, _ = load_run(run_dir)
    decision = next(
        (
            item
            for item in manifest["decisions"]
            if item["decision_id"] == args.decision_id
        ),
        None,
    )
    if decision is None or decision["status"] != "open":
        raise DirectorError("decision is not open")
    replacement = artifact_index(manifest).get(args.replacement_artifact_id)
    if replacement is None:
        raise DirectorError("replacement artifact does not exist")
    if replacement["status"] != "current" or not replacement["accepted"]:
        raise DirectorError("replacement must be current and accepted")
    if replacement["created_at"] <= decision["created_at"]:
        raise DirectorError("replacement must be produced after rollback")
    decision["status"] = "resolved"
    decision["resolved_at"] = now()
    decision["replacement_artifact_id"] = args.replacement_artifact_id
    write_json(
        run_paths(run_dir)[2] / f"{decision['decision_id']}.json",
        decision,
    )
    append_event(
        run_dir,
        manifest,
        "rollback_resolved",
        decision["return_node"],
        {
            "decision_id": decision["decision_id"],
            "replacement_artifact_id": args.replacement_artifact_id,
        },
    )
    save_manifest(run_dir, manifest)
    print(
        f"OK resolved={args.decision_id} replacement={args.replacement_artifact_id}"
    )


def command_validate(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir).resolve()
    manifest, registry = load_run(run_dir)
    node_index(registry)
    if sha256_file(run_paths(run_dir)[3]) != manifest["registry_sha256"]:
        raise DirectorError("node registry snapshot changed")
    validate_event_chain(run_dir, manifest)
    validate_artifacts(manifest)
    validate_attempts(manifest)
    print(
        f"OK run={manifest['run_id']} status={manifest['status']} "
        f"artifacts={len(manifest['artifacts'])} attempts={len(manifest.get('attempts', []))} "
        f"events={manifest['event_count']}"
    )


def command_timeline(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir).resolve()
    manifest, _ = load_run(run_dir)
    validate_event_chain(run_dir, manifest)
    lines = [
        f"# Production timeline: {manifest['run_id']}",
        "",
        f"- Story: `{manifest['story_id']}`",
        f"- Status: `{manifest['status']}`",
        f"- Event chain head: `{manifest['event_chain_head']}`",
        "",
        "| # | Time | Node | Event | Detail |",
        "|---:|---|---|---|---|",
    ]
    for line in run_paths(run_dir)[1].read_text(
        encoding="utf-8-sig"
    ).splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        payload = event["payload"]
        detail = (
            payload.get("artifact_id")
            or payload.get("attempt_id")
            or payload.get("decision_id")
            or payload.get("review_id")
            or payload.get("run_id")
            or ""
        )
        lines.append(
            f"| {event['sequence']} | {event['timestamp']} | "
            f"`{event['node_id']}` | `{event['event_type']}` | `{detail}` |"
        )
    atomic_write(Path(args.output), "\n".join(lines) + "\n")
    print(f"OK timeline={args.output} events={manifest['event_count']}")


def command_deliver(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir).resolve()
    manifest, _ = load_run(run_dir)
    if manifest["status"] == "delivered":
        raise DirectorError("delivery certificate already issued")
    if manifest["status"] != "ready_for_final_review":
        raise DirectorError("run is not ready for final review")
    review_path = Path(args.review).resolve()
    review = load_json(review_path)
    validate_schema(review, "final-review.schema.json")
    if review["verdict"] != "pass" or not all(review["checks"].values()):
        raise DirectorError("final review is not an all-green pass")
    open_decisions = [
        item["decision_id"]
        for item in manifest["decisions"]
        if item["status"] == "open"
    ]
    if open_decisions:
        raise DirectorError("open rollback decisions block delivery: " + ", ".join(open_decisions))
    index = artifact_index(manifest)
    final_artifact = index.get(review["final_manuscript_artifact_id"])
    audit_artifact = index.get(review["full_story_audit_artifact_id"])
    for artifact, expected_type in (
        (final_artifact, "final_manuscript"),
        (audit_artifact, "full_story_audit"),
    ):
        if artifact is None:
            raise DirectorError(f"final review references missing {expected_type}")
        if (
            artifact["artifact_type"] != expected_type
            or artifact["status"] != "current"
            or not artifact["accepted"]
        ):
            raise DirectorError(f"{expected_type} is not current and accepted")
    certificate = {
        "schema_version": "1.0",
        "run_id": manifest["run_id"],
        "story_id": manifest["story_id"],
        "review_id": review["review_id"],
        "issued_at": now(),
        "final_manuscript": {
            "artifact_id": final_artifact["artifact_id"],
            "sha256": final_artifact["sha256"],
        },
        "full_story_audit": {
            "artifact_id": audit_artifact["artifact_id"],
            "sha256": audit_artifact["sha256"],
        },
        "event_chain_head": manifest["event_chain_head"],
    }
    certificate["certificate_sha256"] = sha256_bytes(canonical(certificate))
    validate_schema(certificate, "delivery-certificate.schema.json")
    output = Path(args.output).resolve()
    write_json(output, certificate)
    append_event(
        run_dir,
        manifest,
        "delivery_issued",
        "delivery",
        {
            "review_id": review["review_id"],
            "certificate_path": str(output),
            "certificate_sha256": certificate["certificate_sha256"],
        },
    )
    manifest["status"] = "delivered"
    manifest["current_node"] = "delivery"
    manifest["delivery_certificate"] = {
        "path": str(output),
        "sha256": sha256_file(output),
    }
    save_manifest(run_dir, manifest)
    print(
        f"OK delivered run={manifest['run_id']} "
        f"certificate={certificate['certificate_sha256']}"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init")
    init.add_argument("--run-dir", required=True)
    init.add_argument("--run-id", required=True)
    init.add_argument("--story-id", required=True)
    init.add_argument("--mode", choices=("imitation", "original", "rewrite"), required=True)
    init.add_argument("--input", required=True)
    init.set_defaults(func=command_init)

    register = sub.add_parser("register")
    register.add_argument("--run-dir", required=True)
    register.add_argument("--node", required=True)
    register.add_argument("--artifact-id", required=True)
    register.add_argument("--artifact-type", required=True)
    register.add_argument("--path", required=True)
    register.add_argument("--parents")
    register.add_argument("--chapter-id")
    register.set_defaults(func=command_register)

    attempt = sub.add_parser("attempt")
    attempt.add_argument("--run-dir", required=True)
    attempt.add_argument("--node", required=True)
    attempt.add_argument("--attempt-id", required=True)
    attempt.add_argument(
        "--outcome",
        choices=("produced", "blocked", "rejected", "passed"),
        required=True,
    )
    attempt.add_argument("--path", required=True)
    attempt.add_argument("--chapter-id")
    attempt.add_argument("--reason", required=True)
    attempt.set_defaults(func=command_attempt)

    accept = sub.add_parser("accept")
    accept.add_argument("--run-dir", required=True)
    accept.add_argument("--node", required=True)
    accept.add_argument("--artifact-id", required=True)
    accept.add_argument("--reason", required=True)
    accept.set_defaults(func=command_accept)

    rollback = sub.add_parser("rollback")
    rollback.add_argument("--run-dir", required=True)
    rollback.add_argument("--decision", required=True)
    rollback.set_defaults(func=command_rollback)

    resolve = sub.add_parser("resolve")
    resolve.add_argument("--run-dir", required=True)
    resolve.add_argument("--decision-id", required=True)
    resolve.add_argument("--replacement-artifact-id", required=True)
    resolve.set_defaults(func=command_resolve)

    validate = sub.add_parser("validate")
    validate.add_argument("--run-dir", required=True)
    validate.set_defaults(func=command_validate)

    timeline = sub.add_parser("timeline")
    timeline.add_argument("--run-dir", required=True)
    timeline.add_argument("--output", required=True)
    timeline.set_defaults(func=command_timeline)

    deliver = sub.add_parser("deliver")
    deliver.add_argument("--run-dir", required=True)
    deliver.add_argument("--review", required=True)
    deliver.add_argument("--output", required=True)
    deliver.set_defaults(func=command_deliver)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    args.func(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except DirectorError as exc:
        print(f"INVALID: {exc}", file=os.sys.stderr)
        raise SystemExit(2)
