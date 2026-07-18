from __future__ import annotations

from dataclasses import dataclass, field
from time import perf_counter
from typing import Callable, TypeVar
from uuid import uuid4

from django.db import DatabaseError, close_old_connections, transaction
from django.utils import timezone

from backend.apps.compat.models import AgentRun as AgentRunModel
from backend.apps.compat.models import AgentSpan as AgentSpanModel
from backend.apps.compat.models import AgentStep as AgentStepModel
from backend.apps.compat.trace_spans import normalize_span_latency, normalize_span_metadata, now_for_span, serialize_span
from backend.apps.profiles.models import LearnerProfile


SCHEMA_VERSION = "a3.agent-run.v1"
STEP_EVIDENCE_SCHEMA_VERSION = "a3.agent-step-evidence.v1"
AGENT_OUTPUT_SCHEMA_VERSION = "a3.agent-output.v1"
T = TypeVar("T")


def _trace_urls(trace_id: str) -> dict:
    return {
        "detailUrl": f"/api/demo/agent-runs/{trace_id}/",
        "exportJsonUrl": f"/api/demo/agent-runs/{trace_id}/export/?format=json",
        "exportMarkdownUrl": f"/api/demo/agent-runs/{trace_id}/export/?format=markdown",
    }


def _normalize_step_metadata(metadata: dict) -> dict:
    normalized = dict(metadata)
    evidence = normalized.get("evidence")
    quality = normalized.get("quality")
    has_evidence_schema = isinstance(evidence, dict) or isinstance(quality, dict)
    if has_evidence_schema:
        normalized.setdefault("a3EvidenceSchemaVersion", STEP_EVIDENCE_SCHEMA_VERSION)
    if isinstance(quality, dict):
        quality_payload = dict(quality)
        safety = quality_payload.pop("safety", None)
        contract = quality_payload.pop("contract", None)
        if isinstance(safety, dict):
            normalized.setdefault("safety", safety)
        if isinstance(contract, dict):
            normalized.setdefault("contract", contract)
        normalized["quality"] = quality_payload
    if isinstance(evidence, dict):
        evidence_payload = dict(evidence)
        safety = evidence_payload.pop("safety", None)
        contract = evidence_payload.pop("contract", None)
        if isinstance(safety, dict):
            normalized.setdefault("safety", safety)
        if isinstance(contract, dict):
            normalized.setdefault("contract", contract)
        normalized["evidence"] = evidence_payload
    return normalized


@dataclass
class AgentStep:
    name: str
    role: str
    status: str
    detail: str
    latency_ms: int
    metadata: dict = field(default_factory=dict)


@dataclass
class AgentSpan:
    name: str
    kind: str
    parent_step: str
    status: str
    latency_ms: int
    started_at: object
    completed_at: object | None = None
    metadata: dict = field(default_factory=dict)


class AgentRun:
    """Enterprise trace persisted to AgentRun/AgentStep with legacy profile fallback."""

    def __init__(self, user, workflow: str, goal: str = ""):
        self.user = user
        self.trace_id = uuid4().hex
        self.workflow = workflow
        self.goal = goal
        self.started_at = timezone.now()
        self.completed_at = None
        self._start = perf_counter()
        self.steps: list[AgentStep] = []
        self.spans: list[AgentSpan] = []
        self.status = "running"
        self.fallback_strategy = "none"
        self.metadata: dict = {}

    @property
    def latency_ms(self) -> int:
        return max(1, int((perf_counter() - self._start) * 1000))

    def step(
        self,
        name: str,
        role: str,
        detail: str,
        *,
        status: str = "completed",
        metadata: dict | None = None,
        input_summary: dict | None = None,
        output_summary: dict | None = None,
        state_diff: dict | None = None,
        evidence: dict | None = None,
        quality: dict | None = None,
    ):
        metadata_payload = dict(metadata or {})
        if input_summary is not None:
            metadata_payload["inputSummary"] = input_summary
        if output_summary is not None:
            metadata_payload["outputSummary"] = output_summary
        if state_diff is not None:
            metadata_payload["stateDiff"] = state_diff
        if evidence is not None:
            metadata_payload["evidence"] = evidence
        if quality is not None:
            metadata_payload["quality"] = quality
        metadata_payload.setdefault("outputSchema", {
            "schemaVersion": AGENT_OUTPUT_SCHEMA_VERSION,
            "valid": True,
            "errors": [],
            "mode": "manual_step_default",
        })
        metadata_payload.setdefault("degradation", {
            "status": status,
            "degraded": status == "degraded",
            "fallbackStrategy": self.fallback_strategy or "none",
            "reason": "",
        })
        metadata_payload = _normalize_step_metadata(metadata_payload)
        self.steps.append(
            AgentStep(
                name=name,
                role=role,
                status=status,
                detail=detail,
                latency_ms=self.latency_ms,
                metadata=metadata_payload,
            )
        )

    def span(
        self,
        *,
        name: str,
        kind: str,
        parent_step: str = "",
        status: str = "completed",
        metadata: dict | None = None,
        latency_ms: int | None = None,
        started_at=None,
        completed_at=None,
    ):
        span_started_at = started_at or now_for_span()
        span_completed_at = completed_at if completed_at is not None else now_for_span()
        normalized_latency = normalize_span_latency(latency_ms, metadata)
        self.spans.append(
            AgentSpan(
                name=name,
                kind=kind,
                parent_step=parent_step,
                status=status,
                latency_ms=normalized_latency,
                started_at=span_started_at,
                completed_at=span_completed_at,
                metadata=normalize_span_metadata(metadata, latency_ms=normalized_latency),
            )
        )

    def execute_step(
        self,
        name: str,
        role: str,
        detail: str,
        operation: Callable[[], T],
        *,
        timeout_ms: int | None = None,
        max_retries: int = 0,
        fallback: Callable[[Exception], T] | None = None,
    ) -> T:
        attempts = 0
        errors: list[str] = []
        last_error: Exception | None = None
        max_retries = max(0, int(max_retries))
        self.metadata["retryPolicy"] = {"maxRetries": max_retries, "timeoutMs": timeout_ms}

        for _ in range(max_retries + 1):
            attempts += 1
            attempt_start = perf_counter()
            try:
                result = operation()
                elapsed_ms = max(1, int((perf_counter() - attempt_start) * 1000))
                if timeout_ms is not None and elapsed_ms > timeout_ms:
                    raise TimeoutError(f"{name} exceeded {timeout_ms}ms")
                self.step(
                    name,
                    role,
                    detail,
                    metadata={
                        "attempts": attempts,
                        "errors": errors,
                        "timedOut": False,
                        "timeoutMs": timeout_ms,
                        "elapsedMs": elapsed_ms,
                    },
                )
                return result
            except Exception as exc:
                last_error = exc
                errors.append(str(exc))

        if last_error is None:
            last_error = RuntimeError("Agent step failed without an exception")

        self.metadata["lastError"] = {"type": type(last_error).__name__, "message": str(last_error)}
        timed_out = isinstance(last_error, TimeoutError)
        if fallback is not None:
            fallback_result = fallback(last_error)
            self.fallback_strategy = "fallback_result"
            self.step(
                name,
                role,
                detail,
                status="degraded",
                metadata={
                    "attempts": attempts,
                    "errors": errors,
                    "timedOut": timed_out,
                    "timeoutMs": timeout_ms,
                    "fallback": "used",
                },
            )
            return fallback_result

        self.step(
            name,
            role,
            detail,
            status="failed",
            metadata={
                "attempts": attempts,
                "errors": errors,
                "timedOut": timed_out,
                "timeoutMs": timeout_ms,
            },
        )
        self.fail(str(last_error))
        raise last_error

    def fail(self, error: str):
        self.status = "failed"
        self.fallback_strategy = "manual_review"
        self.step("OrchestratorAgent", "异常处理", error, status="failed")
        self.persist()

    def complete(self):
        self.status = "completed"
        self.completed_at = timezone.now()
        self.persist()

    def as_dict(self) -> dict:
        return {
            "traceId": self.trace_id,
            **_trace_urls(self.trace_id),
            "schemaVersion": SCHEMA_VERSION,
            "workflow": self.workflow,
            "goal": self.goal,
            "status": self.status,
            "fallbackStrategy": self.fallback_strategy,
            "startedAt": self.started_at.isoformat(),
            "completedAt": self.completed_at.isoformat() if self.completed_at else None,
            "latencyMs": self.latency_ms,
            "metadata": self.metadata,
            "steps": [
                {
                    "order": index,
                    "name": step.name,
                    "role": step.role,
                    "status": step.status,
                    "detail": step.detail,
                    "latencyMs": step.latency_ms,
                    "metadata": step.metadata,
                }
                for index, step in enumerate(self.steps, start=1)
            ],
            "spans": [
                serialize_span(
                    name=span.name,
                    kind=span.kind,
                    parent_step=span.parent_step,
                    status=span.status,
                    latency_ms=span.latency_ms,
                    started_at=span.started_at,
                    completed_at=span.completed_at,
                    metadata=span.metadata,
                )
                for span in self.spans
            ],
        }

    def persist(self):
        self._persist_models()
        self._persist_legacy_profile()

    def _persist_models(self):
        payload = self.as_dict()
        try:
            with transaction.atomic():
                run_model, _ = AgentRunModel.objects.update_or_create(
                    trace_id=self.trace_id,
                    defaults={
                        "user": self.user,
                        "schema_version": SCHEMA_VERSION,
                        "workflow": self.workflow,
                        "goal": self.goal,
                        "status": self.status,
                        "fallback_strategy": self.fallback_strategy,
                        "latency_ms": payload["latencyMs"],
                        "started_at": self.started_at,
                        "completed_at": self.completed_at,
                        "metadata": self.metadata,
                    },
                )
                run_model.steps.all().delete()
                run_model.spans.all().delete()
                AgentStepModel.objects.bulk_create(
                    [
                        AgentStepModel(
                            run=run_model,
                            order=step_payload["order"],
                            name=step_payload["name"],
                            role=step_payload["role"],
                            status=step_payload["status"],
                            detail=step_payload["detail"],
                            latency_ms=step_payload["latencyMs"],
                            metadata=step_payload["metadata"],
                        )
                        for step_payload in payload["steps"]
                    ]
                )
                AgentSpanModel.objects.bulk_create(
                    [
                        AgentSpanModel(
                            run=run_model,
                            parent_step=span_payload["parentStep"],
                            name=span_payload["name"],
                            kind=span_payload["kind"],
                            status=span_payload["status"],
                            latency_ms=span_payload["latencyMs"],
                            started_at=span.started_at,
                            completed_at=span.completed_at,
                            metadata=span_payload["metadata"],
                        )
                        for span, span_payload in zip(self.spans, payload["spans"])
                    ]
                )
        except DatabaseError:
            self.fallback_strategy = "legacy_profile_only"
            close_old_connections()

    def _persist_legacy_profile(self):
        profile, _ = LearnerProfile.objects.get_or_create(user=self.user)
        extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
        runs = extra_profile.get("agentRuns") if isinstance(extra_profile.get("agentRuns"), list) else []
        extra_profile["agentRuns"] = [_summarize_trace_payload(self.as_dict()), *runs][:20]
        profile.extra_profile = extra_profile
        profile.save(update_fields=["extra_profile", "updated_at"])


def recent_agent_runs(user, limit: int = 6, *, summary: bool = False) -> list[dict]:
    model_runs = (
        AgentRunModel.objects.filter(user=user)
        .prefetch_related("steps", "spans")
        .order_by("-started_at", "-id")[:limit]
    )
    serialized = [_serialize_model_run(run, summary=summary) for run in model_runs]
    if serialized:
        return serialized

    profile = getattr(user, "learner_profile", None)
    if profile is None:
        return []
    extra_profile = profile.extra_profile if isinstance(profile.extra_profile, dict) else {}
    runs = extra_profile.get("agentRuns")
    if not isinstance(runs, list):
        return []
    runs = runs[:limit]
    if summary:
        return [_summarize_trace_payload(run) for run in runs if isinstance(run, dict)]
    return runs


def _serialize_model_run(run: AgentRunModel, *, summary: bool = False) -> dict:
    return {
        "traceId": run.trace_id,
        **_trace_urls(run.trace_id),
        "schemaVersion": run.schema_version or SCHEMA_VERSION,
        "workflow": run.workflow,
        "goal": run.goal,
        "status": run.status,
        "fallbackStrategy": run.fallback_strategy or "none",
        "startedAt": run.started_at.isoformat(),
        "completedAt": run.completed_at.isoformat() if run.completed_at else None,
        "latencyMs": max(1, run.latency_ms),
        "metadata": run.metadata,
        "steps": [
            {
                "order": step.order,
                "name": step.name,
                "role": step.role,
                "status": step.status,
                "detail": step.detail,
                "latencyMs": max(1, step.latency_ms),
                "metadata": _summarize_step_metadata(step.metadata) if summary else step.metadata,
            }
            for step in run.steps.all()
        ],
        "spans": [
            serialize_span(
                name=span.name,
                kind=span.kind,
                parent_step=span.parent_step,
                status=span.status,
                latency_ms=span.latency_ms,
                started_at=span.started_at,
                completed_at=span.completed_at,
                metadata=_summarize_span_metadata(span.metadata) if summary else span.metadata,
            )
            for span in run.spans.all()
        ],
    }


def _summarize_trace_payload(trace: dict) -> dict:
    payload = dict(trace)
    steps = payload.get("steps") if isinstance(payload.get("steps"), list) else []
    spans = payload.get("spans") if isinstance(payload.get("spans"), list) else []
    payload["steps"] = [
        {
            "order": step.get("order"),
            "name": step.get("name"),
            "role": step.get("role"),
            "status": step.get("status"),
            "detail": step.get("detail"),
            "latencyMs": step.get("latencyMs"),
            "metadata": _summarize_step_metadata(step.get("metadata") if isinstance(step.get("metadata"), dict) else {}),
        }
        for step in steps
        if isinstance(step, dict)
    ]
    payload["spans"] = [
        {
            "name": span.get("name"),
            "kind": span.get("kind"),
            "parentStep": span.get("parentStep"),
            "status": span.get("status"),
            "latencyMs": span.get("latencyMs"),
            "startedAt": span.get("startedAt"),
            "completedAt": span.get("completedAt"),
            "metadata": _summarize_span_metadata(span.get("metadata") if isinstance(span.get("metadata"), dict) else {}),
        }
        for span in spans
        if isinstance(span, dict)
    ]
    return payload


def _summarize_step_metadata(metadata: dict) -> dict:
    summary = {}
    runtime_policy = metadata.get("runtimePolicy")
    if isinstance(runtime_policy, dict):
        summary["runtimePolicy"] = {
            "maxRetries": int(runtime_policy.get("maxRetries") or 0),
            "timeoutMs": runtime_policy.get("timeoutMs"),
            "attempts": int(runtime_policy.get("attempts") or 0),
            "errors": [str(error)[:160] for error in runtime_policy.get("errors", [])[:3]]
            if isinstance(runtime_policy.get("errors"), list)
            else [],
            "timedOut": bool(runtime_policy.get("timedOut")),
            "elapsedMs": int(runtime_policy.get("elapsedMs") or 0),
        }
    circuit_breaker = metadata.get("circuitBreaker")
    if isinstance(circuit_breaker, dict):
        summary["circuitBreaker"] = {
            "open": bool(circuit_breaker.get("open")),
            "reason": str(circuit_breaker.get("reason") or ""),
            "failureRate": float(circuit_breaker.get("failureRate") or 0),
        }
    return summary


def _summarize_span_metadata(metadata: dict) -> dict:
    return {
        "provider": str(metadata.get("provider") or ""),
        "model": str(metadata.get("model") or ""),
        "latencyMs": max(1, int(metadata.get("latencyMs") or 1)),
        "tokenUsage": metadata.get("tokenUsage") if isinstance(metadata.get("tokenUsage"), dict) else {},
        "fallbackReason": str(metadata.get("fallbackReason") or "")[:200],
        "promptHash": str(metadata.get("promptHash") or ""),
        "errorType": str(metadata.get("errorType") or ""),
    }
