from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone as datetime_timezone
from pathlib import Path
from typing import Any

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from backend.apps.notes.models import NoteMemory
from backend.apps.notes.services.memory_service import select_memories


DATASET_PATH = Path(__file__).resolve().parents[2] / "evals" / "long_memory_cases.jsonl"
FIXED_NOW = datetime(2026, 8, 3, 12, 0, tzinfo=datetime_timezone.utc)
THRESHOLDS = {
    "selectionPrecision": 0.90,
    "selectionRecall": 0.85,
    "abstentionAccuracy": 0.90,
    "updateConsistency": 1.0,
    "deletionConsistency": 1.0,
    "crossUserLeakage": 0,
}
UPDATE_CATEGORIES = {"temporal_update", "preference_correction", "supersede"}


class Command(BaseCommand):
    help = "Evaluate personal-note memory selection with fixed LongMemEval-style cases."

    def add_arguments(self, parser) -> None:
        parser.add_argument("--offline", action="store_true", help="Run deterministic selection without a model call.")
        parser.add_argument("--with-model", action="store_true", help="Reserve an optional final-answer evaluation slot.")
        parser.add_argument("--strict", action="store_true", help="Exit non-zero when any required threshold fails.")
        parser.add_argument("--dataset", type=Path, default=DATASET_PATH)
        parser.add_argument("--output", type=Path)

    def handle(self, *args, **options):
        dataset_path: Path = options["dataset"]
        cases = load_cases(dataset_path)
        if not cases:
            raise CommandError("Memory evaluation dataset is empty.")

        outcomes = [evaluate_case(case, index) for index, case in enumerate(cases)]
        artifact = build_artifact(cases, outcomes, with_model=bool(options["with_model"]))
        rendered = json.dumps(artifact, ensure_ascii=False, indent=2, sort_keys=True)
        output_path: Path | None = options.get("output")
        if output_path:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(rendered + "\n", encoding="utf-8")
        self.stdout.write(rendered)
        if options["strict"] and not artifact["passed"]:
            raise CommandError("Personal-note memory evaluation failed strict thresholds.")


def load_cases(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise CommandError(f"Memory evaluation dataset does not exist: {path}")
    cases: list[dict[str, Any]] = []
    seen: set[str] = set()
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            case = json.loads(line)
        except json.JSONDecodeError as exc:
            raise CommandError(f"Invalid JSONL at line {line_number}.") from exc
        case_id = str(case.get("id") or "").strip()
        if not case_id or case_id in seen:
            raise CommandError(f"Missing or duplicate case id at line {line_number}.")
        if not isinstance(case.get("memories"), list) or not isinstance(case.get("expectedSelectedIds"), list):
            raise CommandError(f"Invalid memory case schema at line {line_number}.")
        seen.add(case_id)
        cases.append(case)
    return cases


def evaluate_case(case: dict[str, Any], index: int) -> dict[str, Any]:
    user_model = get_user_model()
    selected_symbols: list[str] = []
    selected_owners: list[str] = []
    with transaction.atomic():
        try:
            user = user_model.objects.create_user(phone=f"139{index:08d}", password=None)
            foreign = user_model.objects.create_user(phone=f"137{index:08d}", password=None)
            owners = {"current": user, "foreign": foreign}
            id_map: dict[str, uuid.UUID] = {}
            owner_map: dict[str, str] = {}
            for memory_spec in case["memories"]:
                symbol = str(memory_spec["id"])
                memory_id = uuid.uuid5(uuid.NAMESPACE_URL, f"a3-memory-eval:{case['id']}:{symbol}")
                id_map[symbol] = memory_id
                owner_map[symbol] = str(memory_spec.get("owner") or "current")
                owner = owners[owner_map[symbol]]
                status = str(memory_spec.get("status") or NoteMemory.Status.CONFIRMED)
                valid_from = FIXED_NOW + timedelta(days=float(memory_spec.get("validFromDays", -30)))
                valid_until_days = memory_spec.get("validUntilDays")
                valid_until = FIXED_NOW + timedelta(days=float(valid_until_days)) if valid_until_days is not None else None
                confirmed_at = FIXED_NOW - timedelta(days=30) if status == NoteMemory.Status.CONFIRMED else None
                NoteMemory.objects.create(
                    id=memory_id,
                    user=owner,
                    memory_type=str(memory_spec.get("memoryType") or NoteMemory.MemoryType.CORE),
                    content=str(memory_spec.get("content") or f"Synthetic memory {symbol}"),
                    status=status,
                    importance=float(memory_spec.get("importance", 3)),
                    confidence=float(memory_spec.get("confidence", 0.9)),
                    source_note_refs=[
                        {"id": str(note_id), "version": 1}
                        for note_id in memory_spec.get("sourceNoteIds", [])
                    ],
                    valid_from=valid_from,
                    valid_until=valid_until,
                    confirmed_at=confirmed_at,
                    deleted_at=FIXED_NOW if status == NoteMemory.Status.DELETED else None,
                )
                created_days = float(memory_spec.get("createdDaysAgo", 1))
                updated_days = float(memory_spec.get("updatedDaysAgo", created_days))
                NoteMemory.objects.filter(id=memory_id).update(
                    created_at=FIXED_NOW - timedelta(days=created_days),
                    updated_at=FIXED_NOW - timedelta(days=updated_days),
                )
            for memory_spec in case["memories"]:
                replacement_symbol = memory_spec.get("supersededById")
                if replacement_symbol:
                    NoteMemory.objects.filter(id=id_map[str(memory_spec["id"])]).update(
                        superseded_by_id=id_map[str(replacement_symbol)]
                    )
            reverse_ids = {str(value): key for key, value in id_map.items()}
            selected = select_memories(
                user=user,
                query=str(case.get("query") or ""),
                scope_note_ids=[str(item) for item in case.get("scopeNoteIds", [])],
                now=FIXED_NOW,
            )
            selected_symbols = [reverse_ids[str(item.id)] for item in selected]
            selected_owners = [owner_map[symbol] for symbol in selected_symbols]
        finally:
            transaction.set_rollback(True)
    expected = [str(item) for item in case["expectedSelectedIds"]]
    return {
        "caseId": str(case["id"]),
        "category": str(case.get("category") or "recall"),
        "expected": expected,
        "selected": selected_symbols,
        "foreignSelections": selected_owners.count("foreign"),
        "expectedAbstention": bool(case.get("expectedAbstention", not expected)),
    }


def build_artifact(cases: list[dict[str, Any]], outcomes: list[dict[str, Any]], *, with_model: bool) -> dict[str, Any]:
    true_positive = false_positive = false_negative = 0
    abstention_total = abstention_correct = 0
    update_total = update_correct = 0
    deletion_total = deletion_correct = 0
    leakage = 0
    failures: list[dict[str, Any]] = []
    for outcome in outcomes:
        expected = set(outcome["expected"])
        selected = set(outcome["selected"])
        true_positive += len(expected & selected)
        false_positive += len(selected - expected)
        false_negative += len(expected - selected)
        exact = expected == selected
        if outcome["expectedAbstention"]:
            abstention_total += 1
            abstention_correct += int(not selected)
        if outcome["category"] in UPDATE_CATEGORIES:
            update_total += 1
            update_correct += int(exact)
        if outcome["category"] == "deletion":
            deletion_total += 1
            deletion_correct += int(exact)
        leakage += outcome["foreignSelections"]
        if not exact or outcome["foreignSelections"]:
            failures.append(
                {
                    "caseId": outcome["caseId"],
                    "category": outcome["category"],
                    "missingIds": sorted(expected - selected),
                    "unexpectedIds": sorted(selected - expected),
                    "foreignSelections": outcome["foreignSelections"],
                }
            )
    metrics = {
        "selectionPrecision": ratio(true_positive, true_positive + false_positive),
        "selectionRecall": ratio(true_positive, true_positive + false_negative),
        "abstentionAccuracy": ratio(abstention_correct, abstention_total),
        "updateConsistency": ratio(update_correct, update_total),
        "deletionConsistency": ratio(deletion_correct, deletion_total),
        "crossUserLeakage": leakage,
    }
    checks = {
        key: (metrics[key] == threshold if key in {"updateConsistency", "deletionConsistency", "crossUserLeakage"} else metrics[key] >= threshold)
        for key, threshold in THRESHOLDS.items()
    }
    return {
        "schemaVersion": 1,
        "mode": "offline",
        "dataset": {"name": "long_memory_cases", "caseCount": len(cases)},
        "metrics": metrics,
        "thresholds": THRESHOLDS,
        "checks": checks,
        "passed": all(checks.values()),
        "failures": failures,
        "modelEvaluation": {
            "status": "skipped",
            "reasonCode": "deterministic_gate_only" if with_model else "not_requested",
        },
    }


def ratio(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 6) if denominator else 1.0
