# A3 OS Interactive Algorithm Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-grade operating-system algorithm lab that lets students predict, step through, compare, and submit CPU-scheduling and page-replacement simulations while writing verified learning evidence back into A3's existing recommendation, plan, report, and learning-event loop.

**Architecture:** Keep the simulation kernels as deterministic TypeScript pure functions that run in the browser and expose immutable `SimulationStep[]` results to a shared playback state machine. Django owns the versioned lab registry, validates server-known presets and completion summaries, and stores compact evidence in the existing `LearningEvent` table; custom inputs remain useful for exploration but cannot update verified mastery. Existing A3 pages link into the new `/a3/labs` and `/a3/labs/[labId]` routes without changing the Agent interfaces or replacing `CodeLabWorkbench`.

**Tech Stack:** Next.js App Router, React, TypeScript, Tailwind CSS, Lucide React, Vitest, Playwright, Django, MySQL-backed `LearningEvent`, Django `TestCase`.

---

## Delivery Constraints

- Keep the six existing primary student navigation groups. Add `交互实验` under `练习复盘`.
- P0 lab IDs are exactly `cpu-scheduling` and `page-replacement`.
- Do not add a database model or migration. Persist compact summaries in `LearningEvent`.
- Do not call an LLM for simulation, scoring, checkpoints, or baseline explanations.
- Do not send full step arrays to Django. Send only preset identity, selected algorithms, prediction/checkpoint results, aggregate metrics, duration, replay count, and reviewed step indexes.
- Only a server-known `presetId + presetVersion + resultFingerprint` combination can set `verified: true` or affect mastery evidence.
- Keep custom-input runs visible in history with `verified: false`.
- All completion writes must be idempotent by `eventId`.
- Preserve existing recommendation, resource-pack, study-plan, and Agent response contracts; lab fields are additive.
- Use normal Chinese user-facing errors and never expose traceback, local paths, API keys, or raw model/provider details.

## File Map

### New frontend files

```text
OpenMAIC/app/a3/labs/page.tsx
OpenMAIC/app/a3/labs/[labId]/page.tsx
OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-catalog-view.tsx
OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-workbench.tsx
OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-layout.tsx
OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-controls.tsx
OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-input-panel.tsx
OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-status-panel.tsx
OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-step-explanation.tsx
OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-checkpoint.tsx
OpenMAIC/components/a3/features/algorithm-lab/cpu-scheduling-visualizer.tsx
OpenMAIC/components/a3/features/algorithm-lab/page-replacement-visualizer.tsx
OpenMAIC/lib/a3/algorithm-lab/contracts.ts
OpenMAIC/lib/a3/algorithm-lab/registry.ts
OpenMAIC/lib/a3/algorithm-lab/validators.ts
OpenMAIC/lib/a3/algorithm-lab/session.ts
OpenMAIC/lib/a3/algorithm-lab/client.ts
OpenMAIC/lib/a3/algorithm-lab/cpu-scheduling.ts
OpenMAIC/lib/a3/algorithm-lab/page-replacement.ts
OpenMAIC/tests/a3-algorithm-lab-contracts.test.ts
OpenMAIC/tests/a3-cpu-scheduling.test.ts
OpenMAIC/tests/a3-page-replacement.test.ts
OpenMAIC/tests/a3-algorithm-lab-session.test.ts
OpenMAIC/tests/a3-algorithm-lab-ui.test.ts
OpenMAIC/tests/a3-algorithm-lab-entry-points.test.ts
OpenMAIC/e2e/tests/a3-algorithm-lab.spec.ts
```

### New backend files

```text
backend/apps/learning/algorithm_labs.py
backend/apps/learning/tests/test_algorithm_labs.py
backend/apps/learning/tests/test_algorithm_lab_recommendations.py
```

### Existing files to modify

```text
OpenMAIC/lib/a3/learning-event-client.ts
OpenMAIC/lib/a3/navigation.ts
OpenMAIC/lib/a3/i18n.ts
OpenMAIC/lib/a3/learning-types.ts
OpenMAIC/lib/a3/recommendation-types.ts
OpenMAIC/lib/a3/assessment-types.ts
OpenMAIC/lib/a3/report-view-model.ts
OpenMAIC/components/a3/layout/a3-shell.tsx
OpenMAIC/components/a3/features/assessment-view.tsx
OpenMAIC/components/a3/features/today-learning-view.tsx
OpenMAIC/components/a3/features/learning-path-view.tsx
OpenMAIC/components/a3/features/recommendations-view.tsx
OpenMAIC/components/a3/features/resource-standalone-view.tsx
OpenMAIC/components/a3/features/report-view.tsx
OpenMAIC/tests/a3-learning-event-client.test.ts
OpenMAIC/tests/a3-navigation-consolidation.test.ts
backend/apps/learning/effect_events.py
backend/apps/learning/views.py
backend/apps/learning/urls.py
backend/apps/learning/services.py
backend/apps/compat/recommendations.py
backend/apps/assessments/services.py
backend/apps/assessments/tests/test_assessment_flow.py
```

## API Contracts

### `GET /api/learning/algorithm-labs/`

Response:

```json
{
  "success": true,
  "schemaVersion": "a3.algorithm-labs.catalog.v1",
  "labs": [
    {
      "id": "cpu-scheduling",
      "version": "1.0.0",
      "title": "CPU 调度算法对比",
      "description": "比较不同调度策略的等待、周转和响应时间。",
      "knowledgePointCodes": ["os-process-scheduling"],
      "estimatedMinutes": 18,
      "algorithms": ["fcfs", "sjf", "priority", "rr"],
      "presets": [
        {"id": "cpu-foundation", "version": "1", "title": "基础到达队列", "difficulty": "foundation"}
      ],
      "progress": {"completed": false, "bestScore": null, "lastCompletedAt": null, "verifiedRuns": 0}
    }
  ],
  "recentSession": null
}
```

### `POST /api/learning/algorithm-labs/complete/`

Request:

```json
{
  "schemaVersion": "a3.algorithm-lab.completion.v1",
  "eventId": "a3lab_2f5742c4_cpu-foundation_1",
  "labId": "cpu-scheduling",
  "labVersion": "1.0.0",
  "presetId": "cpu-foundation",
  "presetVersion": "1",
  "customInput": false,
  "selectedAlgorithms": ["fcfs", "sjf", "priority", "rr"],
  "prediction": {"answer": "sjf", "skipped": false, "correct": true},
  "checkpoints": {"answered": 2, "correct": 2, "items": [{"id": "cpu-order", "correct": true}]},
  "metrics": {"score": 100, "durationSec": 493, "replayCount": 1, "reviewedStepIndexes": [2, 7, 11]},
  "resultFingerprint": "sha256:server-known-preset-result"
}
```

Success response:

```json
{
  "success": true,
  "status": "accepted",
  "completion": {
    "labId": "cpu-scheduling",
    "verified": true,
    "score": 100,
    "masteryEvidenceAccepted": true,
    "nextAction": {"label": "完成专项练习", "href": "/a3/assessment", "reason": "继续验证调度算法判断"}
  }
}
```

Duplicate submission returns HTTP 200 with `status: "duplicate"`. Invalid input returns HTTP 400 with `{ "success": false, "error": "正常中文说明" }`. Custom input returns `verified: false` and `masteryEvidenceAccepted: false` even when the run is complete.

---

### Task 1: Define Shared Contracts, Validators, and Versioned Presets

**Files:**
- Create: `OpenMAIC/lib/a3/algorithm-lab/contracts.ts`
- Create: `OpenMAIC/lib/a3/algorithm-lab/validators.ts`
- Create: `OpenMAIC/lib/a3/algorithm-lab/registry.ts`
- Test: `OpenMAIC/tests/a3-algorithm-lab-contracts.test.ts`

- [ ] **Step 1: Write the failing contract and registry tests**

```ts
import { describe, expect, it } from 'vitest';
import { algorithmLabRegistry, getAlgorithmLabDefinition } from '@/lib/a3/algorithm-lab/registry';
import { validateCpuSchedulingInput, validatePageReplacementInput } from '@/lib/a3/algorithm-lab/validators';

describe('algorithm lab contracts', () => {
  it('registers exactly the two P0 labs with versioned presets', () => {
    expect(algorithmLabRegistry.map((lab) => lab.id)).toEqual(['cpu-scheduling', 'page-replacement']);
    expect(algorithmLabRegistry.every((lab) => /^\d+\.\d+\.\d+$/.test(lab.version))).toBe(true);
    expect(algorithmLabRegistry.every((lab) => lab.presets.length >= 3)).toBe(true);
    expect(getAlgorithmLabDefinition('missing')).toBeNull();
  });

  it('rejects invalid CPU rows and unsafe RR quantum values', () => {
    expect(validateCpuSchedulingInput({ processes: [], timeQuantum: 2 }).valid).toBe(false);
    expect(validateCpuSchedulingInput({
      processes: [{ processId: 'P1', arrivalTime: 0, burstTime: 3, priority: 1 }],
      timeQuantum: 0,
    }).errors).toContain('时间片必须是 1 到 20 之间的整数');
  });

  it('normalizes page references and constrains frame count', () => {
    expect(validatePageReplacementInput({ referenceString: [7, 0, 1], frameCount: 3 }).valid).toBe(true);
    expect(validatePageReplacementInput({ referenceString: [], frameCount: 3 }).valid).toBe(false);
    expect(validatePageReplacementInput({ referenceString: [1, 2], frameCount: 9 }).valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and verify that imports fail**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-algorithm-lab-contracts.test.ts
```

Expected: FAIL with `Failed to resolve import "@/lib/a3/algorithm-lab/registry"`.

- [ ] **Step 3: Add the complete shared contracts**

Define these exported names in `contracts.ts` and use them unchanged in later tasks:

```ts
export type AlgorithmLabId = 'cpu-scheduling' | 'page-replacement';
export type CpuSchedulingAlgorithm = 'fcfs' | 'sjf' | 'priority' | 'rr';
export type PageReplacementAlgorithm = 'fifo' | 'lru' | 'opt';
export type AlgorithmLabAlgorithm = CpuSchedulingAlgorithm | PageReplacementAlgorithm;
export type AlgorithmLabDifficulty = 'foundation' | 'misconception' | 'comparison';
export type AlgorithmLabPhase = 'idle' | 'configured' | 'predicted' | 'running' | 'paused' | 'completed' | 'submitted';

export type CpuProcessInput = {
  processId: string;
  arrivalTime: number;
  burstTime: number;
  priority: number;
};

export type CpuSchedulingInput = { processes: CpuProcessInput[]; timeQuantum: number };
export type PageReplacementInput = { referenceString: number[]; frameCount: number };
export type AlgorithmLabInput = CpuSchedulingInput | PageReplacementInput;

export type ValidationResult = { valid: boolean; errors: string[] };
export type AlgorithmLabPreset<TInput extends AlgorithmLabInput = AlgorithmLabInput> = {
  id: string;
  version: string;
  title: string;
  description: string;
  difficulty: AlgorithmLabDifficulty;
  input: TInput;
};

export type SimulationStep<TState, TMetrics> = {
  index: number;
  time: number;
  label: string;
  explanation: string;
  state: TState;
  metrics: TMetrics;
  checkpointId?: string;
};

export type SimulationRun<TState, TMetrics> = {
  algorithm: AlgorithmLabAlgorithm;
  steps: SimulationStep<TState, TMetrics>[];
  finalMetrics: TMetrics;
  resultFingerprint: string;
};

export type AlgorithmLabDefinition<TInput extends AlgorithmLabInput = AlgorithmLabInput> = {
  id: AlgorithmLabId;
  version: string;
  title: string;
  description: string;
  estimatedMinutes: number;
  knowledgePointCodes: string[];
  algorithms: AlgorithmLabAlgorithm[];
  presets: AlgorithmLabPreset<TInput>[];
};
```

- [ ] **Step 4: Implement strict validators and the fixed registry**

`validators.ts` must reject duplicate/blank process IDs, non-integers, negative arrival times, burst times outside `1..100`, priorities outside `0..99`, process counts outside `1..12`, page values outside `0..999`, reference lengths outside `1..60`, and frame counts outside `1..8`. `registry.ts` must provide three immutable presets per lab and export:

```ts
export const algorithmLabRegistry: AlgorithmLabDefinition[];
export function getAlgorithmLabDefinition(labId: string): AlgorithmLabDefinition | null;
export function getAlgorithmLabPreset(labId: string, presetId: string, presetVersion: string): AlgorithmLabPreset | null;
```

Use `structuredClone` or explicit object copying when returning mutable input so UI edits never mutate registry presets.

- [ ] **Step 5: Run the focused test and type checker**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-algorithm-lab-contracts.test.ts
npx.cmd tsc --noEmit
```

Expected: contract test PASS; TypeScript exits 0.

- [ ] **Step 6: Commit the shared contract slice**

```powershell
git add OpenMAIC/lib/a3/algorithm-lab/contracts.ts OpenMAIC/lib/a3/algorithm-lab/validators.ts OpenMAIC/lib/a3/algorithm-lab/registry.ts OpenMAIC/tests/a3-algorithm-lab-contracts.test.ts
git commit -m "feat: define algorithm lab contracts"
```

### Task 2: Implement the Deterministic CPU Scheduling Kernel

**Files:**
- Create: `OpenMAIC/lib/a3/algorithm-lab/cpu-scheduling.ts`
- Test: `OpenMAIC/tests/a3-cpu-scheduling.test.ts`

- [ ] **Step 1: Write failing examples for FCFS, SJF, priority, and RR**

```ts
import { describe, expect, it } from 'vitest';
import { simulateCpuScheduling } from '@/lib/a3/algorithm-lab/cpu-scheduling';

const input = {
  processes: [
    { processId: 'P1', arrivalTime: 0, burstTime: 5, priority: 2 },
    { processId: 'P2', arrivalTime: 1, burstTime: 3, priority: 1 },
    { processId: 'P3', arrivalTime: 2, burstTime: 1, priority: 3 },
  ],
  timeQuantum: 2,
};

describe('CPU scheduling kernel', () => {
  it('produces stable completion orders and metrics', () => {
    expect(simulateCpuScheduling(input, 'fcfs').finalMetrics.completionOrder).toEqual(['P1', 'P2', 'P3']);
    expect(simulateCpuScheduling(input, 'sjf').finalMetrics.completionOrder).toEqual(['P1', 'P3', 'P2']);
    expect(simulateCpuScheduling(input, 'priority').finalMetrics.completionOrder).toEqual(['P1', 'P2', 'P3']);
    expect(simulateCpuScheduling(input, 'rr').finalMetrics.completionOrder).toEqual(['P3', 'P2', 'P1']);
  });

  it('preserves CPU-time and timing invariants', () => {
    for (const algorithm of ['fcfs', 'sjf', 'priority', 'rr'] as const) {
      const run = simulateCpuScheduling(input, algorithm);
      expect(run.finalMetrics.totalBusyTime).toBe(9);
      expect(run.steps.at(-1)?.state.processes.every((process) => process.remainingTime === 0)).toBe(true);
      expect(run.finalMetrics.averageWaitingTime).toBeGreaterThanOrEqual(0);
      expect(run.resultFingerprint).toMatch(/^cpu:/);
    }
  });

  it('uses process ID as the final deterministic tie breaker', () => {
    const tied = { processes: [
      { processId: 'P2', arrivalTime: 0, burstTime: 2, priority: 1 },
      { processId: 'P1', arrivalTime: 0, burstTime: 2, priority: 1 },
    ], timeQuantum: 1 };
    expect(simulateCpuScheduling(tied, 'sjf').finalMetrics.completionOrder).toEqual(['P1', 'P2']);
  });
});
```

- [ ] **Step 2: Verify the test fails because the kernel does not exist**

Run `pnpm.cmd vitest run tests/a3-cpu-scheduling.test.ts` from `OpenMAIC`.

Expected: FAIL resolving `cpu-scheduling`.

- [ ] **Step 3: Implement the complete CPU types and simulation entry point**

Export the following stable contract:

```ts
export type CpuProcessState = CpuProcessInput & {
  remainingTime: number;
  startTime: number | null;
  completionTime: number | null;
};

export type CpuSchedulingState = {
  currentProcessId: string | null;
  readyQueue: string[];
  completedProcessIds: string[];
  processes: CpuProcessState[];
  timeline: Array<{ processId: string | 'idle'; start: number; end: number }>;
};

export type CpuSchedulingMetrics = {
  averageWaitingTime: number;
  averageTurnaroundTime: number;
  averageResponseTime: number;
  contextSwitches: number;
  totalBusyTime: number;
  completionOrder: string[];
};

export function simulateCpuScheduling(
  input: CpuSchedulingInput,
  algorithm: CpuSchedulingAlgorithm,
): SimulationRun<CpuSchedulingState, CpuSchedulingMetrics>;
```

Implement non-preemptive FCFS, SJF, and priority plus preemptive RR. At each clock transition append an immutable state snapshot. Merge adjacent timeline slices for the same process. Calculate waiting as `completion - arrival - burst`, turnaround as `completion - arrival`, and response as `firstStart - arrival`. Round averages to two decimals. Use stable tie-breakers in this order: algorithm key, arrival time, process ID.

- [ ] **Step 4: Add idle-time and zero-mutation regression cases**

Extend the test with an input whose first process arrives at time 3, assert the first timeline slice is `{ processId: 'idle', start: 0, end: 3 }`, and assert `input` remains deeply equal to a clone captured before simulation.

- [ ] **Step 5: Run CPU tests and all algorithm contract tests**

```powershell
pnpm.cmd vitest run tests/a3-cpu-scheduling.test.ts tests/a3-algorithm-lab-contracts.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit the CPU kernel**

```powershell
git add OpenMAIC/lib/a3/algorithm-lab/cpu-scheduling.ts OpenMAIC/tests/a3-cpu-scheduling.test.ts
git commit -m "feat: add deterministic CPU scheduling simulations"
```

### Task 3: Implement the Deterministic Page Replacement Kernel

**Files:**
- Create: `OpenMAIC/lib/a3/algorithm-lab/page-replacement.ts`
- Test: `OpenMAIC/tests/a3-page-replacement.test.ts`

- [ ] **Step 1: Write the failing canonical reference-string tests**

```ts
import { describe, expect, it } from 'vitest';
import { simulatePageReplacement } from '@/lib/a3/algorithm-lab/page-replacement';

const input = { referenceString: [7, 0, 1, 2, 0, 3, 0, 4, 2, 3, 0, 3, 2], frameCount: 3 };

describe('page replacement kernel', () => {
  it('returns canonical fault counts', () => {
    expect(simulatePageReplacement(input, 'fifo').finalMetrics.pageFaults).toBe(10);
    expect(simulatePageReplacement(input, 'lru').finalMetrics.pageFaults).toBe(9);
    expect(simulatePageReplacement(input, 'opt').finalMetrics.pageFaults).toBe(7);
  });

  it('records one immutable step per reference', () => {
    const run = simulatePageReplacement(input, 'lru');
    expect(run.steps).toHaveLength(input.referenceString.length);
    expect(run.steps.map((step) => step.state.currentPage)).toEqual(input.referenceString);
    expect(run.finalMetrics.hits + run.finalMetrics.pageFaults).toBe(input.referenceString.length);
    expect(run.resultFingerprint).toMatch(/^page:/);
  });

  it('never exceeds frame capacity', () => {
    for (const algorithm of ['fifo', 'lru', 'opt'] as const) {
      expect(simulatePageReplacement(input, algorithm).steps.every((step) => step.state.frames.length <= 3)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Verify the test fails because the page kernel is missing**

Run `pnpm.cmd vitest run tests/a3-page-replacement.test.ts`.

Expected: FAIL resolving `page-replacement`.

- [ ] **Step 3: Implement FIFO, LRU, and OPT with explanation evidence**

Export:

```ts
export type PageReplacementState = {
  referenceIndex: number;
  currentPage: number;
  frames: Array<number | null>;
  hit: boolean;
  evictedPage: number | null;
  fifoQueue: number[];
  recentUseOrder: number[];
  nextUseByPage: Record<string, number | null>;
};

export type PageReplacementMetrics = {
  pageFaults: number;
  hits: number;
  faultRate: number;
  evictions: number;
  finalFrames: Array<number | null>;
};

export function simulatePageReplacement(
  input: PageReplacementInput,
  algorithm: PageReplacementAlgorithm,
): SimulationRun<PageReplacementState, PageReplacementMetrics>;
```

Each step explanation must name the requested page, hit/fault result, victim when present, and the policy evidence: FIFO queue head, LRU last-use position, or OPT next-use distance. Fill empty frames before evicting. For OPT, choose the lowest frame index when multiple pages are never used again.

- [ ] **Step 4: Add tie-breaker, repeated-hit, and immutability tests**

Test `[1, 1, 1]` with two frames produces one fault and two hits for all algorithms. Test an OPT tie where two pages are never reused and assert the lower frame index is evicted. Freeze the caller input and verify no mutation exception occurs.

- [ ] **Step 5: Run both simulation suites**

```powershell
pnpm.cmd vitest run tests/a3-cpu-scheduling.test.ts tests/a3-page-replacement.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit the page replacement kernel**

```powershell
git add OpenMAIC/lib/a3/algorithm-lab/page-replacement.ts OpenMAIC/tests/a3-page-replacement.test.ts
git commit -m "feat: add page replacement simulations"
```

### Task 4: Add the Backend Lab Registry and Verified Completion API

**Files:**
- Create: `backend/apps/learning/algorithm_labs.py`
- Create: `backend/apps/learning/tests/test_algorithm_labs.py`
- Modify: `backend/apps/learning/effect_events.py`
- Modify: `backend/apps/learning/views.py`
- Modify: `backend/apps/learning/urls.py`

- [ ] **Step 1: Write failing API tests for authentication, catalog, verification, custom runs, and idempotency**

```py
import json
from django.test import TestCase
from django.urls import reverse
from backend.apps.accounts.models import User
from backend.apps.learning.models import LearningEvent

class AlgorithmLabApiTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800009991", password="TestPassword123")

    def test_catalog_requires_login(self):
        response = self.client.get(reverse("learning-algorithm-labs"))
        self.assertEqual(response.status_code, 401)

    def test_catalog_returns_two_versioned_labs(self):
        self.client.force_login(self.user)
        payload = self.client.get(reverse("learning-algorithm-labs")).json()
        self.assertTrue(payload["success"])
        self.assertEqual([item["id"] for item in payload["labs"]], ["cpu-scheduling", "page-replacement"])

    def test_known_preset_completion_is_verified_and_idempotent(self):
        self.client.force_login(self.user)
        request = known_cpu_completion(event_id="lab-complete-1")
        first = self.client.post(reverse("learning-algorithm-labs-complete"), json.dumps(request), content_type="application/json")
        second = self.client.post(reverse("learning-algorithm-labs-complete"), json.dumps(request), content_type="application/json")
        self.assertEqual(first.status_code, 201)
        self.assertTrue(first.json()["completion"]["verified"])
        self.assertEqual(second.json()["status"], "duplicate")
        self.assertEqual(LearningEvent.objects.filter(user=self.user, event_id="lab-complete-1").count(), 1)

    def test_custom_input_never_becomes_verified(self):
        self.client.force_login(self.user)
        request = known_cpu_completion(event_id="lab-custom-1")
        request.update({"customInput": True, "presetId": "", "presetVersion": "", "resultFingerprint": "cpu:custom"})
        payload = self.client.post(reverse("learning-algorithm-labs-complete"), json.dumps(request), content_type="application/json").json()
        self.assertFalse(payload["completion"]["verified"])
        self.assertFalse(payload["completion"]["masteryEvidenceAccepted"])

def known_cpu_completion(*, event_id: str) -> dict:
    return {
        "schemaVersion": "a3.algorithm-lab.completion.v1",
        "eventId": event_id,
        "labId": "cpu-scheduling",
        "labVersion": "1.0.0",
        "presetId": "cpu-foundation",
        "presetVersion": "1",
        "customInput": False,
        "selectedAlgorithms": ["fcfs", "sjf", "priority", "rr"],
        "prediction": {"answer": "sjf", "skipped": False, "correct": True},
        "checkpoints": {
            "answered": 2,
            "correct": 2,
            "items": [{"id": "cpu-ready-queue", "correct": True}, {"id": "cpu-completion-order", "correct": True}],
        },
        "metrics": {"score": 100, "durationSec": 493, "replayCount": 1, "reviewedStepIndexes": [2, 7, 11]},
        "resultFingerprint": "cpu-foundation-v1:fcfs=16f73a;priority=4486ac;rr=68370b;sjf=b16a65",
    }
```

The backend registry must use the same canonical fingerprint string from this test fixture. Task 2's kernel fingerprint builder must sort algorithm names and hash only normalized final metrics, so rendering changes cannot invalidate verification.

- [ ] **Step 2: Run tests and verify missing URL names**

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_algorithm_labs -v 2
```

Expected: FAIL with `Reverse for 'learning-algorithm-labs' not found`.

- [ ] **Step 3: Implement the server registry and completion validator**

`algorithm_labs.py` must define constants `ALGORITHM_LAB_SCHEMA_VERSION = "a3.algorithm-labs.catalog.v1"` and `ALGORITHM_LAB_COMPLETION_SCHEMA_VERSION = "a3.algorithm-lab.completion.v1"`, then export these exact callables: `list_algorithm_labs(user) -> dict`, `complete_algorithm_lab(user, payload: dict) -> dict`, and `build_algorithm_lab_effect(user, *, days: int = 30) -> dict`.

The registry stores the same lab/preset IDs and versions as the frontend plus expected result fingerprints. `complete_algorithm_lab` must:

1. Validate schema, event ID, lab ID/version, selected algorithms, bounded score/duration/replay/reviewed indexes, prediction shape, and checkpoint shape.
2. Mark a run verified only when the preset identity and fingerprint match the registry and `customInput` is false.
3. Store one `algorithm_lab_completed` event with `target_type="algorithm_lab"`, `target_id=lab_id`, `resource_type="interactive_lab"`, `score`, compact `quality`, and compact `metadata`.
4. Use `ingest_learning_event_v2` so repeated `eventId` is a duplicate rather than a second completion.
5. Return a deterministic next action: assessment for score >= 80, lab replay for lower score.

- [ ] **Step 4: Extend allowed event types and add the two views/routes**

Add exactly these event types to `ALLOWED_CLIENT_EVENT_TYPES`:

```py
"algorithm_lab_started",
"algorithm_lab_checkpoint_submitted",
"algorithm_lab_completed",
```

Add URL entries:

```py
path("algorithm-labs/", views.algorithm_labs, name="learning-algorithm-labs"),
path("algorithm-labs/complete/", views.complete_algorithm_lab_view, name="learning-algorithm-labs-complete"),
```

Both views call `_require_login`. The GET view returns catalog data. The POST view catches `ValueError` and returns HTTP 400 with its Chinese message; accepted completion returns 201 and duplicate returns 200.

- [ ] **Step 5: Add rejection tests for forged fingerprints and oversized payloads**

Assert a forged fingerprint returns an accepted but unverified completion, while an unknown lab, score above 100, more than 50 reviewed indexes, more than 20 checkpoint items, or an unsupported algorithm returns HTTP 400. Assert persisted metadata contains no `steps` key.

- [ ] **Step 6: Run backend tests and Django checks**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_algorithm_labs backend.apps.learning.tests.test_learning_events -v 2
backend\.venv\Scripts\python.exe backend\manage.py check
```

Expected: tests PASS and `System check identified no issues`.

- [ ] **Step 7: Commit the backend API slice**

```powershell
git add backend/apps/learning/algorithm_labs.py backend/apps/learning/tests/test_algorithm_labs.py backend/apps/learning/effect_events.py backend/apps/learning/views.py backend/apps/learning/urls.py
git commit -m "feat: add verified algorithm lab completion API"
```

### Task 5: Add the Frontend API Client, Learning Events, and Session Recovery

**Files:**
- Create: `OpenMAIC/lib/a3/algorithm-lab/client.ts`
- Create: `OpenMAIC/lib/a3/algorithm-lab/session.ts`
- Create: `OpenMAIC/tests/a3-algorithm-lab-session.test.ts`
- Modify: `OpenMAIC/lib/a3/learning-event-client.ts`
- Modify: `OpenMAIC/tests/a3-learning-event-client.test.ts`

- [ ] **Step 1: Write failing tests for event types and session serialization**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { clearLabSession, loadLabSession, saveLabSession } from '@/lib/a3/algorithm-lab/session';

describe('algorithm lab session recovery', () => {
  beforeEach(() => sessionStorage.clear());

  it('round-trips only the active unsubmitted session', () => {
    saveLabSession('cpu-scheduling', {
      schemaVersion: 'a3.algorithm-lab.session.v1', labId: 'cpu-scheduling', phase: 'paused', presetId: 'cpu-foundation',
      presetVersion: '1', selectedAlgorithms: ['fcfs', 'sjf'], input: { processes: [], timeQuantum: 2 },
      prediction: null, checkpointAnswers: {}, currentStepIndex: 3, replayCount: 0, reviewedStepIndexes: [1, 3], startedAt: '2026-07-31T00:00:00.000Z',
    });
    expect(loadLabSession('cpu-scheduling')?.currentStepIndex).toBe(3);
    clearLabSession('cpu-scheduling');
    expect(loadLabSession('cpu-scheduling')).toBeNull();
  });

  it('drops malformed and submitted sessions', () => {
    sessionStorage.setItem('a3.algorithmLab.cpu-scheduling', '{bad');
    expect(loadLabSession('cpu-scheduling')).toBeNull();
  });
});
```

Extend `a3-learning-event-client.test.ts` to build all three new event types and assert the generated payload keeps `targetType: "algorithm_lab"` and `resourceType: "interactive_lab"`.

- [ ] **Step 2: Run tests and verify missing modules/types**

```powershell
pnpm.cmd vitest run tests/a3-algorithm-lab-session.test.ts tests/a3-learning-event-client.test.ts
```

Expected: FAIL because `session.ts` and event union members are absent.

- [ ] **Step 3: Add typed API contracts and client calls**

`client.ts` must export `AlgorithmLabCatalogResponse`, `AlgorithmLabCompletionRequest`, `AlgorithmLabCompletionResponse`, `fetchAlgorithmLabCatalog()`, and `submitAlgorithmLabCompletion()`. Use `a3GetJson` and `a3PostJson` with only these endpoints:

```ts
'/api/learning/algorithm-labs/'
'/api/learning/algorithm-labs/complete/'
```

- [ ] **Step 4: Implement guarded session persistence**

Store one key per lab: `a3.algorithmLab.${labId}`. Validate schema version, matching lab ID, legal phase, finite nonnegative step/replay indexes, and a serialized size below 32 KB. Never store `SimulationStep[]`. Return `null` and remove the key when JSON is malformed, phase is `submitted`, or validation fails.

- [ ] **Step 5: Extend the event union and add event helpers**

Add the three event names and export:

```ts
export function trackAlgorithmLabStarted(input: Omit<A3LearningEventInput, 'eventType'>) {
  return trackLearningEvent({ ...input, eventType: 'algorithm_lab_started' });
}

export function trackAlgorithmLabCheckpoint(input: Omit<A3LearningEventInput, 'eventType'>) {
  return trackLearningEvent({ ...input, eventType: 'algorithm_lab_checkpoint_submitted' });
}
```

Completion must go through `submitAlgorithmLabCompletion`, not a second generic client event, so the server verifies and persists exactly one completion record.

- [ ] **Step 6: Run focused tests and typecheck**

```powershell
pnpm.cmd vitest run tests/a3-algorithm-lab-session.test.ts tests/a3-learning-event-client.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS and TypeScript exits 0.

- [ ] **Step 7: Commit client persistence**

```powershell
git add OpenMAIC/lib/a3/algorithm-lab/client.ts OpenMAIC/lib/a3/algorithm-lab/session.ts OpenMAIC/lib/a3/learning-event-client.ts OpenMAIC/tests/a3-algorithm-lab-session.test.ts OpenMAIC/tests/a3-learning-event-client.test.ts
git commit -m "feat: add algorithm lab session and event clients"
```

### Task 6: Add the Lab Catalog Route and Navigation Entry

**Files:**
- Create: `OpenMAIC/app/a3/labs/page.tsx`
- Create: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-catalog-view.tsx`
- Modify: `OpenMAIC/lib/a3/navigation.ts`
- Modify: `OpenMAIC/lib/a3/i18n.ts`
- Modify: `OpenMAIC/components/a3/layout/a3-shell.tsx`
- Modify: `OpenMAIC/components/a3/features/assessment-view.tsx`
- Modify: `OpenMAIC/tests/a3-navigation-consolidation.test.ts`
- Test: `OpenMAIC/tests/a3-algorithm-lab-ui.test.ts`

- [ ] **Step 1: Extend navigation tests before implementation**

Add assertions that the primary list is still six items, `/a3/assessment` children are exactly `练习中心`, `错题本`, `交互实验`, and `a3GetActiveNavHref('/a3/labs/cpu-scheduling')` is `/a3/assessment`. Add source assertions for a visible `/a3/labs` action in `assessment-view.tsx`.

- [ ] **Step 2: Add a failing catalog UI source test**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('algorithm lab UI', () => {
  it('has catalog loading, error, empty, progress and resume states', () => {
    const source = readFileSync(join(process.cwd(), 'components/a3/features/algorithm-lab/algorithm-lab-catalog-view.tsx'), 'utf8');
    expect(source).toContain('正在读取实验进度');
    expect(source).toContain('重新加载');
    expect(source).toContain('暂无可用实验');
    expect(source).toContain('继续上次实验');
    expect(source).toContain('verifiedRuns');
  });
});
```

- [ ] **Step 3: Run the two tests and verify failure**

```powershell
pnpm.cmd vitest run tests/a3-navigation-consolidation.test.ts tests/a3-algorithm-lab-ui.test.ts
```

Expected: FAIL because `/a3/labs` and catalog files are absent.

- [ ] **Step 4: Implement route, navigation, and catalog states**

The page file renders `<AlgorithmLabCatalogView />`. The catalog fetches the real backend API on mount, shows two individual lab rows/cards with title, learning purpose, estimated time, available algorithms, verified progress, and one clear action. Keep the page unframed; cards are only the repeated lab items. Rank a `recommended: true` item first when provided by the backend. Recover local unfinished session metadata and show one resume band above the list.

Add `{ href: '/a3/labs', label: '交互实验' }` to assessment children and `{ prefix: '/a3/labs', owner: '/a3/assessment' }` to secondary owners. Add Chinese and English i18n labels and owner-page labels in `a3-shell.tsx`.

- [ ] **Step 5: Verify catalog/navigation behavior**

```powershell
pnpm.cmd vitest run tests/a3-navigation-consolidation.test.ts tests/a3-algorithm-lab-ui.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS and no seventh primary student item.

- [ ] **Step 6: Commit catalog and navigation**

```powershell
git add OpenMAIC/app/a3/labs/page.tsx OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-catalog-view.tsx OpenMAIC/lib/a3/navigation.ts OpenMAIC/lib/a3/i18n.ts OpenMAIC/components/a3/layout/a3-shell.tsx OpenMAIC/components/a3/features/assessment-view.tsx OpenMAIC/tests/a3-navigation-consolidation.test.ts OpenMAIC/tests/a3-algorithm-lab-ui.test.ts
git commit -m "feat: add algorithm lab catalog"
```

### Task 7: Build the Shared Workbench and Playback State Machine

**Files:**
- Create: `OpenMAIC/app/a3/labs/[labId]/page.tsx`
- Create: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-workbench.tsx`
- Create: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-layout.tsx`
- Create: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-controls.tsx`
- Create: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-input-panel.tsx`
- Create: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-status-panel.tsx`
- Create: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-step-explanation.tsx`
- Modify: `OpenMAIC/tests/a3-algorithm-lab-ui.test.ts`

- [ ] **Step 1: Add failing source-contract tests for the workbench**

Assert the workbench contains the phases `idle`, `configured`, `predicted`, `running`, `paused`, `completed`, `submitted`; the controls contain accessible names `播放`, `暂停`, `上一步`, `下一步`, `重置`, `全屏画布`; and layout classes include stable desktop tracks and a `min-h-[430px]` canvas region.

- [ ] **Step 2: Run the UI test and verify missing components**

Run `pnpm.cmd vitest run tests/a3-algorithm-lab-ui.test.ts`.

Expected: FAIL reading workbench files.

- [ ] **Step 3: Implement the dynamic route and unknown-lab state**

The route obtains `params.labId` and renders `<AlgorithmLabWorkbench labId={labId} />`. Unknown IDs show `未找到该实验` and a real link to `/a3/labs`; they must not throw or redirect in a loop.

- [ ] **Step 4: Implement one reducer-owned playback state**

The workbench reducer owns `phase`, input, selected algorithms, prediction, simulation runs, current step, speed, checkpoints, replay count, reviewed indexes, sync state, and started timestamp. Use these actions:

```ts
type AlgorithmLabAction =
  | { type: 'configure'; input: AlgorithmLabInput; algorithms: AlgorithmLabAlgorithm[] }
  | { type: 'predict'; answer: string | null; skipped: boolean }
  | { type: 'start'; runs: SimulationRun<unknown, unknown>[] }
  | { type: 'pause' }
  | { type: 'seek'; index: number }
  | { type: 'advance' }
  | { type: 'rewind' }
  | { type: 'finish' }
  | { type: 'answer_checkpoint'; checkpointId: string; answer: string }
  | { type: 'sync_pending' }
  | { type: 'sync_failed'; message: string }
  | { type: 'submitted' }
  | { type: 'reset' };
```

Use one timer effect driven by phase and speed. Cleanup the timer on pause, unmount, reset, and final step. Seeking never recomputes runs or emits a learning event. Input/algorithm changes invalidate old runs and return to `configured`.

- [ ] **Step 5: Implement the professional responsive layout**

Desktop uses `grid-cols-[280px_minmax(0,1fr)_300px]`; tablet places two collapsible setup/status panels above a full-width canvas; mobile uses a segmented `输入 / 运行 / 结果` view and one algorithm at a time. Keep controls in document flow below the canvas, not fixed to viewport. Explanation/log content is collapsed initially and scrolls independently when expanded.

- [ ] **Step 6: Wire local recovery and started-event behavior**

Restore only an unsubmitted session. Recompute runs from restored input rather than storing steps. Emit `algorithm_lab_started` once when the first valid run begins, with lab/preset/version metadata. Save compact state after meaningful changes and clear it after accepted completion.

- [ ] **Step 7: Run UI tests and typecheck**

```powershell
pnpm.cmd vitest run tests/a3-algorithm-lab-ui.test.ts tests/a3-algorithm-lab-session.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS and TypeScript exits 0.

- [ ] **Step 8: Commit the workbench shell**

```powershell
git add OpenMAIC/app/a3/labs/[labId]/page.tsx OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-workbench.tsx OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-layout.tsx OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-controls.tsx OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-input-panel.tsx OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-status-panel.tsx OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-step-explanation.tsx OpenMAIC/tests/a3-algorithm-lab-ui.test.ts
git commit -m "feat: build algorithm lab workbench"
```

### Task 8: Add CPU Scheduling Visualization, Prediction, and Checkpoints

**Files:**
- Create: `OpenMAIC/components/a3/features/algorithm-lab/cpu-scheduling-visualizer.tsx`
- Create: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-checkpoint.tsx`
- Modify: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-input-panel.tsx`
- Modify: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-status-panel.tsx`
- Modify: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-workbench.tsx`
- Modify: `OpenMAIC/tests/a3-algorithm-lab-ui.test.ts`

- [ ] **Step 1: Add failing CPU visualization assertions**

Assert source includes a stable time ruler, one Gantt row per selected algorithm, process-color mapping by process ID, ready queue, active-process detail, all five metrics, prediction prompt, two checkpoint IDs, and `data-testid="cpu-scheduling-canvas"`.

- [ ] **Step 2: Run UI tests and observe missing CPU visualizer**

Expected: FAIL until the component exists and is wired by lab ID.

- [ ] **Step 3: Implement editable process input with bounded controls**

Allow add/remove process rows within `1..12`, numeric inputs for arrival/burst/priority, and RR quantum. Show inline validator messages and disable Run when invalid. Preset selection clones preset input. Switching to edited values marks the run `customInput: true`.

- [ ] **Step 4: Implement stable Gantt comparison and status metrics**

Render an HTML/CSS/SVG hybrid canvas without adding a chart dependency. Derive x positions from total elapsed time, keep a process's color stable across algorithms, show a current-time line, and use text/icon cues in addition to color. Do not animate layout dimensions; animate only the current marker and state emphasis with 160–220 ms transitions. Clicking a segment seeks to its first matching step.

- [ ] **Step 5: Add prediction and checkpoints without answer leakage**

Before first run ask which selected algorithm will have the lowest average waiting time; allow explicit skip. Reveal correctness only after final step. Use checkpoint IDs `cpu-ready-queue` and `cpu-completion-order`; each submission emits `algorithm_lab_checkpoint_submitted` once with correctness and step index.

- [ ] **Step 6: Verify CPU interaction tests and typecheck**

```powershell
pnpm.cmd vitest run tests/a3-cpu-scheduling.test.ts tests/a3-algorithm-lab-ui.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit CPU visualization**

```powershell
git add OpenMAIC/components/a3/features/algorithm-lab/cpu-scheduling-visualizer.tsx OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-checkpoint.tsx OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-input-panel.tsx OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-status-panel.tsx OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-workbench.tsx OpenMAIC/tests/a3-algorithm-lab-ui.test.ts
git commit -m "feat: visualize CPU scheduling lab"
```

### Task 9: Add Page Replacement Visualization, Prediction, and Checkpoints

**Files:**
- Create: `OpenMAIC/components/a3/features/algorithm-lab/page-replacement-visualizer.tsx`
- Modify: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-input-panel.tsx`
- Modify: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-status-panel.tsx`
- Modify: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-workbench.tsx`
- Modify: `OpenMAIC/tests/a3-algorithm-lab-ui.test.ts`

- [ ] **Step 1: Add failing page-replacement visualization assertions**

Assert the source contains reference sequence, frame matrix, hit/fault status, victim cue, FIFO/LRU/OPT policy evidence, four metrics, checkpoint IDs `page-victim` and `page-policy-reason`, and `data-testid="page-replacement-canvas"`.

- [ ] **Step 2: Run UI tests and observe missing component failure**

Run `pnpm.cmd vitest run tests/a3-algorithm-lab-ui.test.ts`.

Expected: FAIL reading or locating the page replacement visualizer.

- [ ] **Step 3: Implement sequence/frame input and visualization**

Accept comma- or space-separated nonnegative integer pages and frame count `1..8`; normalize through the shared validator. Show the current reference with a focus ring, one row per algorithm, fixed frame slots, and clear icon/text states for hit, fault, evicted, inserted, and unchanged. A clicked historical column seeks without rerunning.

- [ ] **Step 4: Show policy evidence and comparison metrics**

For each current algorithm show FIFO queue, LRU recent-use order, or OPT next-use distances. Metrics show faults, hits, fault rate, and evictions. The result panel identifies the lowest-fault algorithm, explains ties, and never claims one policy is universally optimal beyond the current reference string.

- [ ] **Step 5: Add prediction and checkpoint flow**

Ask which selected algorithm will have the fewest faults before running. At deterministic steps ask which page is evicted and why. Hide correctness until submission; emit one checkpoint event per answer.

- [ ] **Step 6: Run kernel/UI tests and typecheck**

```powershell
pnpm.cmd vitest run tests/a3-page-replacement.test.ts tests/a3-algorithm-lab-ui.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit page visualization**

```powershell
git add OpenMAIC/components/a3/features/algorithm-lab/page-replacement-visualizer.tsx OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-input-panel.tsx OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-status-panel.tsx OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-workbench.tsx OpenMAIC/tests/a3-algorithm-lab-ui.test.ts
git commit -m "feat: visualize page replacement lab"
```

### Task 10: Make Completion Synchronization Retry-Safe

**Files:**
- Modify: `OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-workbench.tsx`
- Modify: `OpenMAIC/lib/a3/algorithm-lab/client.ts`
- Modify: `OpenMAIC/tests/a3-algorithm-lab-session.test.ts`
- Modify: `backend/apps/learning/tests/test_algorithm_labs.py`

- [ ] **Step 1: Add failing completion-gate tests**

Add reducer tests or exported pure helper tests asserting submission is blocked until the run reached its final step and both checkpoints are answered; submission payload contains no `steps`; retry reuses the same `eventId`; accepted or duplicate clears the local session; network failure keeps the completed result and exposes `重新同步学习记录`.

- [ ] **Step 2: Run focused frontend tests and verify failure**

```powershell
pnpm.cmd vitest run tests/a3-algorithm-lab-session.test.ts tests/a3-algorithm-lab-ui.test.ts
```

Expected: FAIL because completion gating/sync states are incomplete.

- [ ] **Step 3: Build the compact completion request from local evidence**

Compute score as checkpoint accuracy on a 0–100 scale. Include prediction correctness separately, deduplicate/sort reviewed indexes, cap them at 50, and carry the result fingerprint emitted by the selected run(s). For multi-algorithm presets, calculate one deterministic combined fingerprint from sorted `algorithm:fingerprint` pairs; the exact same function and expected value must be represented in the server registry.

- [ ] **Step 4: Implement retry-safe success/error states**

Generate one completion event ID when the run first becomes completed and persist it in session state. Disable the submit button while in flight. HTTP success with `accepted` or `duplicate` transitions to `submitted`, clears session, and shows verified/unverified evidence plus the real next-action link. A fetch/5xx failure transitions to `event_sync_failed`, preserves results, and presents retry without rerunning the algorithm.

- [ ] **Step 5: Add backend duplicate and verification regressions**

Assert duplicate retries return the original event-derived completion summary, not a newly calculated divergent response. Assert an event from another user with the same `eventId` does not block the current user.

- [ ] **Step 6: Run completion tests**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-algorithm-lab-session.test.ts tests/a3-algorithm-lab-ui.test.ts
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_algorithm_labs -v 2
```

Expected: PASS.

- [ ] **Step 7: Commit durable completion behavior**

```powershell
git add OpenMAIC/components/a3/features/algorithm-lab/algorithm-lab-workbench.tsx OpenMAIC/lib/a3/algorithm-lab/client.ts OpenMAIC/tests/a3-algorithm-lab-session.test.ts backend/apps/learning/tests/test_algorithm_labs.py
git commit -m "feat: make algorithm lab completion retry safe"
```

### Task 11: Connect Recommendations, Today Tasks, Learning Path, and Resource Actions

**Files:**
- Modify: `backend/apps/compat/recommendations.py`
- Modify: `backend/apps/learning/services.py`
- Create: `backend/apps/learning/tests/test_algorithm_lab_recommendations.py`
- Modify: `OpenMAIC/lib/a3/recommendation-types.ts`
- Modify: `OpenMAIC/lib/a3/learning-types.ts`
- Modify: `OpenMAIC/components/a3/features/recommendations-view.tsx`
- Modify: `OpenMAIC/components/a3/features/today-learning-view.tsx`
- Modify: `OpenMAIC/components/a3/features/learning-path-view.tsx`
- Modify: `OpenMAIC/components/a3/features/resource-standalone-view.tsx`
- Create: `OpenMAIC/tests/a3-algorithm-lab-entry-points.test.ts`
- Test: `OpenMAIC/tests/a3-recommendation-ranking.test.ts`
- Test: `OpenMAIC/tests/a3-resource-workbench.test.ts`
- Test: `OpenMAIC/tests/a3-today-resource-feedback-layout.test.ts`
- Test: `backend/apps/compat/tests/test_recommendations.py`
- Test: `backend/apps/learning/tests/test_study_plan_adaptation.py`

- [ ] **Step 1: Write failing contract tests for real lab actions**

Cover these additive shapes:

```ts
type InteractiveLabAction = {
  kind: 'interactive_lab';
  label: string;
  href: `/a3/labs/${'cpu-scheduling' | 'page-replacement'}`;
  labId: 'cpu-scheduling' | 'page-replacement';
  presetId?: string;
  reason: string;
};
```

Assert OS scheduling weak points resolve to `/a3/labs/cpu-scheduling`, virtual-memory/page-replacement weak points resolve to `/a3/labs/page-replacement`, unrelated knowledge points preserve their existing actions, and `code_lab.relatedLab` is optional.

- [ ] **Step 2: Run focused tests and confirm contract failures**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-algorithm-lab-entry-points.test.ts tests/a3-recommendation-ranking.test.ts tests/a3-resource-workbench.test.ts tests/a3-today-resource-feedback-layout.test.ts
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_algorithm_lab_recommendations backend.apps.compat.tests.test_recommendations backend.apps.learning.tests.test_study_plan_adaptation -v 2
```

Expected: the new entry-point and mapper assertions FAIL; existing recommendation and plan cases continue to run.

- [ ] **Step 3: Add a deterministic backend knowledge-point-to-lab mapper**

Implement one shared helper in `backend/apps/learning/algorithm_labs.py`:

```py
def recommend_algorithm_lab(knowledge_point: str, weak_points: list[str] | None = None) -> dict | None:
    normalized = " ".join([str(knowledge_point or ""), *[str(item) for item in (weak_points or [])]]).lower()
    if any(token in normalized for token in ("调度", "cpu", "进程调度", "processor scheduling")):
        return {"kind": "interactive_lab", "labId": "cpu-scheduling", "presetId": "cpu-misconception", "href": "/a3/labs/cpu-scheduling"}
    if any(token in normalized for token in ("页面置换", "虚拟内存", "缺页", "page replacement")):
        return {"kind": "interactive_lab", "labId": "page-replacement", "presetId": "page-misconception", "href": "/a3/labs/page-replacement"}
    return None
```

Import this helper into recommendation and plan services rather than duplicating keyword rules.

- [ ] **Step 4: Add lab actions without replacing existing primary data**

Recommendations may expose `action.kind = interactive_lab` when the target weak point matches. Today tasks retain their current task IDs/status/completion API but use the lab URL and task type string `interactive_lab`. Learning path nodes and `code_lab` resource details add a secondary `relatedLab` action. Existing consumers that do not know this field continue to render their current action.

- [ ] **Step 5: Render one consistent action treatment**

Use `FlaskConical` or the nearest existing Lucide lab icon, A3 deep green command styling, preset query parameter only when present, and a concise reason. Do not create a seventh dashboard card or duplicate the full lab catalog in these pages.

- [ ] **Step 6: Run frontend and backend integration tests**

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd vitest run tests/a3-navigation-consolidation.test.ts tests/a3-algorithm-lab-ui.test.ts
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_algorithm_labs backend.apps.learning.tests.test_algorithm_lab_recommendations backend.apps.compat.tests.test_recommendations backend.apps.learning.tests.test_study_plan_adaptation -v 2
```

Expected: PASS; existing non-OS recommendation actions remain unchanged.

- [ ] **Step 7: Commit learning-loop entry points**

```powershell
git add backend/apps/learning/algorithm_labs.py backend/apps/compat/recommendations.py backend/apps/learning/services.py backend/apps/learning/tests/test_algorithm_lab_recommendations.py OpenMAIC/lib/a3/recommendation-types.ts OpenMAIC/lib/a3/learning-types.ts OpenMAIC/components/a3/features/recommendations-view.tsx OpenMAIC/components/a3/features/today-learning-view.tsx OpenMAIC/components/a3/features/learning-path-view.tsx OpenMAIC/components/a3/features/resource-standalone-view.tsx OpenMAIC/tests/a3-algorithm-lab-entry-points.test.ts
git commit -m "feat: connect algorithm labs to learning actions"
```

### Task 12: Add Algorithm Lab Evidence to the Learning Report

**Files:**
- Modify: `backend/apps/learning/algorithm_labs.py`
- Modify: `backend/apps/assessments/services.py`
- Modify: `backend/apps/assessments/tests/test_assessment_flow.py`
- Modify: `OpenMAIC/lib/a3/assessment-types.ts`
- Modify: `OpenMAIC/lib/a3/report-view-model.ts`
- Modify: `OpenMAIC/components/a3/features/report-view.tsx`
- Add or modify the focused report view-model test.

- [ ] **Step 1: Write a failing report aggregation test**

Create verified and unverified `algorithm_lab_completed` events inside/outside the requested report period. Assert `build_learning_report(user, "7d")` includes:

```py
"algorithmLabEffect": {
    "completedRuns": 2,
    "verifiedRuns": 1,
    "predictionAccuracy": 100.0,
    "checkpointAccuracy": 75.0,
    "reviewedStepCount": 3,
    "byLab": [{"labId": "cpu-scheduling", "completedRuns": 2, "bestScore": 100.0}],
    "commonReviewSignals": [{"stepIndex": 7, "count": 2}],
    "nextAction": {"label": "继续交互实验", "href": "/a3/labs"},
}
```

Assert only verified runs may be described as mastery evidence; unverified runs still count as exploration activity.

- [ ] **Step 2: Run the report test and verify missing field failure**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_assessment_flow -v 2
```

Expected: the new assertion FAILS because `algorithmLabEffect` is absent.

- [ ] **Step 3: Implement bounded event aggregation**

Filter the report period once, select only `algorithm_lab_completed`, and aggregate compact metadata in Python. Limit `byLab` to known labs and `commonReviewSignals` to five entries. Return structurally complete zero values when no events exist. Add `algorithmLabEffect` to `build_learning_report` without removing or renaming legacy fields.

- [ ] **Step 4: Add the TypeScript report contract and view model**

Add an optional `algorithmLabEffect` type matching the backend. Derive a report section only when `completedRuns > 0`, with plain-language conclusions:

- `你完成了 N 次算法实验，其中 M 次使用标准案例，可作为掌握证据。`
- `预测准确率` and `检查题正确率` are shown as different concepts.
- The next action links to a specific weak lab when `byLab` indicates low score, otherwise `/a3/labs`.

- [ ] **Step 5: Render an un-nested evidence section**

In `report-view.tsx`, add one full-width report band after knowledge-point insights, not a card nested inside another card. Show completion, prediction, checkpoint, and review metrics, a verified-evidence label, and one command button. Empty reports do not show fabricated improvement.

- [ ] **Step 6: Run report tests and typecheck**

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.assessments.tests.test_assessment_flow backend.apps.assessments.tests.test_learning_report_v2 -v 2
cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
```

Expected: PASS and legacy report contract tests remain green.

- [ ] **Step 7: Commit report evidence**

```powershell
git add backend/apps/learning/algorithm_labs.py backend/apps/assessments/services.py backend/apps/assessments/tests/test_assessment_flow.py OpenMAIC/lib/a3/assessment-types.ts OpenMAIC/lib/a3/report-view-model.ts OpenMAIC/components/a3/features/report-view.tsx
git commit -m "feat: report algorithm lab evidence"
```

### Task 13: Verify Responsive, Accessible, and End-to-End Behavior

**Files:**
- Create: `OpenMAIC/e2e/tests/a3-algorithm-lab.spec.ts`
- Modify: algorithm-lab components only when failures demonstrate a defect.

- [ ] **Step 1: Write the E2E flow before polishing implementation**

The Playwright test must authenticate using the repository's existing A3 test fixture, open `/a3/labs`, enter CPU scheduling, select a known preset, answer or skip prediction, run to completion using the Next Step control, answer checkpoints, submit, verify the success state, reload, and confirm the completed progress is returned by the backend. Add a page-replacement smoke path that reaches a visible frame matrix.

```ts
test('student completes a verified CPU scheduling lab', async ({ page }) => {
  await page.goto('/a3/labs');
  await page.getByRole('link', { name: /CPU 调度算法对比/ }).click();
  await page.getByLabel('预设案例').selectOption('cpu-foundation');
  await page.getByRole('button', { name: '运行实验' }).click();
  await page.getByRole('button', { name: '跳过预测' }).click();
  while (await page.getByRole('button', { name: '下一步' }).isEnabled()) {
    await page.getByRole('button', { name: '下一步' }).click();
  }
  await expect(page.getByText('实验运行完成')).toBeVisible();
});
```

Adapt ordering to the implemented prediction gate while preserving role-based selectors; do not use arbitrary sleeps.

- [ ] **Step 2: Run E2E and capture the first concrete failures**

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd playwright test e2e/tests/a3-algorithm-lab.spec.ts --project=chromium
```

Expected before fixes: FAIL only on actual selector, fixture, or behavior gaps; document each failure in the task notes before editing.

- [ ] **Step 3: Add keyboard and reduced-motion coverage**

Verify all controls are reachable by Tab, Enter/Space activate icon buttons, slider has an accessible label/value, current step is announced in an `aria-live="polite"` region without announcing every autoplay tick, and `prefers-reduced-motion: reduce` removes nonessential transitions while preserving state changes.

- [ ] **Step 4: Verify desktop, tablet, and mobile geometry**

Run at `1440x900`, `1024x768`, and `390x844`. Assert no body horizontal overflow, controls remain visible, canvas min heights are respected, labels do not overlap, and mobile shows segmented input/run/result views. Store screenshots in Playwright output only; do not commit generated screenshots unless the repository's snapshot pattern requires them.

- [ ] **Step 5: Run E2E until green and run focused frontend tests**

```powershell
npx.cmd playwright test e2e/tests/a3-algorithm-lab.spec.ts --project=chromium
pnpm.cmd vitest run tests/a3-algorithm-lab-contracts.test.ts tests/a3-cpu-scheduling.test.ts tests/a3-page-replacement.test.ts tests/a3-algorithm-lab-session.test.ts tests/a3-algorithm-lab-ui.test.ts tests/a3-learning-event-client.test.ts tests/a3-navigation-consolidation.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit E2E and accessibility fixes**

```powershell
git add OpenMAIC/e2e/tests/a3-algorithm-lab.spec.ts OpenMAIC/components/a3/features/algorithm-lab
git commit -m "test: cover algorithm lab student flow"
```

Inspect `git diff --cached --name-only` before commit and unstage any algorithm-lab file not intentionally changed by this task.

### Task 14: Run Full Regression Verification and Update Delivery Evidence

**Files:**
- Modify only if verification reveals a lab-specific regression.
- Reference: `docs/superpowers/specs/2026-07-31-a3-os-interactive-algorithm-lab-design.md`
- Reference: `docs/superpowers/plans/2026-07-31-a3-os-interactive-algorithm-lab.md`

- [ ] **Step 1: Review implementation against every design invariant**

Confirm both routes, two P0 labs, seven algorithms, prediction, checkpoints, playback controls, session recovery, verified/custom distinction, compact events, six primary nav groups, recommendation/today/path/resource links, report evidence, responsive states, and no mandatory model/GPU dependency. Record any mismatch as a concrete failing test before changing code.

- [ ] **Step 2: Scan for forbidden placeholders and accidental secrets**

```powershell
cd D:\Download\A3
$redFlags = @('T' + 'BD', 'T' + 'ODO', 'F' + 'IXME', 'mock' + ' success', 'api' + '[_-]?key', 'signed' + '.?url', 'D:' + '\\Download')
rg -n ($redFlags -join '|') OpenMAIC/app/a3/labs OpenMAIC/components/a3/features/algorithm-lab OpenMAIC/lib/a3/algorithm-lab backend/apps/learning/algorithm_labs.py
```

Expected: no output. Legitimate test fixture labels must be rewritten so this scan remains clean.

- [ ] **Step 3: Run the complete frontend validation set**

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/a3-algorithm-lab-contracts.test.ts tests/a3-cpu-scheduling.test.ts tests/a3-page-replacement.test.ts tests/a3-algorithm-lab-session.test.ts tests/a3-algorithm-lab-ui.test.ts tests/a3-learning-event-client.test.ts tests/a3-navigation-consolidation.test.ts tests/a3-openmaic-page-ownership.test.ts
npx.cmd playwright test e2e/tests/a3-algorithm-lab.spec.ts e2e/tests/a3-sidebar-navigation.spec.ts --project=chromium
```

Expected: TypeScript and tests exit 0. Lint may report only the historical warnings listed in `AGENTS.md`; no new algorithm-lab warning is acceptable.

- [ ] **Step 4: Run the complete backend validation set**

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_algorithm_labs backend.apps.learning.tests.test_learning_events backend.apps.assessments.tests.test_assessment_flow backend.apps.assessments.tests.test_learning_report_v2 -v 2
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

Expected: system check has no issues, tests PASS, and strict demo validation succeeds without a new missing-evidence error.

- [ ] **Step 5: Inspect the final diff and database migration state**

```powershell
git status --short --branch
git diff --check
backend\.venv\Scripts\python.exe backend\manage.py makemigrations --check --dry-run
```

Expected: no whitespace errors, `No changes detected`, and only intended implementation files plus pre-existing unrelated worktree changes are present.

- [ ] **Step 6: Commit any verification-only correction**

If Step 1–5 required a correction, stage only the named corrected files and commit:

```powershell
git commit -m "fix: close algorithm lab verification gaps"
```

If no correction was needed, do not create an empty commit.

- [ ] **Step 7: Prepare the deployment handoff without deploying**

Report the final commit SHA, frontend/backend image impact, absence of migrations, test results, and these deployment services:

```text
backend
frontend
caddy
```

`celery` and `celery-beat` do not require recreation for P0 because simulations run in the browser and completion writes are synchronous compact events. Deployment remains a separate user-approved action.

## Final Acceptance Checklist

- [ ] `/a3/labs` loads real backend catalog/progress and has loading, error, empty, resume, and success states.
- [ ] `/a3/labs/cpu-scheduling` deterministically compares FCFS, SJF, non-preemptive priority, and RR.
- [ ] `/a3/labs/page-replacement` deterministically compares FIFO, LRU, and OPT.
- [ ] Prediction answers are not revealed before a run completes.
- [ ] Playback supports play/pause, previous/next, speed, seek, reset, first-difference jump, and fullscreen.
- [ ] Checkpoint answers produce compact, idempotent learning evidence.
- [ ] Server-known presets are verified; custom/forged results are never mastery evidence.
- [ ] No full step array is sent to or stored by Django.
- [ ] Refresh restores unfinished local sessions and accepted completion clears them.
- [ ] Recommendation, today task, learning path, and resource detail can link to a precise lab.
- [ ] Learning report distinguishes exploration runs from verified evidence.
- [ ] Six primary student navigation groups remain unchanged.
- [ ] Desktop, tablet, mobile, keyboard, and reduced-motion checks pass.
- [ ] No new model API key, GPU dependency, database migration, or mock success path is introduced.
