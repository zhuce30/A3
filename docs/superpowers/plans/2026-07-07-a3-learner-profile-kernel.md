# A3 Learner Profile Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade A3 learner profiles from simple extracted fields into a traceable learner-model kernel that drives planning, recommendations, practice, tutoring, reports, and later UI evidence.

**Architecture:** Keep `LearnerProfile` and current API contracts compatible, but introduce a profile signal layer and an aggregation service. All workflows write profile signals with source, confidence, evidence, and trace metadata; a single aggregator builds the current profile snapshot consumed by downstream agents and frontend views.

**Tech Stack:** Django models/services/tests, existing `AgentKernel`, existing `LearnerProfile.extra_profile`, Next.js A3 frontend, Vitest for frontend source checks.

---

## File Structure

Backend kernel first:

- Create `backend/apps/profiles/profile_signals.py`: value normalization, signal append helpers, signal schema constants.
- Create `backend/apps/profiles/profile_aggregator.py`: deterministic aggregation from stable profile fields plus `extra_profile.profileSignals` into `dynamicProfileV2` and `profileSnapshot`.
- Modify `backend/apps/profiles/dynamic_profile.py`: keep existing `dynamicProfile` v1, add bridge helpers to include v2 without breaking existing tests.
- Modify `backend/apps/profiles/services.py`: return `profileSnapshot`, `profileReadinessV2`, and consume aggregator after profile save/extract.
- Modify `backend/apps/compat/profile_interview.py`: write structured signals during interview commit instead of only writing final fields.
- Modify `backend/apps/compat/agent_kernel.py`: assessment and diagnostic profile updates append signals, then aggregate.
- Modify `backend/apps/learning/services.py`: admission diagnostic and daily task completion append signals.
- Modify `backend/apps/compat/resource_generation.py`: OpenMAIC interaction/resource feedback append resource effectiveness signals.
- Test `backend/apps/profiles/tests/test_profile_kernel.py`: aggregation, confidence, conflict handling, snapshot shape.
- Extend `backend/apps/compat/tests/test_a3_requirements_deep_fill.py`: interview/assessment/diagnostic learning events now also emit profile signals.
- Extend `backend/apps/assessments/tests/test_assessment_flow.py`: wrong answer updates weak-point signals and snapshot.

Frontend second:

- Modify `OpenMAIC/lib/a3/auth-types.ts`: add `profileSnapshot` and evidence types.
- Modify `OpenMAIC/components/a3/profile/dynamic-profile-insight-panel.tsx`: show snapshot dimensions, source, confidence, stale/missing state.
- Modify `OpenMAIC/components/a3/auth/a3-auth-pages.tsx`: show extraction evidence and targeted follow-up reasons; fix visible Chinese copy touched in this flow.
- Add/extend `OpenMAIC/tests/a3-profile-kernel-snapshot.test.ts`: source-level API/type/UI evidence checks.

## Phase 1: Backend Profile Kernel

### Task 1: Add Profile Signal Helpers

**Files:**
- Create: `backend/apps/profiles/profile_signals.py`
- Test: `backend/apps/profiles/tests/test_profile_kernel.py`

- [ ] **Step 1: Write failing tests for signal append and clipping**

Add this test file:

```python
from django.test import TestCase

from backend.apps.accounts.models import User
from backend.apps.profiles.models import LearnerProfile
from backend.apps.profiles.profile_signals import append_profile_signal, profile_signals


class ProfileKernelTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13900000001", password="Demo@123456")
        self.profile = LearnerProfile.objects.create(user=self.user)

    def test_append_profile_signal_records_source_confidence_and_evidence(self):
        signal = append_profile_signal(
            self.profile,
            dimension="weakPoints",
            value=["根轨迹"],
            source="assessment_wrong_answer",
            confidence=0.88,
            evidence={"questionId": "q-1", "errorCause": "符号方向混淆"},
            trace_id="trace-001",
            weight=0.9,
        )

        self.profile.refresh_from_db()
        signals = profile_signals(self.profile)

        self.assertEqual(signal["schemaVersion"], "a3.profile-signal.v1")
        self.assertEqual(signals[0]["dimension"], "weakPoints")
        self.assertEqual(signals[0]["source"], "assessment_wrong_answer")
        self.assertEqual(signals[0]["confidence"], 0.88)
        self.assertEqual(signals[0]["evidence"]["errorCause"], "符号方向混淆")
        self.assertEqual(signals[0]["traceId"], "trace-001")

    def test_profile_signals_are_limited_to_latest_120_items(self):
        for index in range(130):
            append_profile_signal(
                self.profile,
                dimension="learningPace",
                value="standard",
                source="today_task",
                confidence=0.5,
                evidence={"index": index},
                save=False,
            )
        self.profile.save(update_fields=["extra_profile", "updated_at"])

        self.profile.refresh_from_db()
        signals = profile_signals(self.profile)

        self.assertEqual(len(signals), 120)
        self.assertEqual(signals[0]["evidence"]["index"], 129)
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_profile_kernel.ProfileKernelTests
```

Expected: import error for `backend.apps.profiles.profile_signals`.

- [ ] **Step 3: Implement signal helpers**

Create `backend/apps/profiles/profile_signals.py`:

```python
from __future__ import annotations

from typing import Any

from django.utils import timezone

from backend.apps.profiles.models import LearnerProfile


PROFILE_SIGNAL_SCHEMA_VERSION = "a3.profile-signal.v1"
PROFILE_SIGNAL_LIMIT = 120


def profile_signals(profile: LearnerProfile) -> list[dict]:
    extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    signals = extra.get("profileSignals")
    return [item for item in signals if isinstance(item, dict)] if isinstance(signals, list) else []


def append_profile_signal(
    profile: LearnerProfile,
    *,
    dimension: str,
    value: Any,
    source: str,
    confidence: float,
    evidence: dict | None = None,
    trace_id: str = "",
    weight: float = 1.0,
    observed_at: str = "",
    save: bool = True,
) -> dict:
    extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    current = [item for item in extra.get("profileSignals", []) if isinstance(item, dict)]
    signal = {
        "schemaVersion": PROFILE_SIGNAL_SCHEMA_VERSION,
        "dimension": str(dimension or "")[:64],
        "value": _json_safe_value(value),
        "source": str(source or "")[:80],
        "confidence": _bounded_float(confidence),
        "weight": _bounded_float(weight),
        "evidence": evidence if isinstance(evidence, dict) else {},
        "traceId": str(trace_id or "")[:120],
        "observedAt": str(observed_at or timezone.now().isoformat()),
        "createdAt": timezone.now().isoformat(),
    }
    extra["profileSignals"] = [signal, *current][:PROFILE_SIGNAL_LIMIT]
    profile.extra_profile = extra
    if save:
        profile.save(update_fields=["extra_profile", "updated_at"])
    return signal


def _bounded_float(value: float) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = 0.0
    return round(max(0.0, min(numeric, 1.0)), 3)


def _json_safe_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key)[:80]: _json_safe_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe_value(item) for item in value[:20]]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)
```

- [ ] **Step 4: Run test to verify it passes**

Run same command. Expected: 2 tests pass.

### Task 2: Add Profile Aggregator and Snapshot

**Files:**
- Create: `backend/apps/profiles/profile_aggregator.py`
- Modify: `backend/apps/profiles/tests/test_profile_kernel.py`

- [ ] **Step 1: Add failing aggregation tests**

Append tests:

```python
from backend.apps.profiles.profile_aggregator import aggregate_profile_snapshot


class ProfileAggregatorTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13900000002", password="Demo@123456")
        self.profile = LearnerProfile.objects.create(
            user=self.user,
            grade="大二",
            major_direction="自动化专业",
            foundation_level="基础一般",
            daily_study_time=60,
            pace="standard",
            learning_goals=["掌握自动控制原理"],
            weak_points=["根轨迹"],
            expected_resources=["例题推导"],
        )

    def test_aggregator_builds_snapshot_with_dimension_evidence(self):
        append_profile_signal(
            self.profile,
            dimension="weakPoints",
            value=["频率响应"],
            source="admission_diagnostic",
            confidence=0.9,
            evidence={"score": 62},
            trace_id="diag-001",
        )

        snapshot = aggregate_profile_snapshot(self.profile)

        self.assertEqual(snapshot["schemaVersion"], "a3.profile-snapshot.v1")
        self.assertIn("频率响应", snapshot["dimensions"]["weakPoints"]["value"])
        self.assertEqual(snapshot["dimensions"]["weakPoints"]["sources"][0]["source"], "admission_diagnostic")
        self.assertGreaterEqual(snapshot["readiness"]["score"], 80)

    def test_aggregator_preserves_stable_user_fields_over_behavior_signals(self):
        append_profile_signal(
            self.profile,
            dimension="dailyStudyTime",
            value=180,
            source="today_task_delay",
            confidence=0.4,
            evidence={"reason": "single delayed day"},
        )

        snapshot = aggregate_profile_snapshot(self.profile)

        self.assertEqual(snapshot["dimensions"]["dailyStudyTime"]["value"], 60)
        self.assertEqual(snapshot["dimensions"]["dailyStudyTime"]["basis"], "stable_profile_field")
```

- [ ] **Step 2: Run test to verify it fails**

Expected: import error for `profile_aggregator`.

- [ ] **Step 3: Implement aggregator**

Create `backend/apps/profiles/profile_aggregator.py`:

```python
from __future__ import annotations

from collections import defaultdict
from typing import Any

from django.utils import timezone

from backend.apps.profiles.models import LearnerProfile
from backend.apps.profiles.profile_signals import profile_signals


PROFILE_SNAPSHOT_SCHEMA_VERSION = "a3.profile-snapshot.v1"

STABLE_DIMENSIONS = {
    "grade": "grade",
    "majorDirection": "major_direction",
    "foundationLevel": "foundation_level",
    "dailyStudyTime": "daily_study_time",
    "pace": "pace",
    "learningGoals": "learning_goals",
    "weakPoints": "weak_points",
    "resourcePreferences": "expected_resources",
}


def aggregate_profile_snapshot(profile: LearnerProfile, *, save: bool = True) -> dict:
    signals = profile_signals(profile)
    grouped: dict[str, list[dict]] = defaultdict(list)
    for signal in signals:
        dimension = str(signal.get("dimension") or "")
        if dimension:
            grouped[dimension].append(signal)

    dimensions = {
        "grade": _stable_dimension(profile.grade, "grade"),
        "majorDirection": _stable_dimension(profile.major_direction, "majorDirection"),
        "foundationLevel": _stable_dimension(_best_scalar(profile.foundation_level, grouped["foundationLevel"]), "foundationLevel"),
        "dailyStudyTime": _stable_dimension(profile.daily_study_time, "dailyStudyTime"),
        "pace": _stable_dimension(profile.pace, "pace"),
        "learningGoals": _list_dimension(profile.learning_goals, grouped["learningGoals"], "learningGoals"),
        "weakPoints": _list_dimension(profile.weak_points, grouped["weakPoints"], "weakPoints"),
        "resourcePreferences": _list_dimension(profile.expected_resources, grouped["resourcePreferences"], "resourcePreferences"),
        "mistakePatterns": _list_dimension([], grouped["mistakePatterns"], "mistakePatterns"),
        "motivationRisk": _signal_scalar_dimension(grouped["motivationRisk"], "motivationRisk"),
        "learningPace": _signal_scalar_dimension(grouped["learningPace"], "learningPace"),
        "resourceEffectiveness": _list_dimension([], grouped["resourceEffectiveness"], "resourceEffectiveness"),
    }
    readiness = _readiness(dimensions)
    snapshot = {
        "schemaVersion": PROFILE_SNAPSHOT_SCHEMA_VERSION,
        "dimensions": dimensions,
        "readiness": readiness,
        "signalSummary": {
            "total": len(signals),
            "bySource": _count_by(signals, "source"),
            "latestAt": str(signals[0].get("createdAt") or "") if signals else "",
        },
        "updatedAt": timezone.now().isoformat(),
    }
    if save:
        extra = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
        extra["profileSnapshot"] = snapshot
        extra["dynamicProfileV2"] = snapshot
        profile.extra_profile = extra
        profile.save(update_fields=["extra_profile", "updated_at"])
    return snapshot


def _stable_dimension(value: Any, dimension: str) -> dict:
    return {
        "value": value,
        "confidence": 1.0 if _has_value(value) else 0.0,
        "basis": "stable_profile_field",
        "sources": [],
        "missing": not _has_value(value),
        "dimension": dimension,
    }


def _list_dimension(stable_values: Any, signals: list[dict], dimension: str) -> dict:
    values: list[str] = []
    for item in stable_values if isinstance(stable_values, list) else []:
        text = str(item).strip()
        if text and text not in values:
            values.append(text)
    for signal in _ranked_signals(signals):
        for item in _as_list(signal.get("value")):
            text = str(item).strip()
            if text and text not in values:
                values.append(text)
    return {
        "value": values[:12],
        "confidence": _confidence(signals, default=1.0 if values else 0.0),
        "basis": "stable_profile_field_and_signals" if stable_values else "profile_signals",
        "sources": _sources(signals),
        "missing": not values,
        "dimension": dimension,
    }


def _signal_scalar_dimension(signals: list[dict], dimension: str) -> dict:
    ranked = _ranked_signals(signals)
    value = ranked[0].get("value") if ranked else ""
    return {
        "value": value,
        "confidence": _confidence(signals),
        "basis": "profile_signals",
        "sources": _sources(signals),
        "missing": not _has_value(value),
        "dimension": dimension,
    }


def _best_scalar(stable_value: Any, signals: list[dict]) -> Any:
    return stable_value if _has_value(stable_value) else (_ranked_signals(signals)[0].get("value") if signals else stable_value)


def _ranked_signals(signals: list[dict]) -> list[dict]:
    return sorted(signals, key=lambda item: float(item.get("confidence", 0)) * float(item.get("weight", 1)), reverse=True)


def _sources(signals: list[dict]) -> list[dict]:
    return [
        {
            "source": str(signal.get("source") or ""),
            "confidence": signal.get("confidence", 0),
            "traceId": str(signal.get("traceId") or ""),
            "evidence": signal.get("evidence") if isinstance(signal.get("evidence"), dict) else {},
            "observedAt": str(signal.get("observedAt") or ""),
        }
        for signal in _ranked_signals(signals)[:5]
    ]


def _confidence(signals: list[dict], *, default: float = 0.0) -> float:
    ranked = _ranked_signals(signals)
    return round(float(ranked[0].get("confidence", default)), 3) if ranked else default


def _readiness(dimensions: dict) -> dict:
    required = ["grade", "majorDirection", "foundationLevel", "dailyStudyTime", "learningGoals", "weakPoints", "resourcePreferences"]
    ready = [key for key in required if not dimensions[key]["missing"]]
    return {
        "score": round(len(ready) * 100 / len(required)),
        "readyDimensions": ready,
        "missingDimensions": [{"field": key, "label": key} for key in required if key not in ready],
        "status": "ready" if len(ready) == len(required) else "partial" if len(ready) >= 4 else "incomplete",
    }


def _count_by(signals: list[dict], key: str) -> dict:
    counts: dict[str, int] = {}
    for signal in signals:
        label = str(signal.get(key) or "unknown")
        counts[label] = counts.get(label, 0) + 1
    return counts


def _as_list(value: Any) -> list:
    if isinstance(value, list):
        return value
    if value:
        return [value]
    return []


def _has_value(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict)):
        return bool(value)
    return value is not None and value != ""
```

- [ ] **Step 4: Run tests**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_profile_kernel
```

Expected: all profile kernel tests pass.

### Task 3: Return Snapshot from Profile APIs

**Files:**
- Modify: `backend/apps/profiles/services.py`
- Test: `backend/apps/profiles/tests/test_profile_settings.py`

- [ ] **Step 1: Add failing API response test**

Append to `ProfileSettingsTests`:

```python
    def test_profile_payload_includes_profile_snapshot(self):
        LearnerProfile.objects.update_or_create(
            user=self.user,
            defaults={
                "grade": "大二",
                "major_direction": "自动化专业",
                "foundation_level": "基础一般",
                "daily_study_time": 60,
                "learning_goals": ["掌握自动控制原理"],
                "weak_points": ["根轨迹"],
                "expected_resources": ["例题推导"],
            },
        )

        response = self.client.get("/api/profiles/me/")

        self.assertEqual(response.status_code, 200)
        snapshot = response.json()["profile"]["extraProfile"]["profileSnapshot"]
        self.assertEqual(snapshot["schemaVersion"], "a3.profile-snapshot.v1")
        self.assertIn("weakPoints", snapshot["dimensions"])
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_profile_settings.ProfileSettingsTests.test_profile_payload_includes_profile_snapshot
```

Expected: missing `profileSnapshot`.

- [ ] **Step 3: Update `public_profile`**

In `backend/apps/profiles/services.py`, import and call aggregator:

```python
from backend.apps.profiles.profile_aggregator import aggregate_profile_snapshot
```

Inside `public_profile`, after `extra_profile` is copied:

```python
    snapshot = aggregate_profile_snapshot(profile, save=False)
    extra_profile = {
        **extra_profile,
        "dynamicProfile": build_dynamic_profile(profile, extra=extra_profile),
        "dynamicProfileV2": snapshot,
        "profileSnapshot": snapshot,
    }
```

- [ ] **Step 4: Run profile tests**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests
```

Expected: pass.

### Task 4: Write Signals from Profile Interview

**Files:**
- Modify: `backend/apps/compat/profile_interview.py`
- Test: `backend/apps/compat/tests/test_a3_requirements_deep_fill.py`

- [ ] **Step 1: Add failing assertion to existing interview test**

In `test_profile_interview_extracts_eight_dimensions_and_persists_event`, add:

```python
        signals = refreshed.extra_profile.get("profileSignals", [])
        self.assertTrue(any(item["source"] == "profile_interview" for item in signals))
        self.assertTrue(any(item["dimension"] == "weakPoints" for item in signals))
        self.assertTrue(refreshed.extra_profile.get("profileSnapshot"))
```

- [ ] **Step 2: Run target test**

Expected: missing `profileSignals`.

- [ ] **Step 3: Append signals in `_commit_profile`**

In `backend/apps/compat/profile_interview.py`, import:

```python
from backend.apps.profiles.profile_aggregator import aggregate_profile_snapshot
from backend.apps.profiles.profile_signals import append_profile_signal
```

At the end of `_commit_profile`, before returning:

```python
    for dimension, value in (
        ("learningGoals", extracted.get("learning_goals")),
        ("weakPoints", extracted.get("weak_points")),
        ("resourcePreferences", extracted.get("expected_resources")),
        ("motivationRisk", extracted.get("motivationRisk")),
        ("mistakePatterns", extracted.get("mistakePatterns")),
    ):
        if value:
            append_profile_signal(
                profile,
                dimension=dimension,
                value=value,
                source="profile_interview",
                confidence=0.75 if extracted.get("_llm", {}).get("fallback") else 0.9,
                evidence={"rawPreview": raw_text[:120], "provider": extracted.get("_llm", {}).get("provider", "")},
                weight=0.85,
                save=False,
            )
    aggregate_profile_snapshot(profile, save=False)
    profile.save(update_fields=["extra_profile", "updated_at"])
```

- [ ] **Step 4: Run target test**

Expected: pass.

### Task 5: Write Signals from Diagnostic and Assessment Updates

**Files:**
- Modify: `backend/apps/compat/agent_kernel.py`
- Modify: `backend/apps/learning/services.py` only if diagnostic writeback bypasses kernel in tests
- Test: `backend/apps/assessments/tests/test_assessment_flow.py`
- Test: `backend/apps/compat/tests/test_profile_path_assessment.py`

- [ ] **Step 1: Add assessment signal assertions**

In assessment flow test after wrong answer profile refresh:

```python
        signals = profile.extra_profile.get("profileSignals", [])
        self.assertTrue(any(item["source"] == "wrong_question_sync" for item in signals))
        self.assertTrue(profile.extra_profile.get("profileSnapshot"))
```

- [ ] **Step 2: Add diagnostic signal assertions**

In diagnostic/profile path test after diagnostic writeback:

```python
        signals = profile.extra_profile.get("profileSignals", [])
        self.assertTrue(any(item["source"] == "admission_diagnostic" for item in signals))
        self.assertTrue(profile.extra_profile.get("profileSnapshot"))
```

- [ ] **Step 3: Implement helper in `agent_kernel.py`**

Import:

```python
from backend.apps.profiles.profile_aggregator import aggregate_profile_snapshot
from backend.apps.profiles.profile_signals import append_profile_signal
```

In `_sync_profile_weak_points_for_kernel`, after `extra_profile["lastAssessmentSync"] = ...`:

```python
    append_profile_signal(
        profile,
        dimension="weakPoints",
        value=updated[:8],
        source="wrong_question_sync",
        confidence=0.9 if wrong_items else 0.4,
        evidence={"activeWrongQuestions": len(wrong_items)},
        trace_id="",
        weight=0.95,
        save=False,
    )
    append_profile_signal(
        profile,
        dimension="mistakePatterns",
        value=[wrong.error_cause for wrong in wrong_items if getattr(wrong, "error_cause", "")],
        source="assessment_wrong_answer",
        confidence=0.85,
        evidence={"activeWrongQuestions": len(wrong_items)},
        weight=0.9,
        save=False,
    )
    aggregate_profile_snapshot(profile, save=False)
```

In `ProfileUpdateAgent.run` diagnostic branch, before returning, append:

```python
            append_profile_signal(
                profile,
                dimension="weakPoints",
                value=weak_points,
                source="admission_diagnostic",
                confidence=0.88,
                evidence={"score": diagnostic.get("score"), "level": diagnostic.get("level")},
                trace_id=str(context.state.get("traceId") or ""),
                weight=0.9,
                save=False,
            )
            aggregate_profile_snapshot(profile, save=True)
```

- [ ] **Step 4: Run affected tests**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_assessment_flow backend.apps.compat.tests.test_profile_path_assessment
```

Expected: pass.

### Task 6: Downstream Snapshot Consumption Contract

**Files:**
- Modify: `backend/apps/compat/agent_kernel.py`
- Modify: `backend/apps/compat/recommendations.py` if it builds profile inputs separately
- Modify: `backend/apps/learning/services.py`
- Test: `backend/apps/compat/tests/test_recommendations.py`

- [ ] **Step 1: Add failing recommendation snapshot assertion**

In recommendation tests that inspect `rationale.profileInputs`, add:

```python
        self.assertEqual(first_payload["rationale"]["profileInputs"]["snapshotSchemaVersion"], "a3.profile-snapshot.v1")
```

- [ ] **Step 2: Add snapshot helper**

In the file that builds recommendation/profile snapshots, use:

```python
from backend.apps.profiles.profile_aggregator import aggregate_profile_snapshot


def profile_snapshot_for_user(user) -> dict:
    profile = getattr(user, "learner_profile", None)
    if profile is None:
        return {}
    return aggregate_profile_snapshot(profile, save=False)
```

- [ ] **Step 3: Include snapshot fields in planner/recommendation input**

Where `profileInputs` is built, add:

```python
    snapshot = profile_snapshot_for_user(user)
    profile_inputs["snapshotSchemaVersion"] = snapshot.get("schemaVersion", "")
    profile_inputs["readiness"] = snapshot.get("readiness", {})
    profile_inputs["evidenceSources"] = snapshot.get("signalSummary", {}).get("bySource", {})
```

- [ ] **Step 4: Run recommendation tests**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_recommendations
```

Expected: pass.

### Task 7: Backend Validation Commands

**Files:**
- No source edits unless validation exposes bugs.

- [ ] **Step 1: Run Django checks**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py check
```

Expected: `System check identified no issues`.

- [ ] **Step 2: Run demo flow**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

Expected: pass or only known data warnings unrelated to profile kernel.

- [ ] **Step 3: Run profile-related test group**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles backend.apps.assessments.tests.test_assessment_flow backend.apps.compat.tests.test_profile_path_assessment backend.apps.compat.tests.test_recommendations backend.apps.compat.tests.test_a3_requirements_deep_fill
```

Expected: pass.

## Phase 2: Profile Collection Experience and Display

### Task 8: Add Frontend Types for Snapshot Evidence

**Files:**
- Modify: `OpenMAIC/lib/a3/auth-types.ts`
- Test: `OpenMAIC/tests/a3-profile-kernel-snapshot.test.ts`

- [ ] **Step 1: Add source-level type test**

Create `OpenMAIC/tests/a3-profile-kernel-snapshot.test.ts`:

```ts
import { readFileSync } from 'fs';
import { join } from 'path';

const root = process.cwd();

describe('A3 profile kernel snapshot frontend contract', () => {
  it('types profile snapshot evidence returned by profile APIs', () => {
    const source = readFileSync(join(root, 'lib/a3/auth-types.ts'), 'utf8');

    expect(source).toContain('export type A3ProfileSnapshot');
    expect(source).toContain('schemaVersion: \\'a3.profile-snapshot.v1\\' | string');
    expect(source).toContain('profileSnapshot?: A3ProfileSnapshot');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-profile-kernel-snapshot.test.ts
```

Expected: missing type strings.

- [ ] **Step 3: Add types**

In `OpenMAIC/lib/a3/auth-types.ts`:

```ts
export type A3ProfileDimensionEvidence = {
  source: string;
  confidence: number;
  traceId?: string;
  observedAt?: string;
  evidence?: Record<string, unknown>;
};

export type A3ProfileSnapshotDimension<T = unknown> = {
  dimension: string;
  value: T;
  confidence: number;
  basis: string;
  missing: boolean;
  sources: A3ProfileDimensionEvidence[];
};

export type A3ProfileSnapshot = {
  schemaVersion: 'a3.profile-snapshot.v1' | string;
  dimensions: Record<string, A3ProfileSnapshotDimension>;
  readiness: {
    score: number;
    status: 'ready' | 'partial' | 'incomplete' | string;
    readyDimensions?: string[];
    missingDimensions?: Array<{ field: string; label: string }>;
  };
  signalSummary?: {
    total: number;
    bySource: Record<string, number>;
    latestAt?: string;
  };
  updatedAt?: string;
};
```

Extend profile extra type with:

```ts
profileSnapshot?: A3ProfileSnapshot;
dynamicProfileV2?: A3ProfileSnapshot;
```

- [ ] **Step 4: Run frontend type test**

Expected: pass.

### Task 9: Show Snapshot Evidence in Profile UI

**Files:**
- Modify: `OpenMAIC/components/a3/profile/dynamic-profile-insight-panel.tsx`
- Modify: `OpenMAIC/components/a3/auth/a3-auth-pages.tsx`
- Test: `OpenMAIC/tests/a3-profile-kernel-snapshot.test.ts`

- [ ] **Step 1: Extend source test**

Append:

```ts
  it('shows profile evidence in collection and insight surfaces', () => {
    const authPage = readFileSync(join(root, 'components/a3/auth/a3-auth-pages.tsx'), 'utf8');
    const insight = readFileSync(join(root, 'components/a3/profile/dynamic-profile-insight-panel.tsx'), 'utf8');

    expect(authPage).toContain('profileSnapshot');
    expect(authPage).toContain('画像证据');
    expect(insight).toContain('signalSummary');
    expect(insight).toContain('置信度');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Expected: missing UI strings.

- [ ] **Step 3: Implement minimal evidence rendering**

In the profile setup result card, read:

```ts
const profileSnapshot = snapshotResult?.profile?.extraProfile?.profileSnapshot ?? saveResult?.profile?.extraProfile?.profileSnapshot;
```

Render:

```tsx
{profileSnapshot && (
  <div data-testid="a3-profile-snapshot-evidence" className="mt-4 rounded-2xl border border-blue-200 bg-white/80 p-4">
    <div className="text-sm font-semibold text-blue-950">画像证据</div>
    <div className="mt-2 text-xs text-blue-800">
      完成度 {profileSnapshot.readiness?.score ?? 0}% · 信号 {profileSnapshot.signalSummary?.total ?? 0} 条
    </div>
    <div className="mt-3 flex flex-wrap gap-2 text-xs">
      {Object.entries(profileSnapshot.signalSummary?.bySource ?? {}).map(([source, count]) => (
        <span key={source} className="rounded-full bg-blue-50 px-3 py-1 font-medium text-blue-700">
          {source}: {count}
        </span>
      ))}
    </div>
  </div>
)}
```

In `dynamic-profile-insight-panel.tsx`, add a compact section for `signalSummary` and top dimension confidence.

- [ ] **Step 4: Run frontend tests**

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-profile-kernel-snapshot.test.ts tests/a3-profile-setup.test.ts tests/a3-profile-interview-submit.test.ts
```

Expected: pass.

### Task 10: Final Verification

**Files:**
- No planned edits.

- [ ] **Step 1: Backend verification**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles backend.apps.assessments.tests.test_assessment_flow backend.apps.compat.tests.test_profile_path_assessment backend.apps.compat.tests.test_recommendations backend.apps.compat.tests.test_a3_requirements_deep_fill
```

- [ ] **Step 2: Frontend verification**

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd vitest run tests/a3-profile-kernel-snapshot.test.ts tests/a3-profile-setup.test.ts tests/a3-profile-interview-submit.test.ts
```

- [ ] **Step 3: Manual API smoke**

Run profile interview once, then inspect `/api/profiles/me/`:

```powershell
# Use existing authenticated browser/session for UI smoke, or Django test client in tests.
# Expected JSON path:
# profile.extraProfile.profileSnapshot.schemaVersion == "a3.profile-snapshot.v1"
# profile.extraProfile.profileSnapshot.signalSummary.total >= 1
```

## Self-Review

- Spec coverage: The plan covers backend signal capture, aggregation, downstream snapshot contract, and frontend evidence display. It preserves current A3 profile/interview/diagnostic/assessment contracts.
- Placeholder scan: No task uses unspecified placeholder implementation steps; each code task includes concrete snippets and commands.
- Type consistency: Backend uses `profileSignals`, `profileSnapshot`, `dynamicProfileV2`, `a3.profile-signal.v1`, and `a3.profile-snapshot.v1`; frontend types use the same names.

## Execution Choice

Recommended execution order is strict:

1. Tasks 1-7: backend profile kernel.
2. Tasks 8-10: profile collection experience and display.

Use Subagent-Driven execution if available, one fresh worker per task, with review after each task. Use Inline Execution if you want one continuous implementation session.
