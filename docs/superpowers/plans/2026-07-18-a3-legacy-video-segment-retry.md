# A3 Legacy Video Segment Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将无 `jobId` 的旧 partial 视频安全导入持久化任务，只生成失败片段，并在产生费用前要求用户确认。

**Architecture:** Django 从用户自己的资源包读取旧 artifact，并以确定性 job ID 导入成功片段、排队失败片段；Next 只构造六段提示词并代理请求，不能提交成功视频 URL。资源视频页识别旧 artifact，显示确认对话框，提交后复用现有持久化 job 轮询与失败片段重试。

**Tech Stack:** Django 6、MySQL、Celery、Next.js 16、React 19、TypeScript、Radix AlertDialog、Vitest、Django TestCase

---

## File Map

- Modify: `backend/apps/compat/video_jobs.py` - 旧 artifact 资格判定、确定性 job ID、segment 导入和幂等派发。
- Modify: `backend/apps/compat/views.py` - 登录、资源包所有权和 legacy import HTTP 响应。
- Modify: `backend/apps/compat/urls.py` - 注册 legacy import 路由。
- Modify: `backend/apps/compat/tests/test_video_generation_jobs.py` - 服务、权限、幂等、URL 信任边界和 API 回归测试。
- Create: `OpenMAIC/lib/a3/video-prompt.ts` - 推荐页和旧视频迁移共用的视频 prompt 构造器。
- Create: `OpenMAIC/tests/a3-video-prompt.test.ts` - prompt 提取后的行为测试。
- Modify: `OpenMAIC/components/a3/features/recommendations-view.tsx` - 改用共享 prompt 构造器，不改变新任务行为。
- Modify: `OpenMAIC/app/api/a3/resources/openmaic-video/route.ts` - 增加 `import-legacy-failures` 代理 action。
- Modify: `OpenMAIC/tests/a3-openmaic-video-job-status.test.ts` - 代理契约和禁止传递成功 URL。
- Modify: `OpenMAIC/components/a3/features/resource-video-view.tsx` - 旧 artifact 识别、确认框、提交、轮询和刷新恢复。
- Modify: `OpenMAIC/tests/a3-resource-video-segments.test.ts` - 确认交互和 legacy retry UI 契约。
- Modify: `OpenMAIC/e2e/tests/a3-resource-feedback-loop.spec.ts` - 浏览器确认与取消流程。
- Modify: `docs/A3_GHCR前端镜像部署.md` - 增加旧视频迁移生产验收命令和回滚说明。

### Task 1: Backend Legacy Import Domain Service

**Files:**
- Modify: `backend/apps/compat/video_jobs.py`
- Test: `backend/apps/compat/tests/test_video_generation_jobs.py`

- [ ] **Step 1: Add failing service tests for successful-segment preservation and failed-only queueing**

Add a test pack fixture with one failed segment and one server-owned succeeded segment. Call the wished-for service directly:

```python
from backend.apps.compat.video_jobs import create_legacy_video_retry_job

@patch("backend.apps.compat.video_jobs.current_app.send_task")
def test_import_legacy_video_preserves_success_and_queues_only_failures(self, send_task):
    send_task.return_value.id = "celery-legacy-001"
    pack = {
        "resourcePackId": "pack-api-001",
        "multimodalArtifacts": [{
            "type": "openmaic_video",
            "status": "partial",
            "createdAt": "2026-07-18T00:00:00Z",
            "segments": [
                {"index": 1, "title": "导入", "status": "failed", "videoUrl": "", "duration": 10},
                {"index": 2, "title": "概念", "status": "succeeded", "videoUrl": "https://server.invalid/kept.mp4", "duration": 10, "width": 1920, "height": 1080},
            ],
        }],
    }
    payload = {
        "provider": "seedance",
        "segments": [
            {"index": 1, "title": "导入", "prompt": "第一段 prompt", "duration": 10},
            {"index": 2, "title": "概念", "prompt": "第二段 prompt", "duration": 10, "videoUrl": "https://attacker.invalid/fake.mp4"},
        ],
    }

    with self.captureOnCommitCallbacks(execute=True):
        job, created, imported, queued = create_legacy_video_retry_job(
            self.user, "pack-api-001", pack, payload
        )

    self.assertTrue(created)
    self.assertEqual((imported, queued), (1, 1))
    self.assertEqual(job.segments.get(index=1).status, "pending")
    kept = job.segments.get(index=2)
    self.assertEqual(kept.status, "succeeded")
    self.assertEqual(kept.video_url, "https://server.invalid/kept.mp4")
    self.assertNotEqual(kept.video_url, payload["segments"][1]["videoUrl"])
    send_task.assert_called_once_with("compat.advance_video_generation_job", args=[job.job_id])
```

- [ ] **Step 2: Run the service test and verify RED**

Run:

```powershell
$env:DJANGO_DEBUG='1'
$env:A3_TEST_SQLITE_PATH='D:/Download/A3/.tmp/legacy-video-service.sqlite3'
& 'D:/Download/A3/backend/.venv/Scripts/python.exe' backend/manage.py test `
  backend.apps.compat.tests.test_video_generation_jobs.VideoGenerationJobApiTests.test_import_legacy_video_preserves_success_and_queues_only_failures `
  --settings=backend.config.test_sqlite_settings --noinput
```

Expected: FAIL because `create_legacy_video_retry_job` does not exist.

- [ ] **Step 3: Add deterministic fingerprint and artifact validation**

Implement focused helpers in `video_jobs.py`:

```python
import hashlib
import json
from django.utils import timezone

def eligible_legacy_video_artifact(pack: dict) -> dict | None:
    artifacts = pack.get("multimodalArtifacts") if isinstance(pack.get("multimodalArtifacts"), list) else []
    for artifact in artifacts:
        if not isinstance(artifact, dict) or artifact.get("type") != "openmaic_video" or artifact.get("jobId"):
            continue
        segments = artifact.get("segments") if isinstance(artifact.get("segments"), list) else []
        succeeded = [item for item in segments if isinstance(item, dict) and item.get("status") == "succeeded" and str(item.get("videoUrl") or "").strip()]
        failed = [item for item in segments if isinstance(item, dict) and item.get("status") == "failed"]
        indexes = [int(item.get("index") or 0) for item in segments if isinstance(item, dict)]
        if succeeded and failed and len(indexes) == len(set(indexes)) and all(1 <= index <= 6 for index in indexes):
            return artifact
    return None

def _legacy_video_job_id(user_id: int, pack_id: str, artifact: dict) -> str:
    canonical_segments = []
    for item in artifact.get("segments", []):
        video_url = str(item.get("videoUrl") or "")
        canonical_segments.append({
            "index": int(item.get("index") or 0),
            "title": str(item.get("title") or ""),
            "status": str(item.get("status") or ""),
            "videoUrlHash": hashlib.sha256(video_url.encode("utf-8")).hexdigest(),
        })
    canonical = json.dumps({
        "userId": user_id,
        "packId": pack_id,
        "createdAt": str(artifact.get("createdAt") or ""),
        "segments": canonical_segments,
    }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"a3_legacy_video_{hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:48]}"
```

- [ ] **Step 4: Implement atomic import without trusting client video fields**

Add `create_legacy_video_retry_job(user, pack_id, pack, payload)` that:

```python
def create_legacy_video_retry_job(user, pack_id: str, pack: dict, payload: dict):
    artifact = eligible_legacy_video_artifact(pack)
    if not artifact:
        raise ValueError("当前视频不需要旧任务迁移")
    requested = _normalize_video_segment_requests(payload.get("segments"))
    legacy = {int(item["index"]): item for item in artifact["segments"]}
    requested_by_index = {item["index"]: item for item in requested}
    if set(legacy) != set(requested_by_index):
        raise ValueError("视频分段与旧任务不匹配")

    imported = sum(1 for item in legacy.values() if item.get("status") == "succeeded" and item.get("videoUrl"))
    queued = sum(1 for item in legacy.values() if item.get("status") == "failed")
    if not imported or not queued:
        raise ValueError("当前视频不需要旧任务迁移")
    job_id = _legacy_video_job_id(user.id, pack_id, artifact)
    now = timezone.now()

    with transaction.atomic():
        job, created = VideoGenerationJob.objects.get_or_create(
            job_id=job_id,
            defaults={
                "user": user,
                "resource_pack_id": pack_id,
                "resource_type": str(payload.get("resourceType") or "micro_video_script")[:40],
                "provider": str(payload.get("provider") or "seedance")[:40],
                "requested_duration": max(1, min(int(payload.get("duration") or 60), 60)),
                "aspect_ratio": str(payload.get("aspectRatio") or "16:9")[:16],
                "resolution": str(payload.get("resolution") or "1080p")[:16],
                "progress": min(85, round((imported / len(legacy)) * 85)),
                "message": f"已保留 {imported} 个成功片段，等待补生成 {queued} 个失败片段",
            },
        )
        if job.user_id != user.id or job.resource_pack_id != pack_id:
            raise ValueError("旧视频迁移任务归属不匹配")
        if created:
            rows = []
            for index in sorted(legacy):
                old = legacy[index]
                request_item = requested_by_index[index]
                succeeded = old.get("status") == "succeeded" and bool(old.get("videoUrl"))
                rows.append(VideoGenerationSegment(
                    job=job,
                    index=index,
                    title=str(old.get("title") or request_item["title"])[:120],
                    prompt=request_item["prompt"],
                    duration=max(1, min(int(old.get("duration") or request_item["duration"]), 10)),
                    aspect_ratio=job.aspect_ratio,
                    resolution=job.resolution,
                    status="succeeded" if succeeded else "pending",
                    video_url=str(old.get("videoUrl") or "") if succeeded else "",
                    width=max(0, int(old.get("width") or 0)) if succeeded else 0,
                    height=max(0, int(old.get("height") or 0)) if succeeded else 0,
                    finished_at=now if succeeded else None,
                ))
            VideoGenerationSegment.objects.bulk_create(rows)
            transaction.on_commit(lambda: dispatch_video_job(job))
    return job, created, imported, queued
```

Extract the existing segment validation from `create_video_job` into `_normalize_video_segment_requests` so normal and legacy jobs enforce the same index, prompt and duration limits.

```python
def _normalize_video_segment_requests(value) -> list[dict]:
    segments = value if isinstance(value, list) else []
    if not 1 <= len(segments) <= 6:
        raise ValueError("视频任务必须包含 1-6 个分段")
    normalized = []
    seen_indexes = set()
    for fallback_index, item in enumerate(segments, start=1):
        if not isinstance(item, dict):
            raise ValueError("视频分段格式无效")
        index = int(item.get("index") or fallback_index)
        prompt = str(item.get("prompt") or "").strip()
        if index < 1 or index > 6 or index in seen_indexes or not prompt or len(prompt) > 12_000:
            raise ValueError("视频分段序号或提示词无效")
        seen_indexes.add(index)
        normalized.append({
            "index": index,
            "title": str(item.get("title") or f"片段 {index}")[:120],
            "prompt": prompt,
            "duration": max(1, min(int(item.get("duration") or 10), 10)),
        })
    return normalized
```

- [ ] **Step 5: Add idempotency and invalid-artifact tests**

Add tests proving:

```python
self.assertEqual(first.job_id, replay.job_id)
self.assertFalse(replay_created)
self.assertEqual(VideoGenerationJob.objects.filter(job_id=first.job_id).count(), 1)
send_task.assert_called_once()
```

Also assert `ValueError` for: artifact already has `jobId`, no succeeded segment, no failed segment, duplicate request indexes, and request indexes that differ from artifact indexes.

- [ ] **Step 6: Run backend service tests and verify GREEN**

Run the full video backend set:

```powershell
$env:DJANGO_DEBUG='1'
$env:A3_TEST_SQLITE_PATH='D:/Download/A3/.tmp/legacy-video-service.sqlite3'
& 'D:/Download/A3/backend/.venv/Scripts/python.exe' backend/manage.py test `
  backend.apps.compat.tests.test_video_generation_jobs `
  backend.apps.compat.tests.test_video_generation_tasks `
  backend.apps.compat.tests.test_recover_video_jobs_command `
  --settings=backend.config.test_sqlite_settings --noinput
```

Expected: all tests PASS, and no migration is created.

- [ ] **Step 7: Commit backend domain service**

```powershell
git add backend/apps/compat/video_jobs.py backend/apps/compat/tests/test_video_generation_jobs.py
git commit -m "Add legacy video segment import service"
```

### Task 2: Authenticated Django Import Endpoint

**Files:**
- Modify: `backend/apps/compat/views.py`
- Modify: `backend/apps/compat/urls.py`
- Test: `backend/apps/compat/tests/test_video_generation_jobs.py`

- [ ] **Step 1: Write failing API and ownership tests**

Add tests for:

```python
response = self.client.post(
    "/api/resources/packs/pack-api-001/video-jobs/import-legacy/",
    data=payload,
    content_type="application/json",
)
self.assertEqual(response.status_code, 201)
self.assertEqual(response.json()["importedSucceeded"], 1)
self.assertEqual(response.json()["queuedFailed"], 1)
self.assertTrue(response.json()["job"]["jobId"].startswith("a3_legacy_video_"))
```

Force-login `self.other` and assert the same pack path returns 404. Replay the original user request and assert status 200 with `created=false`.

- [ ] **Step 2: Run API tests and verify RED**

Expected: 404 because the route is not registered.

- [ ] **Step 3: Register the route and view**

Add to `urls.py`:

```python
path(
    "resources/packs/<str:pack_id>/video-jobs/import-legacy/",
    views.import_legacy_resource_pack_video_job,
    name="compat-resource-pack-video-job-import-legacy",
),
```

Add to `views.py`:

```python
@require_http_methods(["POST"])
def import_legacy_resource_pack_video_job(request, pack_id):
    rejected = require_authenticated(request)
    if rejected:
        return rejected
    pack = get_resource_pack(request.user, str(pack_id))
    if not pack:
        return JsonResponse({"success": False, "error": "资源包不存在"}, status=404)
    try:
        job, created, imported, queued = create_legacy_video_retry_job(
            request.user, str(pack_id), pack, _body(request)
        )
        refreshed = VideoGenerationJob.objects.prefetch_related("segments").get(id=job.id)
        return JsonResponse({
            "success": True,
            "created": created,
            "importedSucceeded": imported,
            "queuedFailed": queued,
            "job": serialize_video_job(refreshed),
        }, status=201 if created else 200)
    except ValueError as exc:
        return JsonResponse({"success": False, "error": str(exc)}, status=400)
```

Import `create_legacy_video_retry_job` beside the existing video job imports.

- [ ] **Step 4: Run API tests and verify GREEN**

Run the `VideoGenerationJobApiTests` class with SQLite settings. Expected: all tests PASS.

- [ ] **Step 5: Commit endpoint**

```powershell
git add backend/apps/compat/views.py backend/apps/compat/urls.py backend/apps/compat/tests/test_video_generation_jobs.py
git commit -m "Expose legacy video import endpoint"
```

### Task 3: Shared Video Prompt Builder

**Files:**
- Create: `OpenMAIC/lib/a3/video-prompt.ts`
- Create: `OpenMAIC/tests/a3-video-prompt.test.ts`
- Modify: `OpenMAIC/components/a3/features/recommendations-view.tsx`

- [ ] **Step 1: Write characterization tests before moving prompt logic**

Create tests that call the wished-for API:

```typescript
import { buildA3VideoPrompt, estimateA3VideoDuration } from '@/lib/a3/video-prompt';

it('builds a six-segment-safe prompt from the resource script and citations', () => {
  const prompt = buildA3VideoPrompt('死锁', {
    type: 'micro_video_script',
    title: '死锁讲解',
    content: { shots: [{ scene: '导入', visual: '资源等待图', narration: '两个进程互相等待' }] },
    citations: [{ title: '操作系统教材', snippet: '死锁四个必要条件' }],
    personalizationReason: '针对薄弱点',
  } as never);
  expect(prompt).toContain('死锁');
  expect(prompt).toContain('两个进程互相等待');
  expect(prompt).toContain('画面中禁止出现任何可读文字');
  expect(estimateA3VideoDuration()).toBe(60);
});
```

- [ ] **Step 2: Run the new test and verify RED**

Expected: module `@/lib/a3/video-prompt` cannot be resolved.

- [ ] **Step 3: Move existing prompt logic without changing output**

Move `buildVideoPrompt`, `sanitizeVideoVisualText`, and `estimateVideoDuration` from `recommendations-view.tsx` into `video-prompt.ts`, export them as:

```typescript
export function buildA3VideoPrompt(goal: string, resource: A3ResourcePackV2Resource): string;
export function estimateA3VideoDuration(): 60;
```

Keep the existing citation limits, shot limits, no-readable-text constraint, and fallback behavior unchanged. Replace recommendation page calls with imports:

```typescript
import { buildA3VideoPrompt, estimateA3VideoDuration } from '@/lib/a3/video-prompt';
```

- [ ] **Step 4: Run prompt and existing video tests**

```powershell
pnpm.cmd exec vitest run tests/a3-video-prompt.test.ts tests/a3-openmaic-video-job-status.test.ts tests/a3-resource-video-segments.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit shared prompt builder**

```powershell
git add OpenMAIC/lib/a3/video-prompt.ts OpenMAIC/tests/a3-video-prompt.test.ts OpenMAIC/components/a3/features/recommendations-view.tsx
git commit -m "Share A3 video prompt construction"
```

### Task 4: Next Legacy Import Proxy

**Files:**
- Modify: `OpenMAIC/app/api/a3/resources/openmaic-video/route.ts`
- Modify: `OpenMAIC/tests/a3-openmaic-video-job-status.test.ts`

- [ ] **Step 1: Write a failing proxy contract test**

Assert source and behavior boundaries:

```typescript
expect(source).toContain("action === 'import-legacy-failures'");
expect(source).toContain('`/api/resources/packs/${resourcePackId}/video-jobs/import-legacy/`');
expect(source).toContain('segments: segmentRequests.map');
expect(source).not.toContain('body.videoUrl');
expect(source).not.toContain('body.segments');
```

- [ ] **Step 2: Run the test and verify RED**

Expected: missing legacy action and endpoint strings.

- [ ] **Step 3: Implement the PATCH action**

Extend the body type with `resourcePackId`, `prompt`, provider and video options. Keep `retry-failed` unchanged. For `import-legacy-failures`:

Extend `DjangoVideoJobResponse` with `importedSucceeded?: number` and `queuedFailed?: number`; extend the PATCH request body type with `resourcePackId`, `prompt`, `provider`, `aspectRatio` and `resolution` before branching on `action`.

```typescript
if (action === 'import-legacy-failures') {
  const resourcePackId = String(body.resourcePackId || '').trim();
  const rawPrompt = String(body.prompt || '').trim();
  if (!resourcePackId || !rawPrompt) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '缺少旧视频迁移参数');
  }
  const duration = 60;
  const aspectRatio = String(body.aspectRatio || '16:9');
  const resolution = String(body.resolution || '1080p');
  const segmentRequests = buildSegmentedVideoRequests({
    prompt: rawPrompt,
    duration,
    aspectRatio,
    resolution,
  });
  const persisted = await postA3DjangoJson<DjangoVideoJobResponse>(
    `/api/resources/packs/${resourcePackId}/video-jobs/import-legacy/`,
    cookieHeader,
    {
      provider: String(body.provider || 'seedance'),
      resourceType: 'micro_video_script',
      duration,
      aspectRatio,
      resolution,
      segments: segmentRequests.map((segment, index) => ({
        index: index + 1,
        title: segment.title,
        prompt: segment.prompt,
        duration: segment.duration,
      })),
    },
  );
  if (!persisted.success || !persisted.job) {
    return apiError('UPSTREAM_ERROR', 502, persisted.error || '旧视频迁移失败');
  }
  return apiSuccess({
    ...toPublicVideoJob(persisted.job),
    importedSucceeded: persisted.importedSucceeded ?? 0,
    queuedFailed: persisted.queuedFailed ?? 0,
  }, 202);
}
```

Return 400 for actions other than `retry-failed` and `import-legacy-failures`.

- [ ] **Step 4: Run focused route tests and TypeScript**

```powershell
pnpm.cmd exec vitest run tests/a3-openmaic-video-job-status.test.ts tests/a3-video-provider-bridge.test.ts
npx.cmd tsc --noEmit
```

Expected: tests and typecheck PASS.

- [ ] **Step 5: Commit proxy**

```powershell
git add OpenMAIC/app/api/a3/resources/openmaic-video/route.ts OpenMAIC/tests/a3-openmaic-video-job-status.test.ts
git commit -m "Proxy legacy video failure imports"
```

### Task 5: Confirmation Dialog and Refresh Recovery

**Files:**
- Modify: `OpenMAIC/components/a3/features/resource-video-view.tsx`
- Modify: `OpenMAIC/tests/a3-resource-video-segments.test.ts`
- Modify: `OpenMAIC/e2e/tests/a3-resource-feedback-loop.spec.ts`

- [ ] **Step 1: Write failing UI contract tests**

Add assertions for:

```typescript
expect(source).toContain('legacyFailedSegments');
expect(source).toContain('legacySucceededSegments');
expect(source).toContain('补生成失败片段');
expect(source).toContain('AlertDialogAction');
expect(source).toContain("action: 'import-legacy-failures'");
expect(source).toContain('buildA3VideoPrompt');
expect(source).toContain('保留');
expect(source).not.toContain('videoUrl: segment.videoUrl');
```

Add an E2E test using mocked APIs: click migration button, assert confirmation text shows “补生成 2 段” and “保留 4 段”, click cancel, and assert no PATCH request was observed.

- [ ] **Step 2: Run tests and verify RED**

Expected: missing legacy controls and confirmation dialog.

- [ ] **Step 3: Add derived eligibility and confirmation state**

In `ResourceVideoView`:

```typescript
const legacyFailedSegments = (videoArtifact?.segments ?? []).filter(
  (segment) => !videoArtifact?.jobId && segment.status === 'failed',
);
const legacySucceededSegments = (videoArtifact?.segments ?? []).filter(
  (segment) => !videoArtifact?.jobId && segment.status === 'succeeded' && Boolean(segment.videoUrl),
);
const canImportLegacyFailures = legacyFailedSegments.length > 0 && legacySucceededSegments.length > 0;
const [legacyConfirmOpen, setLegacyConfirmOpen] = useState(false);
```

Render an orange migration banner only when `canImportLegacyFailures`. Use the existing `AlertDialog` components. The action text must state the exact failed and preserved counts; cancellation only closes the dialog.

- [ ] **Step 4: Reuse one polling helper for normal retry and legacy import**

Extract the current polling loop into:

```typescript
async function pollVideoJob(initial: VideoJobResponse) {
  let job = initial;
  if (!job.jobId) throw new Error('视频任务缺少 jobId');
  while (!job.done && !['succeeded', 'partial', 'failed'].includes(String(job.status))) {
    await wait(5000);
    const poll = await fetch(`/api/a3/resources/openmaic-video?jobId=${encodeURIComponent(job.jobId)}`, { cache: 'no-store' });
    job = await poll.json() as VideoJobResponse;
    if (!poll.ok || !job.success) throw new Error(job.error || '视频任务进度查询失败');
    setRetryMessage(job.message || `视频任务进度 ${job.progress ?? 0}%`);
  }
  return job;
}
```

Extend `VideoJobResponse` with `jobId`, `resourcePackId`, `jobs`, `importedSucceeded` and `queuedFailed`.

- [ ] **Step 5: Implement confirmed import without client video URLs**

```typescript
async function importLegacyFailures() {
  if (!pack || !script || !canImportLegacyFailures || retryingFailedSegments) return;
  setLegacyConfirmOpen(false);
  setRetryingFailedSegments(true);
  setRetryMessage(`正在补生成 ${legacyFailedSegments.length} 段，保留 ${legacySucceededSegments.length} 段。`);
  try {
    const response = await fetch('/api/a3/resources/openmaic-video', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'import-legacy-failures',
        resourcePackId: pack.resourcePackId,
        provider: 'seedance',
        prompt: buildA3VideoPrompt(pack.goal, script),
        aspectRatio: '16:9',
        resolution: '1080p',
      }),
    });
    const initial = await response.json() as VideoJobResponse;
    if (!response.ok || !initial.success) throw new Error(initial.error || '旧视频迁移未能启动');
    await pollVideoJob(initial);
    const refreshed = await loadResourcePack(packId);
    if (refreshed.success && refreshed.resourcePack) setPack(sanitizeResourcePack(refreshed.resourcePack));
  } finally {
    setRetryingFailedSegments(false);
  }
}
```

- [ ] **Step 6: Restore an active migrated job after refresh**

After the pack load succeeds, call `GET /api/a3/resources/openmaic-video`, find the latest job whose `resourcePackId === packId` and status is queued/running, then call `pollVideoJob`. Do not create a new import request during recovery.

```typescript
useEffect(() => {
  let cancelled = false;
  async function restoreActiveVideoJob() {
    const result = await a3GetJson<VideoJobResponse>('/api/a3/resources/openmaic-video');
    const active = (result.jobs ?? []).find(
      (job) => job.resourcePackId === packId && ['queued', 'running'].includes(String(job.status)),
    );
    if (!active?.jobId || cancelled) return;
    setRetryingFailedSegments(true);
    setRetryMessage(active.message || '正在恢复视频任务进度。');
    try {
      await pollVideoJob({ ...active, success: true });
      const refreshed = await loadResourcePack(packId);
      if (!cancelled && refreshed.success && refreshed.resourcePack) {
        setPack(sanitizeResourcePack(refreshed.resourcePack));
      }
    } catch (restoreError) {
      if (!cancelled) setRetryMessage(restoreError instanceof Error ? restoreError.message : '视频任务恢复失败');
    } finally {
      if (!cancelled) setRetryingFailedSegments(false);
    }
  }
  void restoreActiveVideoJob();
  return () => { cancelled = true; };
}, [packId]);
```

- [ ] **Step 7: Run focused unit and E2E tests**

```powershell
pnpm.cmd exec vitest run tests/a3-resource-video-segments.test.ts tests/a3-openmaic-video-job-status.test.ts tests/a3-video-prompt.test.ts
npx.cmd playwright test e2e/tests/a3-resource-feedback-loop.spec.ts --project=chromium --workers=1 -g "legacy video"
```

Expected: confirmation, cancellation, request boundary and polling tests PASS.

- [ ] **Step 8: Commit UI**

```powershell
git add OpenMAIC/components/a3/features/resource-video-view.tsx OpenMAIC/tests/a3-resource-video-segments.test.ts OpenMAIC/e2e/tests/a3-resource-feedback-loop.spec.ts
git commit -m "Confirm and resume legacy video retries"
```

### Task 6: Full Verification, Documentation, and Production Acceptance

**Files:**
- Modify: `docs/A3_GHCR前端镜像部署.md`

- [ ] **Step 1: Document rollout and legacy acceptance evidence**

Add commands that verify:

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T backend python manage.py recover_video_jobs --stale-minutes 5
```

Document that production acceptance records only URL hashes for segments 3-6, never signed URLs, and verifies one job with pending/polling segments 1-2 and succeeded segments 3-6.

- [ ] **Step 2: Run complete backend verification**

```powershell
$env:DJANGO_DEBUG='1'
$env:A3_TEST_SQLITE_PATH='D:/Download/A3/.tmp/legacy-video-full.sqlite3'
& 'D:/Download/A3/backend/.venv/Scripts/python.exe' backend/manage.py test `
  backend.apps.compat.tests.test_video_generation_jobs `
  backend.apps.compat.tests.test_video_generation_tasks `
  backend.apps.compat.tests.test_recover_video_jobs_command `
  --settings=backend.config.test_sqlite_settings --noinput
& 'D:/Download/A3/backend/.venv/Scripts/python.exe' backend/manage.py check --settings=backend.config.test_sqlite_settings
& 'D:/Download/A3/backend/.venv/Scripts/python.exe' backend/manage.py makemigrations --check --dry-run --settings=backend.config.test_sqlite_settings
```

Expected: all tests PASS, system check clean, “No changes detected”.

- [ ] **Step 3: Run complete frontend verification**

```powershell
cd OpenMAIC
$env:TEMP='D:/Download/A3/.tmp/legacy-video-frontend'
$env:TMP=$env:TEMP
pnpm.cmd exec vitest run tests/a3-video-prompt.test.ts tests/a3-openmaic-video-job-status.test.ts tests/a3-resource-video-segments.test.ts tests/a3-video-provider-bridge.test.ts tests/a3-ghcr-deployment.test.ts
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd build
```

Expected: tests, typecheck and build PASS; lint has zero errors and only AGENTS.md-approved historical warnings.

- [ ] **Step 4: Inspect final diff and commit documentation**

```powershell
git diff --check
git status --short --branch
git add docs/A3_GHCR前端镜像部署.md
git commit -m "Document legacy video retry rollout"
```

- [ ] **Step 5: Request code review before publish**

Use `superpowers:requesting-code-review` against the complete branch. Address correctness findings, especially URL trust boundaries, duplicate dispatch, artifact selection and refresh recovery. Re-run focused tests after any fix.

- [ ] **Step 6: Push, build fixed-SHA images, and deploy atomically**

Push `codex/durable-video-avatar`, manually trigger both image workflows for the final SHA, verify both image revision labels, back up `.env.production`, update digest references, and recreate only:

```text
backend celery celery-beat frontend
```

Run migration check even though this feature adds no migration, execute stale-job recovery, and verify public readiness before enabling the migration button for the production artifact.

- [ ] **Step 7: Perform production legacy migration acceptance**

On the current deadlock video page:

1. Confirm the dialog reports 2 generated and 4 preserved segments.
2. Record SHA-256 hashes of segment 3-6 URLs before confirmation.
3. Confirm once and observe one `a3_legacy_video_*` job.
4. Verify only segments 1-2 obtain provider task IDs.
5. Verify segments 3-6 remain succeeded and URL hashes are unchanged.
6. Refresh the page and confirm it resumes the same job.
7. After completion, verify the new artifact contains `jobId` and six segment statuses.
