# A3 Coaching Page Polish And Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/a3/coaching` from a persisted tutoring screen into an enterprise-grade face-to-face tutoring workspace with clean Chinese copy, explicit interaction state, session history, verified-answer evidence, learning writeback, and teacher audit visibility.

**Architecture:** Keep `CoachingSession` and `CoachingMessage` as the durable source of truth. Add focused backend services for session listing, summary, and teacher audit, expose them through Django endpoints and Next.js proxies, then split frontend state helpers away from `coaching-view.tsx` so the page can be tested without rendering the whole media UI.

**Tech Stack:** Django, Django ORM, Next.js App Router, React, TypeScript, Vitest, existing A3 API helpers, existing A3 UI components.

---

## Current Baseline

Already complete:
- `CoachingSession` and `CoachingMessage` relational tables exist.
- Active session persistence works through `GET/POST /api/learning/coaching/session/`.
- Ending a session works through `POST /api/learning/coaching/session/end/`.
- Next proxies exist under `/api/a3/coaching/session` and `/api/a3/coaching/session/end`.
- `/a3/coaching` restores messages after refresh and saves assistant responses.

Known gaps to fix:
- Several frontend route/page/test files still contain mojibake Chinese strings.
- `coaching-view.tsx` mixes UI, copy, state machine, persistence, answer generation, quiz submission, source collection, and summary formatting.
- There is no session history list or reopen flow.
- Session summary is a client-built string, not a backend-owned auditable summary.
- Teacher workbench has no coaching activity signal.
- CTA behavior is not consistently represented as explicit `idle/restoring/recording/transcribing/answering/speaking/saving/ended/error` states.

## File Structure

Create:
- `OpenMAIC/lib/a3/coaching-types.ts`: shared frontend types for session, message, citation, claim, safety, summary, and UI state.
- `OpenMAIC/lib/a3/coaching-state.ts`: pure helpers for state labels, disabled controls, welcome messages, summaries, and Chinese copy.
- `OpenMAIC/app/api/a3/coaching/sessions/route.ts`: Next proxy for recent sessions.
- `OpenMAIC/app/api/a3/coaching/session/[sessionId]/route.ts`: Next proxy for reopening one session.
- `OpenMAIC/app/api/a3/coaching/session/summary/route.ts`: Next proxy for backend-owned summary/writeback.
- `OpenMAIC/tests/a3-coaching-state.test.ts`: Vitest for pure state/copy helpers.
- `OpenMAIC/tests/a3-coaching-session-history.test.ts`: Vitest for new Next proxies.

Modify:
- `OpenMAIC/components/a3/features/coaching-view.tsx`: consume helper modules, show history panel, explicit status strip, verified evidence, and real next actions.
- `OpenMAIC/tests/a3-coaching-session.test.ts`: replace mojibake assertions with readable Chinese and add response shape checks.
- `OpenMAIC/app/api/a3/coaching/session/route.ts`: clean Chinese errors and import shared route response types if useful.
- `OpenMAIC/app/api/a3/coaching/session/end/route.ts`: clean Chinese errors.
- `OpenMAIC/app/api/a3/coaching/respond/route.ts`: clean Chinese errors and history prompt labels.
- `OpenMAIC/app/api/a3/coaching/vision/route.ts`: clean Chinese errors.
- `backend/apps/learning/services.py`: add serializers and services for session list, session detail, summary, and teacher coaching audit.
- `backend/apps/learning/views.py`: add `coaching_sessions`, `coaching_session_detail`, `coaching_summary`, and include coaching summary in teacher response.
- `backend/apps/learning/urls.py`: add new URL patterns.
- `backend/apps/learning/tests/test_coaching_session.py`: add endpoint coverage.
- `backend/apps/learning/tests/test_coaching_session_models.py`: add summary/list serializer coverage if not already covered.

Do not create:
- New mock-only data sources.
- New localStorage persistence.
- A second coaching storage model.
- Any frontend fake success for notes, favorites, summary, teacher audit, or writeback.

---

### Task 1: Clean Coaching Copy And Extract Pure State Helpers

**Files:**
- Create: `OpenMAIC/lib/a3/coaching-types.ts`
- Create: `OpenMAIC/lib/a3/coaching-state.ts`
- Create: `OpenMAIC/tests/a3-coaching-state.test.ts`
- Modify: `OpenMAIC/components/a3/features/coaching-view.tsx`
- Modify: `OpenMAIC/app/api/a3/coaching/session/route.ts`
- Modify: `OpenMAIC/app/api/a3/coaching/session/end/route.ts`
- Modify: `OpenMAIC/app/api/a3/coaching/respond/route.ts`
- Modify: `OpenMAIC/app/api/a3/coaching/vision/route.ts`
- Modify: `OpenMAIC/tests/a3-coaching-session.test.ts`

- [ ] **Step 1: Write failing tests for state labels and clean Chinese copy**

Add `OpenMAIC/tests/a3-coaching-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildCoachingWelcomeMessage,
  buildSessionSummaryText,
  coachingUiStateLabel,
  getCoachingControlState,
} from '@/lib/a3/coaching-state';
import type { ClassroomContext } from '@/lib/a3/classroom-types';

const classroom = {
  target: {
    title: '反馈控制结构',
    progress: 35,
    chapter: { order: 1, title: '控制系统基础' },
  },
} as ClassroomContext;

describe('coaching-state helpers', () => {
  it('returns readable Chinese labels for each interaction state', () => {
    expect(coachingUiStateLabel('restoring')).toBe('正在恢复辅导记录');
    expect(coachingUiStateLabel('recording')).toBe('正在录音');
    expect(coachingUiStateLabel('transcribing')).toBe('正在识别语音');
    expect(coachingUiStateLabel('answering')).toBe('AI 正在组织回答');
    expect(coachingUiStateLabel('speaking')).toBe('正在语音播报');
    expect(coachingUiStateLabel('saving')).toBe('正在保存记录');
    expect(coachingUiStateLabel('ended')).toBe('本次辅导已结束');
    expect(coachingUiStateLabel('error')).toBe('需要处理异常');
    expect(coachingUiStateLabel('idle')).toBe('等待提问');
  });

  it('builds a welcome message tied to the current learning target', () => {
    const message = buildCoachingWelcomeMessage(classroom);

    expect(message.role).toBe('assistant');
    expect(message.content).toContain('反馈控制结构');
    expect(message.content).toContain('学习路径');
    expect(message.content).toContain('知识库');
  });

  it('builds an auditable session summary from recent user questions', () => {
    const summary = buildSessionSummaryText('反馈控制结构', [
      { id: 'welcome', role: 'assistant', content: '欢迎', createdAt: '2026-07-04T10:00:00+08:00' },
      { id: 'q1', role: 'user', content: '反馈控制是什么？', createdAt: '2026-07-04T10:01:00+08:00' },
      { id: 'a1', role: 'assistant', content: '回答', verified: true, createdAt: '2026-07-04T10:02:00+08:00' },
    ]);

    expect(summary).toBe('反馈控制结构：已完成 1 次有效提问，1 条回答完成引用验证。最近问题：反馈控制是什么？');
  });

  it('disables conflicting controls while answering', () => {
    expect(getCoachingControlState('answering')).toMatchObject({
      canRecord: false,
      canAskText: false,
      canAskWithCamera: false,
      canEnd: true,
    });
    expect(getCoachingControlState('idle')).toMatchObject({
      canRecord: true,
      canAskText: true,
      canAskWithCamera: true,
      canEnd: true,
    });
  });
});
```

- [ ] **Step 2: Run the failing frontend helper test**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-coaching-state.test.ts
```

Expected: FAIL because `OpenMAIC/lib/a3/coaching-state.ts` does not exist.

- [ ] **Step 3: Add shared frontend coaching types**

Create `OpenMAIC/lib/a3/coaching-types.ts`:

```ts
export type CoachingUiState =
  | 'idle'
  | 'restoring'
  | 'recording'
  | 'transcribing'
  | 'answering'
  | 'speaking'
  | 'saving'
  | 'ended'
  | 'error';

export type CoachingCitation = {
  id?: string;
  title?: string;
  location?: string;
  type?: string;
  score?: number | null;
  snippet?: string;
};

export type CoachingClaim = {
  id: string;
  text: string;
  verified: boolean;
  overlap?: number;
  citation?: CoachingCitation | null;
};

export type CoachingSafetyStatus = {
  safe: boolean;
  category: string;
  reason: string;
};

export type CoachingMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  verified?: boolean;
  citations?: CoachingCitation[];
  claims?: CoachingClaim[];
  safety?: CoachingSafetyStatus | null;
  refusalReason?: string;
  degraded?: boolean;
  createdAt?: string;
};

export type CoachingSessionSummary = {
  questionCount: number;
  assistantReplyCount: number;
  verifiedReplyCount: number;
  unverifiedReplyCount: number;
  citationCount: number;
  weakPointSignals: string[];
  latestQuestions: string[];
  nextAction: {
    label: string;
    href: string;
    reason: string;
  };
};

export type CoachingSessionListItem = {
  id: string;
  status: 'active' | 'ended' | 'archived';
  topicTitle: string;
  summary: string;
  questionCount: number;
  verifiedReplyCount: number;
  citationCount: number;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
};
```

- [ ] **Step 4: Add pure state helpers with clean Chinese**

Create `OpenMAIC/lib/a3/coaching-state.ts`:

```ts
import type { ClassroomContext } from '@/lib/a3/classroom-types';
import type { CoachingMessage, CoachingUiState } from './coaching-types';

export function coachingUiStateLabel(state: CoachingUiState) {
  const labels: Record<CoachingUiState, string> = {
    idle: '等待提问',
    restoring: '正在恢复辅导记录',
    recording: '正在录音',
    transcribing: '正在识别语音',
    answering: 'AI 正在组织回答',
    speaking: '正在语音播报',
    saving: '正在保存记录',
    ended: '本次辅导已结束',
    error: '需要处理异常',
  };
  return labels[state];
}

export function getCoachingControlState(state: CoachingUiState) {
  const busy = state === 'restoring' || state === 'recording' || state === 'transcribing' || state === 'answering' || state === 'saving';
  return {
    canRecord: !busy && state !== 'ended',
    canAskText: !busy && state !== 'ended',
    canAskWithCamera: !busy && state !== 'ended',
    canToggleMedia: state !== 'saving',
    canEnd: state !== 'restoring' && state !== 'saving',
  };
}

export function buildCoachingWelcomeMessage(classroom: ClassroomContext | null): CoachingMessage {
  const target = classroom?.target;
  return {
    id: 'welcome',
    role: 'assistant',
    content: target
      ? `你好，我是 AI 助教小智。当前面对面辅导主题是《${target.title}》，我会结合学习路径、知识库来源和错题记录回答。`
      : '你好，我是 AI 助教小智。请先生成学习路径，再开始面对面辅导。',
    createdAt: new Date().toISOString(),
  };
}

export function buildSessionSummaryText(target: string | undefined, messages: CoachingMessage[]) {
  const userQuestions = messages.filter((message) => message.role === 'user');
  const verifiedReplies = messages.filter((message) => message.role === 'assistant' && message.verified).length;
  const recentQuestions = userQuestions.slice(-3).map((message) => message.content);
  return `${target ?? '面对面辅导'}：已完成 ${userQuestions.length} 次有效提问，${verifiedReplies} 条回答完成引用验证。${recentQuestions.length ? `最近问题：${recentQuestions.join('；')}` : '暂无学生提问。'}`;
}

export function coachingStatusTone(state: CoachingUiState) {
  if (state === 'error') return 'red';
  if (state === 'recording' || state === 'transcribing' || state === 'answering' || state === 'saving') return 'orange';
  if (state === 'ended') return 'gray';
  return 'blue';
}
```

- [ ] **Step 5: Replace mojibake strings in coaching routes and tests**

In these files, replace unreadable Chinese strings with normal Chinese:
- `OpenMAIC/app/api/a3/coaching/session/route.ts`
- `OpenMAIC/app/api/a3/coaching/session/end/route.ts`
- `OpenMAIC/app/api/a3/coaching/respond/route.ts`
- `OpenMAIC/app/api/a3/coaching/vision/route.ts`
- `OpenMAIC/tests/a3-coaching-session.test.ts`

Use these exact strings where applicable:

```ts
'面对面辅导记录加载失败'
'面对面辅导记录暂时不可用'
'面对面辅导记录保存失败'
'请先登录后使用 AI 辅导'
'请输入问题'
'问题内容过长'
'AI 辅导服务请求失败'
'AI 辅导服务暂时不可用'
'最近对话：'
'学生'
'小智'
'学生当前问题：'
```

- [ ] **Step 6: Refactor `coaching-view.tsx` imports and local types**

Replace local `TranscriptMessage`, `Citation`, `Claim`, and `SafetyStatus` definitions with imports:

```ts
import type {
  CoachingCitation,
  CoachingClaim,
  CoachingMessage,
  CoachingSafetyStatus,
  CoachingUiState,
} from '@/lib/a3/coaching-types';
import {
  buildCoachingWelcomeMessage,
  buildSessionSummaryText,
  coachingStatusTone,
  coachingUiStateLabel,
  getCoachingControlState,
} from '@/lib/a3/coaching-state';
```

Then update local state:

```ts
const [uiState, setUiState] = useState<CoachingUiState>('restoring');
const [messages, setMessages] = useState<CoachingMessage[]>([]);
const controls = getCoachingControlState(uiState);
```

- [ ] **Step 7: Run targeted frontend tests**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-coaching-state.test.ts tests/a3-coaching-session.test.ts
```

Expected: PASS.

---

### Task 2: Add Backend Session History And Reopen APIs

**Files:**
- Modify: `backend/apps/learning/services.py`
- Modify: `backend/apps/learning/views.py`
- Modify: `backend/apps/learning/urls.py`
- Modify: `backend/apps/learning/tests/test_coaching_session.py`
- Create: `OpenMAIC/app/api/a3/coaching/sessions/route.ts`
- Create: `OpenMAIC/app/api/a3/coaching/session/[sessionId]/route.ts`
- Create: `OpenMAIC/tests/a3-coaching-session-history.test.ts`

- [ ] **Step 1: Write backend tests for history list and detail**

Add tests to `backend/apps/learning/tests/test_coaching_session.py`:

```py
def test_coaching_sessions_lists_recent_sessions(client, django_user_model):
    user = django_user_model.objects.create_user(username="student-history", password="pass12345")
    client.force_login(user)
    ended = CoachingSession.objects.create(user=user, status=CoachingSessionStatus.ENDED, topic_title="反馈控制结构", summary="已完成反馈控制答疑")
    CoachingMessage.objects.create(session=ended, role=CoachingMessageRole.USER, content="反馈控制是什么？")
    CoachingMessage.objects.create(session=ended, role=CoachingMessageRole.ASSISTANT, content="反馈控制会比较目标与输出。", verified=True, citations=[{"title": "控制系统基础"}])

    response = client.get("/api/learning/coaching/sessions/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["success"] is True
    assert payload["sessions"][0]["id"] == str(ended.id)
    assert payload["sessions"][0]["topicTitle"] == "反馈控制结构"
    assert payload["sessions"][0]["questionCount"] == 1
    assert payload["sessions"][0]["verifiedReplyCount"] == 1
    assert payload["sessions"][0]["citationCount"] == 1


def test_coaching_session_detail_only_allows_owner(client, django_user_model):
    owner = django_user_model.objects.create_user(username="student-owner", password="pass12345")
    other = django_user_model.objects.create_user(username="student-other", password="pass12345")
    session = CoachingSession.objects.create(user=owner, topic_title="传递函数")
    CoachingMessage.objects.create(session=session, role=CoachingMessageRole.USER, content="传递函数是什么？")
    client.force_login(other)

    response = client.get(f"/api/learning/coaching/sessions/{session.id}/")

    assert response.status_code == 404
```

Make sure imports include:

```py
from backend.apps.learning.models import CoachingMessage, CoachingMessageRole, CoachingSession, CoachingSessionStatus
```

- [ ] **Step 2: Run backend tests and confirm failure**

Run:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session
```

Expected: FAIL because `/api/learning/coaching/sessions/` does not exist.

- [ ] **Step 3: Add serializers and services**

In `backend/apps/learning/services.py`, add:

```py
def serialize_coaching_message(message: CoachingMessage) -> dict:
    return {
        "id": str(message.id),
        "role": message.role,
        "content": message.content,
        "verified": message.verified,
        "citations": message.citations if isinstance(message.citations, list) else [],
        "claims": message.claims if isinstance(message.claims, list) else [],
        "safety": message.safety if isinstance(message.safety, dict) else {},
        "refusalReason": message.refusal_reason,
        "degraded": message.degraded,
        "createdAt": message.created_at.isoformat(),
    }


def serialize_coaching_session_row(session: CoachingSession) -> dict:
    messages = list(getattr(session, "_prefetched_objects_cache", {}).get("messages", session.messages.all()))
    user_questions = [message for message in messages if message.role == CoachingMessageRole.USER]
    verified_replies = [message for message in messages if message.role == CoachingMessageRole.ASSISTANT and message.verified]
    citation_count = sum(len(message.citations if isinstance(message.citations, list) else []) for message in messages if message.role == CoachingMessageRole.ASSISTANT)
    return {
        "id": str(session.id),
        "status": session.status,
        "topicTitle": session.topic_title,
        "summary": session.summary,
        "questionCount": len(user_questions),
        "verifiedReplyCount": len(verified_replies),
        "citationCount": citation_count,
        "startedAt": session.started_at.isoformat(),
        "endedAt": session.ended_at.isoformat() if session.ended_at else None,
        "updatedAt": session.updated_at.isoformat(),
    }


def list_coaching_sessions(user, limit: int = 20) -> dict:
    limit = max(1, min(int(limit or 20), 50))
    sessions = (
        CoachingSession.objects
        .filter(user=user)
        .prefetch_related("messages")
        .order_by("-updated_at", "-created_at")[:limit]
    )
    return {"sessions": [serialize_coaching_session_row(session) for session in sessions]}


def coaching_session_detail(user, session_id) -> dict:
    session = get_object_or_404(
        CoachingSession.objects.prefetch_related("messages"),
        id=session_id,
        user=user,
    )
    return {
        "session": {
            **serialize_coaching_session_row(session),
            "schemaVersion": "a3.coaching-session.v1",
            "messages": [serialize_coaching_message(message) for message in session.messages.all()],
        }
    }
```

Add `get_object_or_404` import if it is not already available in `services.py`:

```py
from django.shortcuts import get_object_or_404
```

- [ ] **Step 4: Add views and URLs**

In `backend/apps/learning/views.py`, import:

```py
from backend.apps.learning.services import coaching_session_detail, list_coaching_sessions
```

Add:

```py
@require_http_methods(["GET"])
def coaching_sessions(request):
    rejected = _require_login(request)
    if rejected:
        return rejected
    limit = request.GET.get("limit") or 20
    return JsonResponse({"success": True, **list_coaching_sessions(request.user, limit=int(limit))})


@require_http_methods(["GET"])
def coaching_session_by_id(request, session_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, **coaching_session_detail(request.user, session_id)})
```

In `backend/apps/learning/urls.py`, add before `coaching/session/`:

```py
path("coaching/sessions/", views.coaching_sessions, name="learning-coaching-sessions"),
path("coaching/sessions/<uuid:session_id>/", views.coaching_session_by_id, name="learning-coaching-session-detail"),
```

- [ ] **Step 5: Add Next proxy tests**

Create `OpenMAIC/tests/a3-coaching-session-history.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchA3DjangoJson = vi.fn();

vi.mock('@/lib/server/a3-django-api', () => ({
  fetchA3DjangoJson,
}));

describe('/api/a3/coaching/sessions', () => {
  beforeEach(() => fetchA3DjangoJson.mockReset());

  it('proxies recent coaching sessions from Django', async () => {
    fetchA3DjangoJson.mockResolvedValue({
      success: true,
      sessions: [{ id: 'session-1', topicTitle: '反馈控制结构', questionCount: 2 }],
    });
    const { GET } = await import('@/app/api/a3/coaching/sessions/route');

    const response = await GET(new Request('http://localhost/api/a3/coaching/sessions?limit=10', {
      headers: { cookie: 'sessionid=test' },
    }) as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      sessions: [{ id: 'session-1', topicTitle: '反馈控制结构', questionCount: 2 }],
    });
    expect(fetchA3DjangoJson).toHaveBeenCalledWith('/api/learning/coaching/sessions/?limit=10', 'sessionid=test');
  });
});

describe('/api/a3/coaching/session/[sessionId]', () => {
  beforeEach(() => fetchA3DjangoJson.mockReset());

  it('proxies a single session detail from Django', async () => {
    fetchA3DjangoJson.mockResolvedValue({
      success: true,
      session: { id: 'session-1', messages: [{ id: 'm1', role: 'user', content: '反馈控制是什么？' }] },
    });
    const { GET } = await import('@/app/api/a3/coaching/session/[sessionId]/route');

    const response = await GET(new Request('http://localhost/api/a3/coaching/session/session-1', {
      headers: { cookie: 'sessionid=test' },
    }) as never, { params: Promise.resolve({ sessionId: 'session-1' }) });

    expect(response.status).toBe(200);
    expect(fetchA3DjangoJson).toHaveBeenCalledWith('/api/learning/coaching/sessions/session-1/', 'sessionid=test');
  });
});
```

- [ ] **Step 6: Implement Next proxies**

Create `OpenMAIC/app/api/a3/coaching/sessions/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson } from '@/lib/server/a3-django-api';
import type { CoachingSessionListItem } from '@/lib/a3/coaching-types';

type SessionsResponse = {
  sessions?: CoachingSessionListItem[];
};

export async function GET(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const limit = request.nextUrl.searchParams.get('limit') || '20';
    const result = await fetchA3DjangoJson<SessionsResponse>(`/api/learning/coaching/sessions/?limit=${encodeURIComponent(limit)}`, cookieHeader);
    if (!result.success || !Array.isArray(result.sessions)) {
      return apiError('UPSTREAM_ERROR', 502, result.error || '辅导历史加载失败');
    }
    return apiSuccess({ sessions: result.sessions });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '辅导历史暂时不可用', error instanceof Error ? error.message : undefined);
  }
}
```

Create `OpenMAIC/app/api/a3/coaching/session/[sessionId]/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson } from '@/lib/server/a3-django-api';

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

type SessionDetailResponse = {
  session?: Record<string, unknown>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { sessionId } = await context.params;
    const cookieHeader = request.headers.get('cookie');
    const result = await fetchA3DjangoJson<SessionDetailResponse>(`/api/learning/coaching/sessions/${encodeURIComponent(sessionId)}/`, cookieHeader);
    if (!result.success || !result.session) {
      return apiError('UPSTREAM_ERROR', 502, result.error || '辅导记录加载失败');
    }
    return apiSuccess({ session: result.session });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '辅导记录暂时不可用', error instanceof Error ? error.message : undefined);
  }
}
```

- [ ] **Step 7: Run backend and frontend targeted tests**

Run:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session

cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-coaching-session-history.test.ts
```

Expected: PASS.

---

### Task 3: Add Backend-Owned Session Summary And Learning Writeback

**Files:**
- Modify: `backend/apps/learning/services.py`
- Modify: `backend/apps/learning/views.py`
- Modify: `backend/apps/learning/urls.py`
- Modify: `backend/apps/learning/tests/test_coaching_session.py`
- Create: `OpenMAIC/app/api/a3/coaching/session/summary/route.ts`
- Modify: `OpenMAIC/tests/a3-coaching-session-history.test.ts`
- Modify: `OpenMAIC/components/a3/features/coaching-view.tsx`

- [ ] **Step 1: Write backend summary/writeback test**

Add to `backend/apps/learning/tests/test_coaching_session.py`:

```py
def test_coaching_summary_updates_session_metadata_and_notification(client, django_user_model):
    user = django_user_model.objects.create_user(username="student-summary", password="pass12345")
    client.force_login(user)
    session = CoachingSession.objects.create(user=user, topic_title="反馈控制结构")
    CoachingMessage.objects.create(session=session, role=CoachingMessageRole.USER, content="为什么负反馈能改善稳定性？")
    CoachingMessage.objects.create(
        session=session,
        role=CoachingMessageRole.ASSISTANT,
        content="负反馈能降低扰动影响，但需要结合稳定裕度判断。",
        verified=True,
        citations=[{"title": "控制系统基础", "location": "第 1 章"}],
        claims=[{"id": "c1", "text": "负反馈能降低扰动影响", "verified": True}],
    )

    response = client.post(f"/api/learning/coaching/sessions/{session.id}/summary/")

    assert response.status_code == 201
    payload = response.json()
    assert payload["success"] is True
    assert payload["summary"]["questionCount"] == 1
    assert payload["summary"]["verifiedReplyCount"] == 1
    assert payload["summary"]["citationCount"] == 1
    assert payload["summary"]["nextAction"]["href"] in {"/a3/wrong-notebook", "/a3/study-plan", "/a3/assessment"}
    session.refresh_from_db()
    assert session.metadata["summary"]["schemaVersion"] == "a3.coaching-summary.v1"
```

- [ ] **Step 2: Run backend summary test and confirm failure**

Run:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session
```

Expected: FAIL because summary endpoint does not exist.

- [ ] **Step 3: Implement backend summary service**

In `backend/apps/learning/services.py`, add:

```py
def summarize_coaching_session(user, session_id) -> dict:
    session = get_object_or_404(
        CoachingSession.objects.prefetch_related("messages"),
        id=session_id,
        user=user,
    )
    messages = list(session.messages.all())
    user_questions = [message for message in messages if message.role == CoachingMessageRole.USER]
    assistant_replies = [message for message in messages if message.role == CoachingMessageRole.ASSISTANT]
    verified_replies = [message for message in assistant_replies if message.verified]
    citation_count = sum(len(message.citations if isinstance(message.citations, list) else []) for message in assistant_replies)
    latest_questions = [message.content for message in user_questions[-3:]]
    weak_point_signals = _coaching_weak_point_signals(latest_questions)
    next_action = _coaching_next_action(weak_point_signals, verified_replies, assistant_replies)
    summary = {
        "schemaVersion": "a3.coaching-summary.v1",
        "questionCount": len(user_questions),
        "assistantReplyCount": len(assistant_replies),
        "verifiedReplyCount": len(verified_replies),
        "unverifiedReplyCount": len(assistant_replies) - len(verified_replies),
        "citationCount": citation_count,
        "weakPointSignals": weak_point_signals,
        "latestQuestions": latest_questions,
        "nextAction": next_action,
        "generatedAt": timezone.now().isoformat(),
    }
    session.summary = _coaching_summary_sentence(session.topic_title, summary)
    metadata = session.metadata if isinstance(session.metadata, dict) else {}
    session.metadata = {**metadata, "summary": summary}
    session.save(update_fields=["summary", "metadata", "updated_at"])
    create_notification(
        title="面对面辅导总结已生成",
        user=user,
        detail=session.summary,
        notification_type=NotificationType.SYSTEM,
        action_url=next_action["href"],
        payload={"coachingSessionId": str(session.id), "summary": summary},
    )
    return {"summary": summary, "session": serialize_coaching_session_row(session)}


def _coaching_weak_point_signals(questions: list[str]) -> list[str]:
    text = " ".join(questions)
    signals = []
    for keyword in ["稳定性", "稳态误差", "根轨迹", "传递函数", "频域", "反馈"]:
        if keyword in text:
            signals.append(keyword)
    return signals[:5]


def _coaching_next_action(weak_point_signals: list[str], verified_replies: list[CoachingMessage], assistant_replies: list[CoachingMessage]) -> dict:
    if weak_point_signals:
        return {
            "label": "加入错题复盘",
            "href": "/a3/wrong-notebook",
            "reason": f"本次辅导暴露了 {weak_point_signals[0]} 相关薄弱点，建议安排复盘。",
        }
    if assistant_replies and len(verified_replies) < len(assistant_replies):
        return {
            "label": "补充知识库资料",
            "href": "/a3/knowledge-base",
            "reason": "本次存在未验证回答，补充资料后再追问能提升可信度。",
        }
    return {
        "label": "生成随堂测评",
        "href": "/a3/assessment",
        "reason": "本次回答已有引用证据，建议通过测评确认掌握度。",
    }


def _coaching_summary_sentence(topic_title: str, summary: dict) -> str:
    topic = topic_title or "面对面辅导"
    return f"{topic}：完成 {summary['questionCount']} 次提问，{summary['verifiedReplyCount']} 条回答已验证，下一步建议：{summary['nextAction']['label']}。"
```

- [ ] **Step 4: Add summary view and URL**

In `backend/apps/learning/views.py`, import:

```py
from backend.apps.learning.services import summarize_coaching_session
```

Add:

```py
@require_http_methods(["POST"])
def coaching_session_summary(request, session_id):
    rejected = _require_login(request)
    if rejected:
        return rejected
    return JsonResponse({"success": True, **summarize_coaching_session(request.user, session_id)}, status=201)
```

In `backend/apps/learning/urls.py`, add:

```py
path("coaching/sessions/<uuid:session_id>/summary/", views.coaching_session_summary, name="learning-coaching-session-summary"),
```

- [ ] **Step 5: Add Next summary proxy test and route**

Append to `OpenMAIC/tests/a3-coaching-session-history.test.ts`:

```ts
const postA3DjangoJson = vi.fn();

vi.mock('@/lib/server/a3-django-api', () => ({
  fetchA3DjangoJson,
  postA3DjangoJson,
}));

describe('/api/a3/coaching/session/summary', () => {
  beforeEach(() => {
    fetchA3DjangoJson.mockReset();
    postA3DjangoJson.mockReset();
  });

  it('requests backend-owned summary generation', async () => {
    postA3DjangoJson.mockResolvedValue({
      success: true,
      summary: { questionCount: 1, nextAction: { label: '生成随堂测评', href: '/a3/assessment' } },
    });
    const { POST } = await import('@/app/api/a3/coaching/session/summary/route');

    const response = await POST(new Request('http://localhost/api/a3/coaching/session/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'sessionid=test' },
      body: JSON.stringify({ sessionId: 'session-1' }),
    }) as never);

    expect(response.status).toBe(201);
    expect(postA3DjangoJson).toHaveBeenCalledWith('/api/learning/coaching/sessions/session-1/summary/', 'sessionid=test', {});
  });
});
```

Create `OpenMAIC/app/api/a3/coaching/session/summary/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { postA3DjangoJson } from '@/lib/server/a3-django-api';

type SummaryResponse = {
  summary?: Record<string, unknown>;
  session?: Record<string, unknown>;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const body = await request.json() as { sessionId?: string };
    const sessionId = String(body.sessionId || '').trim();
    if (!sessionId) return apiError('MISSING_REQUIRED_FIELD', 400, '缺少辅导会话 ID');
    const result = await postA3DjangoJson<SummaryResponse>(`/api/learning/coaching/sessions/${encodeURIComponent(sessionId)}/summary/`, cookieHeader, {});
    if (!result.success || !result.summary) {
      return apiError('UPSTREAM_ERROR', 502, result.error || '辅导总结生成失败');
    }
    return apiSuccess({ summary: result.summary, session: result.session }, 201);
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '辅导总结暂时不可用', error instanceof Error ? error.message : undefined);
  }
}
```

- [ ] **Step 6: Wire page end-session to backend summary**

In `OpenMAIC/components/a3/features/coaching-view.tsx`, after successful session end, call:

```ts
const summaryResult = await a3PostJson<{ success: boolean; error?: string; summary?: CoachingSessionSummary }>('/api/a3/coaching/session/summary', {
  sessionId: activeSessionId,
});
if (summaryResult.success && summaryResult.summary) {
  setSessionSummary(summaryResult.summary);
  setStatusSuccess(true);
  setStatusMessage(`本次辅导总结已生成：${summaryResult.summary.nextAction.reason}`);
}
```

If `activeSessionId` is missing, keep the existing end-session success state and show:

```ts
setStatusMessage('本次辅导已结束，记录已保存。刷新页面后可在历史记录中继续查看。');
```

- [ ] **Step 7: Run summary tests**

Run:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session

cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-coaching-session-history.test.ts
```

Expected: PASS.

---

### Task 4: Add History Panel And Reopen Flow To The Page

**Files:**
- Modify: `OpenMAIC/components/a3/features/coaching-view.tsx`
- Modify: `OpenMAIC/lib/a3/coaching-types.ts`
- Modify: `OpenMAIC/tests/a3-coaching-state.test.ts`

- [ ] **Step 1: Add a pure helper test for history labels**

Append to `OpenMAIC/tests/a3-coaching-state.test.ts`:

```ts
import { formatCoachingSessionMeta } from '@/lib/a3/coaching-state';

it('formats session list metadata for compact history rows', () => {
  expect(formatCoachingSessionMeta({
    id: 's1',
    status: 'ended',
    topicTitle: '反馈控制结构',
    summary: '完成 2 次提问',
    questionCount: 2,
    verifiedReplyCount: 1,
    citationCount: 3,
    startedAt: '2026-07-04T09:00:00+08:00',
    endedAt: '2026-07-04T09:30:00+08:00',
    updatedAt: '2026-07-04T09:30:00+08:00',
  })).toBe('2 次提问 / 1 条已验证 / 3 个引用');
});
```

- [ ] **Step 2: Implement history metadata helper**

Add to `OpenMAIC/lib/a3/coaching-state.ts`:

```ts
import type { CoachingSessionListItem } from './coaching-types';

export function formatCoachingSessionMeta(session: CoachingSessionListItem) {
  return `${session.questionCount} 次提问 / ${session.verifiedReplyCount} 条已验证 / ${session.citationCount} 个引用`;
}
```

- [ ] **Step 3: Add page state for session history**

In `coaching-view.tsx`, add:

```ts
const [activeSessionId, setActiveSessionId] = useState('');
const [sessions, setSessions] = useState<CoachingSessionListItem[]>([]);
const [historyLoading, setHistoryLoading] = useState(true);
const [historyError, setHistoryError] = useState('');
const [sessionSummary, setSessionSummary] = useState<CoachingSessionSummary | null>(null);
```

When loading the page, request history alongside classroom/session/assessment:

```ts
const [classroomResult, sessionResult, assessment, sessionsResult] = await Promise.all([
  a3GetJson<ClassroomResponse>('/api/learning/classroom/'),
  a3GetJson<CoachingSessionResponse>('/api/a3/coaching/session'),
  a3GetJson<AssessmentResponse>('/api/assessments/current/'),
  a3GetJson<{ success: boolean; error?: string; sessions: CoachingSessionListItem[] }>('/api/a3/coaching/sessions?limit=10'),
]);
```

Set:

```ts
setSessions(sessionsResult.success ? sessionsResult.sessions : []);
setHistoryError(sessionsResult.success ? '' : sessionsResult.error ?? '辅导历史加载失败');
setHistoryLoading(false);
setActiveSessionId(sessionResult.success ? sessionResult.session?.id ?? '' : '');
```

- [ ] **Step 4: Add reopen handler**

In `coaching-view.tsx`, add:

```ts
async function reopenSession(sessionId: string) {
  setUiState('restoring');
  setError('');
  const result = await a3GetJson<{ success: boolean; error?: string; session?: { id: string; messages: CoachingMessage[]; summary: string; updatedAt: string } }>(`/api/a3/coaching/session/${sessionId}`);
  if (!result.success || !result.session) {
    setUiState('error');
    setError(result.error ?? '辅导记录加载失败');
    return;
  }
  setActiveSessionId(result.session.id);
  setMessages(result.session.messages.length ? result.session.messages : [buildCoachingWelcomeMessage(classroom)]);
  setSessionUpdatedAt(result.session.updatedAt);
  setStatusSuccess(true);
  setStatusMessage('已打开历史辅导记录，可继续追问或保存笔记。');
  setUiState('idle');
}
```

- [ ] **Step 5: Add history panel UI**

In the right column above existing tabs, add an `A3Card` titled `辅导历史`:

```tsx
<A3Card>
  <div className="mb-4 flex items-center justify-between">
    <h2 className="text-base font-semibold text-[var(--a3-text)]">辅导历史</h2>
    <Button size="sm" variant="outline" onClick={() => window.location.assign('/a3/coaching')}>新会话</Button>
  </div>
  {historyLoading && (
    <div className="space-y-2" data-testid="a3-coaching-history-loading">
      <div className="h-12 animate-pulse rounded-lg bg-[var(--a3-surface-muted)]" />
      <div className="h-12 animate-pulse rounded-lg bg-[var(--a3-surface-muted)]" />
    </div>
  )}
  {historyError && <div className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{historyError}</div>}
  {!historyLoading && !historyError && sessions.length === 0 && (
    <div className="rounded-lg bg-[var(--a3-surface-muted)] p-3 text-sm leading-6 text-[var(--a3-text-muted)]">
      暂无历史记录。完成一次提问后，系统会自动保存本次辅导。
    </div>
  )}
  <div className="space-y-2">
    {sessions.map((session) => (
      <button
        key={session.id}
        type="button"
        data-testid="a3-coaching-history-row"
        onClick={() => reopenSession(session.id)}
        className={cn(
          'w-full rounded-lg border border-[var(--a3-border)] p-3 text-left text-sm transition-colors hover:border-blue-300 hover:bg-blue-50',
          activeSessionId === session.id && 'border-blue-400 bg-blue-50',
        )}
      >
        <div className="font-medium text-[var(--a3-text)]">{session.topicTitle || '面对面辅导'}</div>
        <div className="mt-1 text-xs text-[var(--a3-text-muted)]">{formatCoachingSessionMeta(session)}</div>
      </button>
    ))}
  </div>
</A3Card>
```

- [ ] **Step 6: Run frontend checks**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-coaching-state.test.ts tests/a3-coaching-session-history.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS.

---

### Task 5: Make The Interaction State Model Visible And Safe

**Files:**
- Modify: `OpenMAIC/components/a3/features/coaching-view.tsx`
- Modify: `OpenMAIC/lib/a3/coaching-state.ts`
- Modify: `OpenMAIC/tests/a3-coaching-state.test.ts`

- [ ] **Step 1: Add test for status transitions**

Append to `OpenMAIC/tests/a3-coaching-state.test.ts`:

```ts
import { deriveCoachingUiState } from '@/lib/a3/coaching-state';

it('derives state from recorder and request flags', () => {
  expect(deriveCoachingUiState({ loadingSession: true })).toBe('restoring');
  expect(deriveCoachingUiState({ recorderIsRecording: true })).toBe('recording');
  expect(deriveCoachingUiState({ recorderIsProcessing: true })).toBe('transcribing');
  expect(deriveCoachingUiState({ asking: true })).toBe('answering');
  expect(deriveCoachingUiState({ saving: true })).toBe('saving');
  expect(deriveCoachingUiState({ ended: true })).toBe('ended');
  expect(deriveCoachingUiState({ error: '失败' })).toBe('error');
  expect(deriveCoachingUiState({})).toBe('idle');
});
```

- [ ] **Step 2: Implement derived state helper**

Add to `OpenMAIC/lib/a3/coaching-state.ts`:

```ts
export function deriveCoachingUiState(flags: {
  loadingSession?: boolean;
  recorderIsRecording?: boolean;
  recorderIsProcessing?: boolean;
  asking?: boolean;
  saving?: boolean;
  ended?: boolean;
  error?: string;
}): CoachingUiState {
  if (flags.error) return 'error';
  if (flags.loadingSession) return 'restoring';
  if (flags.saving) return 'saving';
  if (flags.recorderIsProcessing) return 'transcribing';
  if (flags.recorderIsRecording) return 'recording';
  if (flags.asking) return 'answering';
  if (flags.ended) return 'ended';
  return 'idle';
}
```

- [ ] **Step 3: Replace scattered booleans in controls**

In `coaching-view.tsx`, derive:

```ts
const derivedState = deriveCoachingUiState({
  loadingSession,
  recorderIsRecording: recorder.isRecording,
  recorderIsProcessing: recorder.isProcessing,
  asking,
  saving: savingNoteId !== '' || savingSourceId !== '',
  ended: conversationEnded,
  error,
});
const stateLabel = coachingUiStateLabel(derivedState);
const controls = getCoachingControlState(derivedState);
```

Use `controls.canRecord`, `controls.canAskWithCamera`, `controls.canToggleMedia`, and `controls.canEnd` for button disabled states.

- [ ] **Step 4: Add status strip copy**

Replace the existing real-time subtitle pill with:

```tsx
<div className="flex items-center justify-between gap-3">
  <div className="text-sm font-semibold text-[var(--a3-text)]">实时字幕</div>
  <A3Pill tone={coachingStatusTone(derivedState)}>{stateLabel}</A3Pill>
</div>
```

Below it add:

```tsx
<div className="mt-2 text-xs text-[var(--a3-text-muted)]" data-testid="a3-coaching-state-help">
  {derivedState === 'recording' && `正在录音 ${recorder.recordingTime}s，结束后自动识别。`}
  {derivedState === 'answering' && '系统正在结合学习目标、知识库来源和最近对话生成回答。'}
  {derivedState === 'saving' && '正在写入当前账号，刷新页面后仍可继续查看。'}
  {derivedState === 'idle' && '可以语音提问、拍照提问，或直接选择下方追问。'}
</div>
```

- [ ] **Step 5: Run frontend helper tests and TypeScript**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-coaching-state.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS.

---

### Task 6: Improve Verified Answer Evidence And Real Next Actions

**Files:**
- Modify: `OpenMAIC/components/a3/features/coaching-view.tsx`
- Modify: `OpenMAIC/lib/a3/coaching-state.ts`
- Modify: `OpenMAIC/tests/a3-coaching-state.test.ts`

- [ ] **Step 1: Add helper tests for answer actions**

Append to `OpenMAIC/tests/a3-coaching-state.test.ts`:

```ts
import { answerNextActions } from '@/lib/a3/coaching-state';

it('exposes only real next actions for verified assistant messages', () => {
  const actions = answerNextActions({
    id: 'a1',
    role: 'assistant',
    content: '回答',
    verified: true,
    citations: [{ title: '控制系统基础' }],
  });

  expect(actions.map((action) => action.label)).toEqual(['继续追问', '生成练习', '加入复习', '保存笔记']);
  expect(actions.find((action) => action.label === '生成练习')?.href).toBe('/a3/assessment');
  expect(actions.find((action) => action.label === '加入复习')?.href).toBe('/a3/wrong-notebook');
});

it('guides unverified answers toward knowledge base improvement', () => {
  const actions = answerNextActions({
    id: 'a1',
    role: 'assistant',
    content: '回答',
    verified: false,
    citations: [],
  });

  expect(actions.map((action) => action.label)).toEqual(['继续追问', '补充资料', '保存笔记']);
});
```

- [ ] **Step 2: Implement action helper**

Add to `OpenMAIC/lib/a3/coaching-state.ts`:

```ts
export function answerNextActions(message: CoachingMessage) {
  const base = [{ label: '继续追问', href: '/a3/coaching', kind: 'follow-up' as const }];
  if (message.verified) {
    return [
      ...base,
      { label: '生成练习', href: '/a3/assessment', kind: 'assessment' as const },
      { label: '加入复习', href: '/a3/wrong-notebook', kind: 'review' as const },
      { label: '保存笔记', href: '/a3/favorites', kind: 'note' as const },
    ];
  }
  return [
    ...base,
    { label: '补充资料', href: '/a3/knowledge-base', kind: 'knowledge-base' as const },
    { label: '保存笔记', href: '/a3/favorites', kind: 'note' as const },
  ];
}
```

- [ ] **Step 3: Render answer evidence clearly**

In `InlineVerification`, ensure these elements are visible:
- Verification pill: `已验证` or `未验证`
- Citation count
- Claim map rows with source title and location
- Safety block when `safety.safe === false`
- Unverified reason when no citation exists

Use clean Chinese labels:

```tsx
<A3Pill tone={verified ? 'green' : 'orange'}>{verified ? '已验证' : '未验证'}</A3Pill>
<span>{verified ? `引用 ${citations.length} 条 / 句级 ${verifiedClaims}/${claims.length || verifiedClaims}` : refusalReason || safety?.reason || '缺少知识库证据'}</span>
```

- [ ] **Step 4: Render real next action CTAs under assistant messages**

Under each non-welcome assistant message:

```tsx
<div className="mt-3 flex flex-wrap gap-2">
  {answerNextActions(message).map((action) => (
    action.kind === 'note' ? (
      <Button key={action.kind} size="sm" variant="outline" disabled={savingNoteId === message.id} onClick={() => saveAsNote(message)}>
        {savingNoteId === message.id ? <Loader2 className="size-3 animate-spin" /> : <Star className="size-3" />}
        {action.label}
      </Button>
    ) : action.kind === 'follow-up' ? (
      <Button key={action.kind} size="sm" variant="outline" disabled={asking} onClick={() => askQuestion(`请继续围绕“${message.content.slice(0, 40)}”追问一个容易混淆的点。`)}>
        {action.label}
      </Button>
    ) : (
      <Button key={action.kind} asChild size="sm" variant="outline">
        <Link href={action.href}>{action.label}</Link>
      </Button>
    )
  ))}
</div>
```

- [ ] **Step 5: Run frontend tests**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-coaching-state.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS.

---

### Task 7: Add Coaching Activity To Teacher Workbench Data

**Files:**
- Modify: `backend/apps/learning/services.py`
- Modify: `backend/apps/learning/tests/test_coaching_session.py`
- Optionally Modify: `OpenMAIC/components/a3/features/teacher-view.tsx` if the page has a matching summary section.

- [ ] **Step 1: Write backend test for teacher coaching audit**

Add to `backend/apps/learning/tests/test_coaching_session.py`:

```py
def test_teacher_workbench_includes_coaching_activity(client, django_user_model):
    teacher = django_user_model.objects.create_user(username="teacher-coach", password="pass12345", role="teacher")
    student = django_user_model.objects.create_user(username="student-coach-audit", password="pass12345")
    course = Course.objects.create(code="COACH-AUDIT", title="辅导审计课程")
    CourseTeachingAssignment.objects.create(teacher=teacher, course=course)
    CourseEnrollment.objects.create(user=student, course=course)
    session = CoachingSession.objects.create(user=student, course=course, status=CoachingSessionStatus.ENDED, topic_title="反馈控制结构")
    CoachingMessage.objects.create(session=session, role=CoachingMessageRole.USER, content="反馈控制是什么？")
    CoachingMessage.objects.create(session=session, role=CoachingMessageRole.ASSISTANT, content="回答", verified=True)
    client.force_login(teacher)

    response = client.get("/api/learning/teacher/workbench/")

    assert response.status_code == 200
    workbench = response.json()["workbench"]
    assert workbench["coachingSummary"]["totalSessions"] >= 1
    assert workbench["coachingSummary"]["studentsUsedCoaching"] >= 1
    assert workbench["coachingSummary"]["verifiedReplyCount"] >= 1
```

Make sure imports include:

```py
from backend.apps.learning.models import Course, CourseEnrollment, CourseTeachingAssignment
```

- [ ] **Step 2: Run backend test and confirm failure**

Run:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session
```

Expected: FAIL because `coachingSummary` is absent.

- [ ] **Step 3: Add teacher coaching summary service**

In `backend/apps/learning/services.py`, add:

```py
def _teacher_coaching_summary(students: list, courses: list[Course] | None = None) -> dict:
    queryset = CoachingSession.objects.filter(user__in=students)
    if courses is not None:
        queryset = queryset.filter(course__in=courses)
    sessions = list(queryset.prefetch_related("messages").order_by("-updated_at")[:100])
    messages = [message for session in sessions for message in session.messages.all()]
    verified_reply_count = sum(1 for message in messages if message.role == CoachingMessageRole.ASSISTANT and message.verified)
    question_count = sum(1 for message in messages if message.role == CoachingMessageRole.USER)
    return {
        "schemaVersion": "a3.teacher-coaching-summary.v1",
        "totalSessions": len(sessions),
        "studentsUsedCoaching": len({session.user_id for session in sessions}),
        "questionCount": question_count,
        "verifiedReplyCount": verified_reply_count,
        "latestSessions": [serialize_coaching_session_row(session) for session in sessions[:5]],
        "nextAction": {
            "label": "查看待干预学生",
            "href": "/a3/teacher",
            "type": "intervention",
        },
    }
```

In `teacher_workbench`, include:

```py
"coachingSummary": _teacher_coaching_summary(students, courses),
```

Use the same `students` and `courses` variables already computed for teacher resource summaries.

- [ ] **Step 4: Optionally render in teacher UI if existing structure supports it**

If `OpenMAIC/components/a3/features/teacher-view.tsx` already renders `resourcePackSummary`, add a sibling section:

```tsx
{workbench.coachingSummary && (
  <A3Card data-testid="a3-teacher-coaching-summary">
    <h2 className="text-base font-semibold text-[var(--a3-text)]">面对面辅导审计</h2>
    <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
      <Metric label="辅导会话" value={workbench.coachingSummary.totalSessions} />
      <Metric label="参与学生" value={workbench.coachingSummary.studentsUsedCoaching} />
      <Metric label="已验证回答" value={workbench.coachingSummary.verifiedReplyCount} />
    </div>
  </A3Card>
)}
```

If there is no matching local metric component, skip frontend rendering in this task and keep it as backend evidence only.

- [ ] **Step 5: Run backend tests**

Run:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session
backend\.venv\Scripts\python.exe backend\manage.py check
```

Expected: PASS.

---

### Task 8: Page Polish, Empty/Error/Loading States, And Responsive QA

**Files:**
- Modify: `OpenMAIC/components/a3/features/coaching-view.tsx`
- Modify: `OpenMAIC/components/a3/features/coaching/use-coaching-media.ts` only if media permission errors need clearer status mapping.

- [ ] **Step 1: Replace remaining unreadable page copy**

Search:

```powershell
cd D:\Download\A3
rg "鑳|涓|闈|杈|瑙|鏆|瀛|鍘|鏉|鍥|鎽|楹|绛|锛歿|€" OpenMAIC\components\a3\features\coaching-view.tsx OpenMAIC\app\api\a3\coaching OpenMAIC\tests\a3-coaching-session.test.ts
```

Expected after cleanup: no matches in the listed coaching files.

- [ ] **Step 2: Ensure every empty state has a next action**

In `KnowledgeSources`, empty state must link to `/a3/knowledge-base`.

In `RecommendedResources`, empty state must link to `/a3/recommendations`.

In `Quiz`, unavailable state must link to `/a3/assessment`.

In `SessionSummary`, no-question state must offer `开始提问` action that focuses the input or triggers the first suggestion.

- [ ] **Step 3: Add mobile-safe layout constraints**

Ensure:
- Video and assistant panes have `min-h-[320px]` on mobile and `min-h-[395px]` on desktop.
- Buttons wrap and keep icons visible.
- Tab labels do not overflow on narrow widths.
- Message content uses `break-words`.

Concrete class changes:

```tsx
<div className="grid gap-3 lg:grid-cols-2">
<div className="relative min-h-[320px] overflow-hidden rounded-[12px] bg-slate-950 lg:min-h-[395px]">
<p className="break-words text-[var(--a3-text)]">{message.content}</p>
<div className="mb-5 grid grid-cols-2 gap-1 rounded-[10px] bg-[var(--a3-surface-muted)] p-1 text-center text-xs font-medium text-[var(--a3-text-muted)] sm:grid-cols-4">
```

- [ ] **Step 4: Add purposeful motion only for state feedback**

Use existing Tailwind transitions:

```tsx
className="transition-colors duration-150"
className="transition-opacity duration-200"
```

Do not add decorative page-load animation. Respect existing `animate-pulse` and `animate-spin` only for loading/recording.

- [ ] **Step 5: Run frontend verification**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-coaching-state.test.ts tests/a3-coaching-session.test.ts tests/a3-coaching-session-history.test.ts
npx.cmd tsc --noEmit
pnpm.cmd lint
```

Expected:
- Vitest PASS.
- TypeScript PASS.
- Lint PASS, except the historical warnings listed in `AGENTS.md`.

---

### Task 9: Full A3 Regression Verification

**Files:**
- No code changes unless verification exposes a defect.

- [ ] **Step 1: Run backend checks**

Run:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

Expected: PASS.

- [ ] **Step 2: Run retrieval metrics smoke**

Run:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py evaluate_demo_retrieval --top-k 3
```

Expected: command completes and reports retrieval metrics. If data is missing, record the exact error and do not mark retrieval evidence complete.

- [ ] **Step 3: Start or confirm local services**

If services are not running:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py runserver 127.0.0.1:8000
```

In a separate terminal:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd dev --port 3002
```

Expected:
- Backend: `http://127.0.0.1:8000`
- Frontend: `http://localhost:3002`

- [ ] **Step 4: Manual page smoke**

Open `http://localhost:3002/a3/coaching` and verify:
- Page shows readable Chinese only.
- Refresh preserves the active session.
- End session creates a backend summary.
- History panel lists prior sessions and can reopen one.
- Verified assistant answer shows citations and claim mapping.
- Unverified assistant answer shows a clear unverified state.
- Save note writes through favorites API.
- Knowledge source favorite writes through favorites API.
- Empty source state links to `/a3/knowledge-base`.
- Quiz error state links to `/a3/assessment`.
- Mobile width does not overlap text or controls.

---

## Completion Criteria

This plan is complete only when:
- `/a3/coaching` contains no mojibake in visible UI or route errors.
- Active and historical sessions are stored in `CoachingSession/CoachingMessage`, not browser-only storage.
- Session history list, session detail, end session, and summary all go through real backend APIs.
- Teacher workbench backend data includes coaching activity evidence.
- Every CTA on the page either calls a real API, navigates to a real A3 route, or is disabled with a clear reason.
- Targeted backend tests, targeted Vitest tests, `tsc`, `lint`, `manage.py check`, and `validate_demo_flow --skip-seed --strict` have been run and results recorded.

## Self-Review Notes

Spec coverage:
- Real face-to-face tutoring: covered by Tasks 4, 5, 6, and 8.
- Durable data and refresh persistence: preserved from baseline and extended by Tasks 2 and 3.
- Enterprise-grade audit: covered by Tasks 3 and 7.
- UI states and polish: covered by Tasks 1, 5, 6, and 8.
- TDD execution: each behavior task starts with failing tests.

Known implementation risk:
- Existing files contain mojibake but TypeScript currently compiles. Use editor UTF-8 mode and verify with `rg` after edits.
- `teacher_workbench` structure must be inspected before inserting `coachingSummary`; use the local variable names already present in `services.py`.
- If route handler test style differs because of Next.js params typing, keep the same runtime behavior and adjust only the test harness shape.
