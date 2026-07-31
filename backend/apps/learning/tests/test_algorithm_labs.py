from __future__ import annotations

import json
from unittest.mock import patch

from django.test import TestCase
from django.urls import reverse

from backend.apps.accounts.models import User
from backend.apps.learning.algorithm_labs import (
    ALGORITHM_LAB_COMPLETION_SCHEMA_VERSION,
    ALGORITHM_LAB_SCHEMA_VERSION,
    build_algorithm_lab_effect,
    complete_algorithm_lab,
    list_algorithm_labs,
)
from backend.apps.learning.effect_events import ingest_learning_event_v2
from backend.apps.learning.models import LearningEvent


CPU_FOUNDATION_FINGERPRINT = (
    "a3lab-result.v1|cpu-scheduling|cpu-foundation|1.0.0|"
    "fcfs=cpu:30f71277755e0281d134aa1ca82e049c|"
    "priority=cpu:4aae8cbcb315ec683110dcf7aa793990|"
    "rr=cpu:7a045a7da6352c4488d7a567d0ff26c2|"
    "sjf=cpu:7958460a04842ebeb1e53aebf42d471a"
)


def known_cpu_completion(event_id="lab-event-1", **overrides):
    payload = {
        "schemaVersion": ALGORITHM_LAB_COMPLETION_SCHEMA_VERSION,
        "eventId": event_id,
        "labId": "cpu-scheduling",
        "labVersion": "1.0.0",
        "presetId": "cpu-foundation",
        "presetVersion": "1.0.0",
        "customInput": False,
        "selectedAlgorithms": ["fcfs", "sjf", "priority", "rr"],
        "prediction": {"answer": "SJF", "skipped": False, "correct": True},
        "checkpoints": {
            "answered": 4,
            "correct": 4,
            "items": [{"id": f"checkpoint-{index}", "correct": True} for index in range(4)],
        },
        "metrics": {
            "score": 75,
            "durationSec": 32,
            "replayCount": 1,
            "reviewedStepIndexes": [0, 3],
        },
        "resultFingerprint": CPU_FOUNDATION_FINGERPRINT,
    }
    payload.update(overrides)
    return payload


class AlgorithmLabApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800004001", password="TestPassword123")
        self.other = User.objects.create_user(phone="13800004002", password="TestPassword123")

    def post_complete(self, payload):
        return self.client.post(
            reverse("learning-algorithm-labs-complete"),
            data=json.dumps(payload),
            content_type="application/json",
        )

    def test_endpoints_require_login(self):
        self.assertEqual(self.client.get(reverse("learning-algorithm-labs")).status_code, 401)
        self.assertEqual(self.post_complete(known_cpu_completion()).status_code, 401)

    def test_catalog_has_exactly_two_labs_and_does_not_leak_fingerprints(self):
        self.client.force_login(self.user)

        response = self.client.get(reverse("learning-algorithm-labs"))

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["schemaVersion"], ALGORITHM_LAB_SCHEMA_VERSION)
        self.assertEqual([lab["id"] for lab in payload["labs"]], ["cpu-scheduling", "page-replacement"])
        self.assertTrue(all(lab["version"] == "1.0.0" for lab in payload["labs"]))
        self.assertNotIn("resultFingerprint", json.dumps(payload))
        self.assertNotIn("expected", json.dumps(payload).lower())
        self.assertEqual(payload["labs"][0]["algorithms"], ["fcfs", "sjf", "priority", "rr"])
        self.assertEqual(payload["labs"][1]["algorithms"], ["fifo", "lru", "opt"])
        self.assertEqual(payload["labs"][0]["progress"], {
            "completed": False,
            "bestScore": 0,
            "lastCompletedAt": None,
            "verifiedRuns": 0,
        })
        self.assertIsNone(payload["labs"][0]["recentSession"])

    def test_list_algorithm_labs_returns_catalog_contract(self):
        catalog = list_algorithm_labs(self.user)

        self.assertEqual(catalog["schemaVersion"], ALGORITHM_LAB_SCHEMA_VERSION)
        self.assertEqual([lab["id"] for lab in catalog["labs"]], ["cpu-scheduling", "page-replacement"])

    def test_catalog_progress_and_recent_session_are_scoped_to_user(self):
        self.client.force_login(self.user)
        self.assertEqual(self.post_complete(known_cpu_completion()).status_code, 201)
        self.client.force_login(self.other)
        self.assertEqual(self.post_complete(known_cpu_completion("other-event")).status_code, 201)

        response = self.client.get(reverse("learning-algorithm-labs"))
        lab = response.json()["labs"][0]

        self.assertTrue(lab["progress"]["completed"])
        self.assertEqual(lab["progress"]["verifiedRuns"], 1)
        self.assertEqual(lab["recentSession"]["eventId"], "other-event")

    def test_known_completion_is_verified_and_persists_compact_event_fields(self):
        self.client.force_login(self.user)

        response = self.post_complete(known_cpu_completion())

        self.assertEqual(response.status_code, 201)
        completion = response.json()["completion"]
        self.assertTrue(completion["verified"])
        self.assertTrue(completion["masteryEvidenceAccepted"])
        self.assertEqual(completion["nextAction"]["type"], "assessment")
        event = LearningEvent.objects.get(user=self.user, event_id="lab-event-1")
        self.assertEqual(event.event_type, "algorithm_lab_completed")
        self.assertEqual(event.target_type, "algorithm_lab")
        self.assertEqual(event.target_id, "cpu-scheduling")
        self.assertEqual(event.resource_type, "interactive_lab")
        self.assertEqual(event.source_page, "/a3/labs/cpu-scheduling")
        self.assertEqual(event.schema_version, "a3.learning-event.v2")
        self.assertEqual(event.score, 100)
        self.assertNotIn("steps", event.metadata)
        self.assertNotIn("items", event.metadata)
        self.assertEqual(event.metadata["metrics"]["reviewedStepIndexes"], [0, 3])
        self.assertEqual(event.quality["verified"], True)

    def test_completion_locks_the_current_user_before_idempotent_write(self):
        with patch.object(User.objects, "select_for_update", wraps=User.objects.select_for_update) as row_lock:
            first = complete_algorithm_lab(self.user, known_cpu_completion("locked-event"))
            duplicate = complete_algorithm_lab(self.user, known_cpu_completion("locked-event"))

        self.assertEqual(first["status"], "accepted")
        self.assertEqual(duplicate["status"], "duplicate")
        self.assertEqual(row_lock.call_count, 2)
        self.assertEqual(LearningEvent.objects.filter(user=self.user, event_id="locked-event").count(), 1)

    def test_generic_completion_cannot_forge_verified_lab_evidence(self):
        self.client.force_login(self.user)

        response = self.client.post(
            reverse("learning-events-ingest"),
            data=json.dumps(
                {
                    "schemaVersion": "a3.learning-event.v2",
                    "eventId": "forged-generic-completion",
                    "eventType": "algorithm_lab_completed",
                    "targetType": "algorithm_lab",
                    "targetId": "cpu-scheduling",
                    "quality": {"verified": True, "masteryEvidenceAccepted": True},
                    "metadata": {"labVersion": "1.0.0"},
                }
            ),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["success"])
        self.assertFalse(list_algorithm_labs(self.user)["labs"][0]["progress"]["completed"])
        self.assertEqual(list_algorithm_labs(self.user)["labs"][0]["progress"]["verifiedRuns"], 0)
        self.assertFalse(LearningEvent.objects.filter(user=self.user, event_id="forged-generic-completion").exists())

    def test_event_id_collision_with_another_operation_returns_conflict(self):
        self.client.force_login(self.user)
        started = ingest_learning_event_v2(
            self.user,
            {
                "schemaVersion": "a3.learning-event.v2",
                "eventId": "operation-collision",
                "eventType": "algorithm_lab_started",
                "targetType": "algorithm_lab",
                "targetId": "cpu-scheduling",
            },
        )

        response = self.post_complete(known_cpu_completion("operation-collision"))

        self.assertEqual(started["status"], "accepted")
        self.assertEqual(response.status_code, 409)
        self.assertFalse(response.json()["success"])
        self.assertEqual(LearningEvent.objects.filter(user=self.user, event_id="operation-collision").count(), 1)

    def test_checkpoint_summaries_must_match_validated_items(self):
        self.client.force_login(self.user)
        payload = known_cpu_completion(
            checkpoints={
                "answered": 4,
                "correct": 4,
                "items": [{"id": f"checkpoint-{index}", "correct": False} for index in range(4)],
            }
        )

        response = self.post_complete(payload)

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["success"])
        self.assertFalse(LearningEvent.objects.filter(user=self.user, event_id="lab-event-1").exists())

    def test_verified_prediction_correctness_is_computed_server_side(self):
        self.client.force_login(self.user)
        response = self.post_complete(
            known_cpu_completion(
                "forged-prediction",
                prediction={"answer": "rr", "skipped": False, "correct": True},
            )
        )

        self.assertEqual(response.status_code, 201)
        event = LearningEvent.objects.get(user=self.user, event_id="forged-prediction")
        self.assertTrue(event.quality["verified"])
        self.assertFalse(event.metadata["prediction"]["correct"])
        self.assertEqual(build_algorithm_lab_effect(self.user)["prediction"], {"answered": 1, "correct": 0})

    def test_custom_and_forged_submissions_are_accepted_but_unverified(self):
        self.client.force_login(self.user)
        custom = known_cpu_completion(
            "custom-event", customInput=True, presetId="", presetVersion="", resultFingerprint="custom-run"
        )
        forged = known_cpu_completion("forged-event", resultFingerprint="not-the-expected-fingerprint")

        custom_response = self.post_complete(custom)
        forged_response = self.post_complete(forged)

        self.assertEqual(custom_response.status_code, 201)
        self.assertFalse(custom_response.json()["completion"]["verified"])
        self.assertEqual(forged_response.status_code, 201)
        self.assertFalse(forged_response.json()["completion"]["verified"])
        self.assertEqual(forged_response.json()["completion"]["nextAction"]["type"], "replay_lab")
        custom_event = LearningEvent.objects.get(user=self.user, event_id="custom-event")
        self.assertNotIn("correct", custom_event.metadata["prediction"])
        self.assertEqual(build_algorithm_lab_effect(self.user)["prediction"], {"answered": 0, "correct": 0})

    def test_duplicate_is_stable_and_same_event_id_is_independent_between_users(self):
        self.client.force_login(self.user)
        first = self.post_complete(known_cpu_completion("shared-event"))
        second = self.post_complete(known_cpu_completion("shared-event", resultFingerprint="forged"))
        self.client.force_login(self.other)
        other = self.post_complete(known_cpu_completion("shared-event"))

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["status"], "duplicate")
        self.assertEqual(second.json()["completion"], first.json()["completion"])
        self.assertEqual(other.status_code, 201)
        self.assertEqual(LearningEvent.objects.filter(event_id="shared-event").count(), 2)

    def test_validation_rejects_bounds_unknown_algorithms_oversized_lists_and_steps(self):
        self.client.force_login(self.user)
        invalid_payloads = [
            None,
            known_cpu_completion(schemaVersion="wrong"),
            known_cpu_completion(eventId=" "),
            known_cpu_completion(eventId="x" * 129),
            known_cpu_completion(labId="missing"),
            known_cpu_completion(customInput="false"),
            known_cpu_completion(selectedAlgorithms=[]),
            known_cpu_completion(selectedAlgorithms=["fcfs", "fcfs"]),
            known_cpu_completion(selectedAlgorithms=["fcfs", "unknown"]),
            known_cpu_completion(selectedAlgorithms=["fcfs", "sjf", "priority", "rr", "fcfs"]),
            known_cpu_completion(presetVersion="9.0.0"),
            known_cpu_completion(prediction={"answer": "x" * 33, "skipped": False}),
            known_cpu_completion(checkpoints={"answered": 2, "correct": 3, "items": []}),
            known_cpu_completion(checkpoints={"answered": 21, "correct": 1, "items": []}),
            known_cpu_completion(checkpoints={"answered": 1, "correct": 1, "items": [{"id": "x" * 65, "correct": True}]}),
            known_cpu_completion(metrics={"score": 101, "durationSec": 1, "replayCount": 0, "reviewedStepIndexes": []}),
            known_cpu_completion(metrics={"score": float("nan"), "durationSec": 1, "replayCount": 0, "reviewedStepIndexes": []}),
            known_cpu_completion(metrics={"score": 1, "durationSec": 86401, "replayCount": 0, "reviewedStepIndexes": []}),
            known_cpu_completion(metrics={"score": 1, "durationSec": 1, "replayCount": 101, "reviewedStepIndexes": []}),
            known_cpu_completion(metrics={"score": 1, "durationSec": 1, "replayCount": 0, "reviewedStepIndexes": [1, 1]}),
            known_cpu_completion(resultFingerprint=" "),
            known_cpu_completion(steps=[{"large": "not allowed"}]),
        ]

        for payload in invalid_payloads:
            response = self.post_complete(payload)
            self.assertEqual(response.status_code, 400, payload)
            self.assertFalse(response.json()["success"])

    def test_page_algorithm_bound_and_no_steps_persisted(self):
        self.client.force_login(self.user)
        invalid = known_cpu_completion(
            "page-invalid",
            labId="page-replacement",
            selectedAlgorithms=["fifo", "lru", "opt", "fifo"],
            presetId="page-foundation",
            resultFingerprint="forged",
        )
        self.assertEqual(self.post_complete(invalid).status_code, 400)

        response = self.post_complete(known_cpu_completion("no-steps"))
        event = LearningEvent.objects.get(user=self.user, event_id="no-steps")
        self.assertEqual(response.status_code, 201)
        self.assertNotIn("steps", json.dumps({"quality": event.quality, "metadata": event.metadata}))

    def test_validation_rejects_more_than_twenty_checkpoint_items(self):
        self.client.force_login(self.user)
        payload = known_cpu_completion(
            checkpoints={
                "answered": 20,
                "correct": 20,
                "items": [{"id": f"checkpoint-{index}", "correct": True} for index in range(21)],
            }
        )

        response = self.post_complete(payload)

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["success"])

    def test_validation_rejects_more_than_fifty_reviewed_step_indexes(self):
        self.client.force_login(self.user)
        payload = known_cpu_completion(
            metrics={"score": 75, "durationSec": 1, "replayCount": 0, "reviewedStepIndexes": list(range(51))}
        )

        response = self.post_complete(payload)

        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["success"])

    def test_event_allowlist_keeps_algorithm_lab_started_and_checkpoint_events(self):
        for event_type in ("algorithm_lab_started", "algorithm_lab_checkpoint_submitted"):
            result = ingest_learning_event_v2(
                self.user,
                {
                    "schemaVersion": "a3.learning-event.v2",
                    "eventId": f"generic-{event_type}",
                    "eventType": event_type,
                    "sourcePage": "/a3/labs/cpu-scheduling",
                },
            )

            self.assertEqual(result["status"], "accepted")

    def test_effect_aggregation_empty_and_populated(self):
        self.assertEqual(
            build_algorithm_lab_effect(self.user),
            {
                "schemaVersion": "a3.algorithm-lab.effect.v1",
                "timeWindowDays": 30,
                "completed": 0,
                "verified": 0,
                "prediction": {"answered": 0, "correct": 0},
                "checkpoints": {"answered": 0, "correct": 0},
                "reviewed": 0,
                "byLab": [],
            },
        )
        self.client.force_login(self.user)
        self.post_complete(known_cpu_completion())
        self.post_complete(known_cpu_completion("forged-effect", resultFingerprint="forged"))

        effect = build_algorithm_lab_effect(self.user)

        self.assertEqual(effect["completed"], 2)
        self.assertEqual(effect["verified"], 1)
        self.assertEqual(effect["prediction"], {"answered": 1, "correct": 1})
        self.assertEqual(effect["checkpoints"], {"answered": 8, "correct": 8})
        self.assertEqual(effect["reviewed"], 4)
        self.assertEqual(effect["byLab"][0]["labId"], "cpu-scheduling")
        self.assertEqual(effect["byLab"][0]["verified"], 1)
