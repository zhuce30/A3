# A3 Classroom Image Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let students upload a local image as a classroom chat attachment and receive a multimodal LLM answer using the same verified vision pipeline as `/api/a3/coaching/vision`.

**Architecture:** The classroom page owns attachment selection, preview, validation, and history writeback. The Next API route `/api/a3/coaching/respond` accepts optional image attachments and internally delegates to a shared server helper extracted from the existing vision route. Django does not need a new image-upload endpoint because the image is not persisted; Django remains responsible for auth-backed classroom context, answer verification, and classroom history.

**Tech Stack:** Next.js App Router, React, TypeScript, Vitest, Django verification APIs, existing A3 `fetchA3DjangoJson` and `postA3DjangoJson` helpers.

---

## File Structure

- Create `OpenMAIC/lib/server/a3-vision-answer.ts`
  - Shared server helper for validating image data URLs, building the vision prompt, calling the multimodal model, and running VerifierAgent.
- Modify `OpenMAIC/app/api/a3/coaching/vision/route.ts`
  - Keep the existing public route, but delegate its core logic to `answerA3VisionQuestion`.
- Modify `OpenMAIC/app/api/a3/coaching/respond/route.ts`
  - Extend request schema with optional image attachments and call the shared vision helper when one image is present.
- Modify `OpenMAIC/components/a3/features/classroom-view.tsx`
  - Add local image upload, preview, remove action, validation states, and a unified send path.
- Add `OpenMAIC/tests/a3-classroom-image-attachment.test.ts`
  - Source-level UI regression tests for upload affordance, preview state, and attachment payload shape.
- Add `OpenMAIC/tests/a3-coaching-respond-attachments.test.ts`
  - Route source regression tests for attachment schema and vision delegation.
- Add or extend `OpenMAIC/tests/a3-coaching-vision-route.test.ts`
  - Route source regression tests that `/api/a3/coaching/vision` still delegates to the shared helper.

## Request Contract

`POST /api/a3/coaching/respond`

```json
{
  "message": "请解答图片里的题目",
  "history": [
    { "role": "user", "content": "上一轮问题" },
    { "role": "assistant", "content": "上一轮回答" }
  ],
  "attachments": [
    {
      "type": "image",
      "name": "question.png",
      "mediaType": "image/png",
      "dataUrl": "data:image/png;base64,..."
    }
  ]
}
```

Response stays compatible with the current classroom chat:

```json
{
  "success": true,
  "reply": "识别与解答内容",
  "verified": false,
  "citations": [],
  "claims": [],
  "safety": {
    "safe": true,
    "category": "vision",
    "reason": "已完成视觉解题并进行引用验证"
  },
  "refusalReason": "",
  "degraded": false
}
```

---

### Task 1: Shared Vision Helper

**Files:**
- Create: `OpenMAIC/lib/server/a3-vision-answer.ts`
- Modify: `OpenMAIC/app/api/a3/coaching/vision/route.ts`
- Test: `OpenMAIC/tests/a3-coaching-vision-route.test.ts`

- [ ] **Step 1: Write the failing route-delegation test**

Create `OpenMAIC/tests/a3-coaching-vision-route.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const routePath = path.resolve(process.cwd(), 'app/api/a3/coaching/vision/route.ts');

describe('A3 coaching vision route', () => {
  it('delegates multimodal answering to the shared vision helper', () => {
    const source = fs.readFileSync(routePath, 'utf8');

    expect(source).toContain("import { answerA3VisionQuestion } from '@/lib/server/a3-vision-answer';");
    expect(source).toContain('return answerA3VisionQuestion({');
    expect(source).not.toContain('const MAX_IMAGE_DATA_URL_LENGTH');
    expect(source).not.toContain('fetch(`${baseUrl}/chat/completions`');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-coaching-vision-route.test.ts
```

Expected: FAIL because the route still contains inline vision logic.

- [ ] **Step 3: Create the shared helper**

Create `OpenMAIC/lib/server/a3-vision-answer.ts` with this exported API:

```ts
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { fetchA3DjangoJson, postA3DjangoJson } from '@/lib/server/a3-django-api';
import { A3_COACHING_SYSTEM_PROMPT, buildA3CoachingContextPrompt, buildA3VisionFallbackReply } from '@/lib/server/a3-coaching-context';
import type { ClassroomContext } from '@/lib/a3/classroom-types';

type ClassroomContextResponse = {
  success?: boolean;
  error?: string;
  classroom?: ClassroomContext;
};

type VerificationResponse = {
  success?: boolean;
  error?: string;
  answer?: string;
  citations?: Array<{ id?: string; title?: string; location?: string; type?: string; score?: number | null; snippet?: string }>;
  verified?: boolean;
  safety?: { safe: boolean; category: string; reason: string };
  refusalReason?: string;
  claims?: Array<{ id: string; text: string; verified: boolean; overlap: number }>;
};

type AnswerA3VisionQuestionInput = {
  cookieHeader: string | null;
  image: string;
  message: string;
};

const MAX_IMAGE_DATA_URL_LENGTH = 7_000_000;
const IMAGE_DATA_URL_PATTERN = /^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i;

export async function answerA3VisionQuestion({ cookieHeader, image, message }: AnswerA3VisionQuestionInput) {
  const normalizedImage = image.trim();
  const normalizedMessage = message.trim() || '请观察这张课堂图片，识别与学习相关的题目、公式或板书，并结合当前学习目标给出解答。';

  if (!normalizedImage) return apiError('MISSING_REQUIRED_FIELD', 400, '请提供图片附件');
  if (normalizedImage.length > MAX_IMAGE_DATA_URL_LENGTH || !IMAGE_DATA_URL_PATTERN.test(normalizedImage)) {
    return apiError('INVALID_REQUEST', 400, '图片格式或大小不符合要求');
  }

  const classroomResult = await fetchA3DjangoJson<ClassroomContextResponse>('/api/learning/classroom/', cookieHeader);
  if (!classroomResult.success || !classroomResult.classroom) {
    return apiError('UPSTREAM_ERROR', 502, classroomResult.error || '课堂上下文加载失败');
  }

  const apiKey = process.env.A3_VISION_COACHING_API_KEY || process.env.A3_COACHING_API_KEY || process.env.QWEN_API_KEY || process.env.ASR_QWEN_API_KEY;
  if (!apiKey) {
    const reply = buildA3VisionFallbackReply(normalizedMessage, classroomResult.classroom);
    const verification = await verifyVisionReply(cookieHeader, normalizedMessage, reply, classroomResult.classroom);
    return apiSuccess({
      reply: verification.answer || reply,
      verified: Boolean(verification.verified),
      citations: verification.citations ?? [],
      claims: verification.claims ?? [],
      safety: verification.safety ?? { safe: true, category: 'vision_fallback', reason: '视觉模型未配置，已降级为文本学习指导' },
      refusalReason: verification.refusalReason ?? 'vision_model_unavailable',
      degraded: true,
    });
  }

  const baseUrl = (process.env.A3_VISION_COACHING_BASE_URL || process.env.A3_COACHING_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
  const model = process.env.A3_VISION_COACHING_MODEL || 'qwen-vl-plus';
  const contextPrompt = buildA3CoachingContextPrompt(classroomResult.classroom);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.25,
      messages: [
        { role: 'system', content: A3_COACHING_SYSTEM_PROMPT },
        ...(contextPrompt ? [{ role: 'system' as const, content: contextPrompt }] : []),
        {
          role: 'user',
          content: [
            { type: 'text', text: `${normalizedMessage}\n请只识别图片中与学习、题目、公式、图表、板书相关的内容，不要描述学生外貌、环境隐私或无关背景。` },
            { type: 'image_url', image_url: { url: normalizedImage } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const result = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) return apiError('UPSTREAM_ERROR', 502, result.error?.message || '视觉辅导服务请求失败');

  const reply = result.choices?.[0]?.message?.content?.trim();
  if (!reply) return apiError('UPSTREAM_ERROR', 502, '视觉辅导服务未返回有效内容');

  const verification = await verifyVisionReply(cookieHeader, normalizedMessage, reply, classroomResult.classroom);
  return apiSuccess({
    reply: verification.answer || reply,
    verified: Boolean(verification.verified),
    citations: verification.citations ?? [],
    claims: verification.claims ?? [],
    safety: verification.safety,
    refusalReason: verification.refusalReason ?? '',
    degraded: false,
  });
}

async function verifyVisionReply(cookieHeader: string | null, question: string, answer: string, classroom: ClassroomContext) {
  const verification = await postA3DjangoJson<VerificationResponse>('/api/verify/answer/', cookieHeader, {
    question,
    answer,
    sources: classroom.sources ?? [],
  });
  if (!verification.success) {
    return {
      answer,
      verified: false,
      citations: [],
      claims: [],
      safety: { safe: false, category: 'verifier_unavailable', reason: verification.error || '验证服务暂时不可用' },
      refusalReason: 'verifier_unavailable',
    };
  }
  return verification;
}
```

- [ ] **Step 4: Refactor the vision route to call the helper**

Replace the inline implementation in `OpenMAIC/app/api/a3/coaching/vision/route.ts` with:

```ts
import { NextRequest } from 'next/server';
import { apiError } from '@/lib/server/api-response';
import { fetchA3DjangoJson } from '@/lib/server/a3-django-api';
import { answerA3VisionQuestion } from '@/lib/server/a3-vision-answer';
import type { A3PublicUser } from '@/lib/a3/auth-types';

type AuthMeResponse = {
  user?: A3PublicUser | null;
};

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get('cookie');
    const auth = await fetchA3DjangoJson<AuthMeResponse>('/api/auth/me/', cookieHeader);
    if (!auth.success || !auth.user) {
      return apiError('UNAUTHORIZED', 401, '请先登录后使用视觉辅导');
    }

    const body = await request.json() as { image?: string; message?: string };
    return answerA3VisionQuestion({
      cookieHeader,
      image: body.image ?? '',
      message: body.message ?? '',
    });
  } catch (error) {
    return apiError('INTERNAL_ERROR', 500, '视觉辅导服务暂时不可用', error instanceof Error ? error.message : undefined);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-coaching-vision-route.test.ts
```

Expected: PASS.

---

### Task 2: Extend Text Respond API With Image Attachments

**Files:**
- Modify: `OpenMAIC/app/api/a3/coaching/respond/route.ts`
- Test: `OpenMAIC/tests/a3-coaching-respond-attachments.test.ts`

- [ ] **Step 1: Write the failing route contract test**

Create `OpenMAIC/tests/a3-coaching-respond-attachments.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const routePath = path.resolve(process.cwd(), 'app/api/a3/coaching/respond/route.ts');

describe('A3 coaching respond image attachments', () => {
  it('accepts optional image attachments and delegates them to the vision helper', () => {
    const source = fs.readFileSync(routePath, 'utf8');

    expect(source).toContain("import { answerA3VisionQuestion } from '@/lib/server/a3-vision-answer';");
    expect(source).toContain('attachments?: CoachingAttachment[]');
    expect(source).toContain("item.type === 'image'");
    expect(source).toContain('return answerA3VisionQuestion({');
    expect(source).toContain('image: imageAttachment.dataUrl');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-coaching-respond-attachments.test.ts
```

Expected: FAIL because the route does not know about attachments.

- [ ] **Step 3: Extend route types and delegate image requests**

Modify `OpenMAIC/app/api/a3/coaching/respond/route.ts`:

```ts
import { answerA3VisionQuestion } from '@/lib/server/a3-vision-answer';

type CoachingAttachment = {
  type?: string;
  name?: string;
  mediaType?: string;
  dataUrl?: string;
};
```

Change body parsing to:

```ts
const body = await request.json() as {
  message?: string;
  history?: CoachingHistoryTurn[];
  attachments?: CoachingAttachment[];
};
const message = body.message?.trim();
if (!message) return apiError('MISSING_REQUIRED_FIELD', 400, '请输入问题');
if (message.length > 2000) return apiError('INVALID_REQUEST', 400, '问题内容过长');

const imageAttachment = Array.isArray(body.attachments)
  ? body.attachments.find((item) => item?.type === 'image' && typeof item.dataUrl === 'string' && item.dataUrl.trim())
  : undefined;

if (imageAttachment?.dataUrl) {
  return answerA3VisionQuestion({
    cookieHeader,
    image: imageAttachment.dataUrl,
    message: buildVisionAttachmentQuestion(message, imageAttachment),
  });
}
```

Add helper near `buildCoachingQuestion`:

```ts
function buildVisionAttachmentQuestion(message: string, attachment: CoachingAttachment) {
  const name = attachment.name?.trim();
  const mediaType = attachment.mediaType?.trim();
  const attachmentMeta = [name ? `文件名：${name}` : '', mediaType ? `类型：${mediaType}` : ''].filter(Boolean).join('，');
  return [
    attachmentMeta ? `学生上传了一张本地图片（${attachmentMeta}）。` : '学生上传了一张本地图片。',
    '请识别图片中的题目、公式、图表、手写步骤或板书内容。',
    `学生文字问题：${message}`,
    '请结合当前课堂目标进行解答，并在证据不足时标注未验证。',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-coaching-respond-attachments.test.ts
```

Expected: PASS.

---

### Task 3: Classroom Upload UI and Unified Send

**Files:**
- Modify: `OpenMAIC/components/a3/features/classroom-view.tsx`
- Test: `OpenMAIC/tests/a3-classroom-image-attachment.test.ts`

- [ ] **Step 1: Write the failing UI source test**

Create `OpenMAIC/tests/a3-classroom-image-attachment.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = path.resolve(process.cwd(), 'components/a3/features/classroom-view.tsx');

describe('A3 classroom image attachment UI', () => {
  it('supports local image upload as a chat attachment', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain("ImageIcon");
    expect(source).toContain("const [imageAttachment, setImageAttachment]");
    expect(source).toContain('data-testid="a3-classroom-image-upload"');
    expect(source).toContain('accept="image/*"');
    expect(source).toContain('readImageAttachment');
    expect(source).toContain('attachments: imageAttachment');
    expect(source).toContain('data-testid="a3-classroom-image-preview"');
    expect(source).toContain('data-testid="a3-classroom-image-remove"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-classroom-image-attachment.test.ts
```

Expected: FAIL because classroom input has no upload control yet.

- [ ] **Step 3: Add attachment state and file conversion helpers**

In `OpenMAIC/components/a3/features/classroom-view.tsx`, add icon imports:

```ts
import {
  Image as ImageIcon,
  X,
} from 'lucide-react';
```

Add types and constants near `EmbeddedPracticeState`:

```ts
type ClassroomImageAttachment = {
  type: 'image';
  name: string;
  mediaType: string;
  dataUrl: string;
  size: number;
};

const MAX_CLASSROOM_IMAGE_BYTES = 6 * 1024 * 1024;
const CLASSROOM_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
```

Add component state:

```ts
const [imageAttachment, setImageAttachment] = useState<ClassroomImageAttachment | null>(null);
const [imageAttachmentError, setImageAttachmentError] = useState('');
const imageInputRef = useRef<HTMLInputElement | null>(null);
```

Add helpers:

```ts
async function handleImageUpload(file?: File) {
  setImageAttachmentError('');
  if (!file) return;
  try {
    const attachment = await readImageAttachment(file);
    setImageAttachment(attachment);
  } catch (error) {
    setImageAttachment(null);
    setImageAttachmentError(error instanceof Error ? error.message : '图片读取失败，请重新选择。');
  }
}

function readImageAttachment(file: File): Promise<ClassroomImageAttachment> {
  if (!CLASSROOM_IMAGE_TYPES.has(file.type)) {
    return Promise.reject(new Error('仅支持 PNG、JPG、JPEG 或 WebP 图片。'));
  }
  if (file.size > MAX_CLASSROOM_IMAGE_BYTES) {
    return Promise.reject(new Error('图片不能超过 6MB，请压缩后再上传。'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'));
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl.startsWith('data:image/')) {
        reject(new Error('图片格式不正确，请重新选择。'));
        return;
      }
      resolve({
        type: 'image',
        name: file.name,
        mediaType: file.type,
        dataUrl,
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}
```

- [ ] **Step 4: Send attachments through the existing respond route**

In `askQuestion`, include the current attachment in the fetch body:

```ts
const attachmentForRequest = imageAttachment;
const userMessage: ChatMessage = {
  id: crypto.randomUUID(),
  role: 'user',
  content: attachmentForRequest ? `${normalized}\n\n[图片附件：${attachmentForRequest.name}]` : normalized,
  createdAt: new Date().toISOString(),
};
```

Change request body:

```ts
body: JSON.stringify({
  message: normalized,
  history: chatRef.current.map(({ role, content }) => ({ role, content })),
  ...(attachmentForRequest ? {
    attachments: [{
      type: 'image',
      name: attachmentForRequest.name,
      mediaType: attachmentForRequest.mediaType,
      dataUrl: attachmentForRequest.dataUrl,
    }],
  } : {}),
}),
```

After a successful assistant response:

```ts
setImageAttachment(null);
if (imageInputRef.current) imageInputRef.current.value = '';
```

- [ ] **Step 5: Add the upload control and preview**

Replace the classroom input row with this structure:

```tsx
{imageAttachment && (
  <div data-testid="a3-classroom-image-preview" className="mb-3 flex items-center gap-3 rounded-xl border border-blue-100 bg-blue-50 p-2 text-xs text-blue-800">
    <img src={imageAttachment.dataUrl} alt={imageAttachment.name} className="size-12 rounded-lg object-cover" />
    <div className="min-w-0 flex-1">
      <div className="truncate font-semibold">{imageAttachment.name}</div>
      <div>{Math.max(1, Math.round(imageAttachment.size / 1024))} KB</div>
    </div>
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid="a3-classroom-image-remove"
      onClick={() => {
        setImageAttachment(null);
        setImageAttachmentError('');
        if (imageInputRef.current) imageInputRef.current.value = '';
      }}
    >
      <X className="size-4" />
    </Button>
  </div>
)}
{imageAttachmentError && <div className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{imageAttachmentError}</div>}
<form onSubmit={(event) => { event.preventDefault(); void askQuestion(); }} className="flex items-center gap-3">
  <input
    ref={imageInputRef}
    type="file"
    accept="image/*"
    className="hidden"
    data-testid="a3-classroom-image-upload"
    onChange={(event) => void handleImageUpload(event.target.files?.[0])}
  />
  <Button
    type="button"
    variant="outline"
    disabled={asking || !target}
    className="h-12 rounded-xl bg-white px-3"
    onClick={() => imageInputRef.current?.click()}
    title="上传本地图片题目"
  >
    <ImageIcon className="size-4" />
  </Button>
  <input
    value={input}
    onChange={(event) => setInput(event.target.value)}
    data-testid="a3-classroom-input"
    className="h-12 flex-1 rounded-xl border border-[var(--a3-border)] bg-[var(--a3-surface-solid)] px-4 text-sm outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-100"
    placeholder={target ? `围绕“${target.title}”提问，可上传图片题目一起解答` : '请先生成学习路径后再开始课堂提问'}
    disabled={!target}
  />
  <Button data-testid="a3-classroom-submit" type="submit" disabled={asking || !target || (!input.trim() && !imageAttachment)} className="h-12 rounded-xl bg-blue-600 px-4 hover:bg-blue-700">
    {asking ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
  </Button>
</form>
```

- [ ] **Step 6: Run test to verify it passes**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-classroom-image-attachment.test.ts
```

Expected: PASS.

---

### Task 4: Verification and Regression

**Files:**
- No new implementation files.

- [ ] **Step 1: Run focused Vitest coverage**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-classroom-image-attachment.test.ts tests/a3-coaching-respond-attachments.test.ts tests/a3-coaching-vision-route.test.ts tests/a3-classroom-markdown.test.ts tests/a3-classroom-verification-rendering.test.ts tests/a3-coaching-markdown-rendering.test.ts
```

Expected: all listed tests PASS.

- [ ] **Step 2: Run frontend type check**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
```

Expected: exit code 0.

- [ ] **Step 3: Run frontend lint**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd lint
```

Expected: 0 errors. Existing warnings may remain only if they match the AGENTS.md allowed warning list.

- [ ] **Step 4: Run backend smoke checks**

Run:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

Expected: both commands exit code 0.

- [ ] **Step 5: Manual browser verification**

Run the app, open `/a3/classroom`, then:

1. Click the image button beside the classroom input.
2. Select a local PNG/JPG/WebP exercise image.
3. Confirm thumbnail, filename, and remove button appear.
4. Enter `请解答图片里的题目，并说明关键步骤。`
5. Send.
6. Confirm assistant response appears in the same chat stream.
7. Confirm verification block still renders citations/claims.
8. Refresh page and confirm text history is retained without exposing the raw local file path.

Expected: the page never displays local absolute paths, never exposes API keys, and does not claim success when the vision model is unavailable. If no vision key is configured, the response must be a degraded explanation asking the student to provide formula/text details.

---

## Self-Review

- Spec coverage: the plan covers local upload UI, attachment request protocol, shared vision helper, existing vision route compatibility, classroom history writeback through the current `askQuestion` flow, and verification.
- Placeholder scan: no task uses undefined placeholders; each step names exact files, commands, and expected outcomes.
- Type consistency: `ClassroomImageAttachment`, `CoachingAttachment`, and `answerA3VisionQuestion` are used consistently across UI, respond route, and vision route.
