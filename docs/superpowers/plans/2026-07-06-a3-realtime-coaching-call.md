# A3 Realtime Coaching Call Implementation Plan

日期：2026-07-06

目标：将 `/a3/coaching` 从普通文本/录音问答升级为真实的实时通话式辅导工作台，支持低延迟语音、按需摄像头/屏幕/图片理解、hybrid RAG 证据、会话持久化、学习画像回流和能力指标展示。

执行原则：

- 不做 mock-only 成功。
- 每个按钮必须连接真实 API、真实状态或明确禁用原因。
- provider 不可用时必须明确降级到现有录音转写 + 普通问答。
- API key 只能在服务端读取，前端只能拿短期凭证或内部会话 ID。
- 每批修改后运行对应测试和基础验证命令。

## Phase 0：执行前基线检查

目的：确认当前代码结构、已有接口和数据模型，避免重复造轮子。

- [ ] 阅读以下文件：
  - `D:\Download\A3\AGENTS.md`
  - `D:\Download\A3\OpenMAIC\app\a3\coaching\page.tsx`
  - `D:\Download\A3\OpenMAIC\components\a3\features\coaching-view.tsx`
  - `D:\Download\A3\OpenMAIC\components\a3\features\coaching\use-coaching-media.ts`
  - `D:\Download\A3\OpenMAIC\app\api\a3\coaching\respond\route.ts`
  - `D:\Download\A3\backend\apps\learning\models.py`
  - `D:\Download\A3\backend\apps\learning\services.py`
  - `D:\Download\A3\backend\apps\compat\views.py`
- [ ] 确认已有 `CoachingSession`、`CoachingMessage`、`SafetyAgent`、`RetrieverAgent`、`VerifierAgent`、`FollowUpAgent` 的调用路径。
- [ ] 检查 `D:\Download\A3\backend\.env` 和 `D:\Download\A3\OpenMAIC\.env.local` 是否已有：
  - `DASHSCOPE_API_KEY`
  - `OPENAI_API_KEY`
  - `A3_REALTIME_PROVIDER`
  - 视觉模型、OCR、视觉 embedding 相关配置。
- [ ] 运行基线验证：

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check

cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
```

预期：记录当前失败项，不把历史问题误算为本次引入。

## Phase 1：类型、契约测试和 provider adapter

目的：先固定前后端契约，避免 UI 先行导致后续接不进真实 provider。

### 1.1 新增共享类型

- [ ] 新建 `D:\Download\A3\OpenMAIC\lib\a3\realtime-coaching-types.ts`
- [ ] 定义以下类型：
  - `A3RealtimeProvider`
  - `A3RealtimeStatus`
  - `A3RealtimeConnection`
  - `A3RealtimeCoachingSession`
  - `A3RealtimeEvidence`
  - `A3RealtimeTranscriptEvent`
  - `A3RealtimeFramePayload`

核心字段：

```ts
export type A3RealtimeProvider =
  | 'openai_realtime_webrtc'
  | 'dashscope_qwen_omni_realtime'
  | 'local_fallback_record_then_respond';
```

会话响应必须包含：

- `success`
- `provider`
- `model`
- `coachingSessionId`
- `connection`
- `fallbackReason`
- `instructions`

### 1.2 新增 contract test

- [ ] 新建 `D:\Download\A3\OpenMAIC\tests\a3-realtime-coaching-contract.test.ts`
- [ ] 测试内容：
  - provider 类型包含三个 provider。
  - session route 存在。
  - tool route 存在。
  - frame route 存在。
  - end route 存在。
  - provider adapter 不出现 `NEXT_PUBLIC_OPENAI_API_KEY` 或 `NEXT_PUBLIC_DASHSCOPE_API_KEY`。
  - UI component 暴露 `data-testid="a3-realtime-coaching-call"`。

运行：

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-realtime-coaching-contract.test.ts
```

预期：先失败，再随着实现逐步通过。

### 1.3 新增 provider adapter

- [ ] 新建 `D:\Download\A3\OpenMAIC\lib\server\a3-realtime-provider.ts`
- [ ] 新建 `D:\Download\A3\OpenMAIC\lib\server\a3-openai-realtime.ts`
- [ ] 新建 `D:\Download\A3\OpenMAIC\lib\server\a3-dashscope-realtime.ts`

职责：

- `selectA3RealtimeProvider()` 根据 `A3_REALTIME_PROVIDER`、`DASHSCOPE_API_KEY`、`OPENAI_API_KEY` 选择 provider。
- `createA3RealtimeSession()` 统一返回 `A3RealtimeCoachingSession`。
- OpenAI adapter 只在服务端读取 `OPENAI_API_KEY`。
- DashScope adapter 只在服务端读取 `DASHSCOPE_API_KEY`。
- provider 不可用时返回 `local_fallback_record_then_respond` 和中文 `fallbackReason`。

注意：

- provider 具体 endpoint 以执行当日官方文档为准。
- OpenAI WebRTC 应由服务端签发短期 client secret。
- DashScope 可优先接 WebSocket 服务端代理或 WebRTC 浏览器低延迟模式，按官方能力和当前 SDK 成熟度选择。

## Phase 2：实时会话 API

目的：让 `/a3/coaching` 可以创建真实 A3 辅导会话，并拿到 provider 连接信息。

### 2.1 新增 session route

- [ ] 新建 `D:\Download\A3\OpenMAIC\app\api\a3\coaching\realtime\session\route.ts`

接口：

```text
POST /api/a3/coaching/realtime/session
```

请求字段：

```json
{
  "targetId": "optional",
  "mode": "voice_video",
  "preferredProvider": "dashscope_qwen_omni_realtime"
}
```

实现要求：

- [ ] 通过 `/api/auth/me/` 校验登录态。
- [ ] 读取 `/api/learning/classroom/` 或现有学习上下文。
- [ ] 调用 Django 创建或复用 `CoachingSession`。
- [ ] 调用 provider adapter 创建实时会话。
- [ ] 返回短期凭证、provider、model、`coachingSessionId`。
- [ ] 出错时返回中文错误，不暴露 traceback。

### 2.2 后端会话创建能力补齐

如果现有 Django 接口不能单独创建 coaching session：

- [ ] 在 `D:\Download\A3\backend\apps\learning\services.py` 增加 `create_realtime_coaching_session()`。
- [ ] 在对应 views/urls 中暴露内部接口。
- [ ] metadata 记录：
  - `realtimeProvider`
  - `realtimeModel`
  - `startedAt`
  - `targetTitle`
  - `schemaVersion`

测试：

- [ ] 在 `D:\Download\A3\backend\apps\learning\tests\test_coaching_session.py` 增加创建实时会话测试。

运行：

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session --keepdb
```

## Phase 3：前端实时通话 UI 和状态机

目的：把页面从普通问答升级成可用的通话工作台，同时保留原有文本/录音 fallback。

### 3.1 新增 Hook

- [ ] 新建 `D:\Download\A3\OpenMAIC\components\a3\features\coaching\use-realtime-coaching.ts`

状态：

- `idle`
- `requesting_permission`
- `connecting`
- `live`
- `visual_focus`
- `degraded`
- `ending`
- `ended`
- `error`

方法：

- `start()`
- `end()`
- `toggleMic()`
- `toggleCamera()`
- `shareScreen()`
- `captureFrame()`
- `sendToolResult()`

实现要求：

- [ ] `start()` 调用 `/api/a3/coaching/realtime/session`。
- [ ] 返回 fallback provider 时设置 `degraded`，并展示降级原因。
- [ ] provider 连接失败时自动提供“转为录音问答”。
- [ ] `end()` 调用 `/api/a3/coaching/realtime/end`。
- [ ] 所有错误显示中文诊断。

### 3.2 新增 UI Component

- [ ] 新建 `D:\Download\A3\OpenMAIC\components\a3\features\coaching\realtime-coaching-call.tsx`

UI 要求：

- [ ] 顶部显示 provider、状态、延迟、RAG 命中。
- [ ] 主区域显示摄像头/屏幕/AI 助教状态。
- [ ] 右侧显示证据列表和视觉缩略图。
- [ ] 下方显示实时字幕和追问建议。
- [ ] 底部控制栏包含：
  - 开始
  - 结束
  - 麦克风
  - 摄像头
  - 屏幕共享
  - 看这里
  - 静音
- [ ] 每个按钮都有真实状态，不可用时展示禁用原因。

### 3.3 接入 coaching-view

- [ ] 修改 `D:\Download\A3\OpenMAIC\components\a3\features\coaching-view.tsx`
- [ ] 在现有问答区域上方加入 `RealtimeCoachingCall`。
- [ ] 保留现有文本/录音问答作为 fallback。
- [ ] 不删除已有追问 Agent 和 citation UI。

### 3.4 UI 测试

- [ ] 新建 `D:\Download\A3\OpenMAIC\e2e\tests\a3-realtime-coaching-ui.spec.ts`

覆盖：

- 页面能看到实时辅导模块。
- 点击开始会调用 session API。
- fallback 响应显示“已降级”。
- 结束按钮会调用 end API。
- 证据区能展示 `previewUrl` 缩略图。

运行：

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd playwright test e2e/tests/a3-realtime-coaching-ui.spec.ts --project=chromium
```

## Phase 4：实时 RAG tool bridge

目的：让实时模型不是自由发挥，而是可以调用 A3 本地知识库证据。

### 4.1 新增 tool route

- [ ] 新建 `D:\Download\A3\OpenMAIC\app\api\a3\coaching\realtime\tool\route.ts`

接口：

```text
POST /api/a3/coaching/realtime/tool
```

支持工具：

- `retrieve_learning_evidence`
- `verify_realtime_answer`
- `generate_follow_up_questions`
- `write_learning_event`

`retrieve_learning_evidence` 要求：

- [ ] 转发到 Django hybrid retrieval。
- [ ] 请求参数包含 `includeVisualEvidence`。
- [ ] 返回 text evidence 和 visual evidence。
- [ ] 每条 evidence 包含 `title`、`location`、`snippet`、`score`、`sourceType`、`previewUrl`。
- [ ] 检索失败时返回中文错误。

### 4.2 接入实时 provider 工具调用

实现方式按 provider 区分：

- OpenAI Realtime：通过 Realtime tools/function calling 将 `retrieve_learning_evidence` 暴露给模型。
- DashScope Qwen-Omni-Realtime：通过客户端事件中的 tools/function 调用机制接入；若浏览器直连能力不足，先使用服务端 WebSocket proxy。
- fallback：在普通 `/api/a3/coaching/respond` 中继续使用现有 RAG 链路。

### 4.3 前端证据展示

- [ ] 更新实时 UI 的 evidence panel。
- [ ] 展示文本 snippet。
- [ ] 展示 `previewUrl` 缩略图。
- [ ] 标明 `sourceType`：文本、视觉、混合。
- [ ] 标明 verified / unverified。

测试：

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-realtime-coaching-contract.test.ts
npx.cmd tsc --noEmit
```

## Phase 5：视觉帧理解

目的：支持“看这里”的摄像头、屏幕和上传图片理解。

### 5.1 新增 frame route

- [ ] 新建 `D:\Download\A3\OpenMAIC\app\api\a3\coaching\realtime\frame\route.ts`

接口：

```text
POST /api/a3/coaching/realtime/frame
```

请求字段：

```json
{
  "coachingSessionId": "123",
  "source": "camera",
  "imageDataUrl": "data:image/jpeg;base64,...",
  "prompt": "请看这道题"
}
```

实现要求：

- [ ] 校验登录态。
- [ ] 校验图片格式和大小。
- [ ] 调用现有 VLM 视觉问答能力。
- [ ] 调用 visual_vector retrieval。
- [ ] 返回视觉摘要、证据、建议回答。
- [ ] 写入 `CoachingMessage.metadata.visualEvidence`。
- [ ] 不暴露本地绝对路径。

### 5.2 前端截图/抽帧

- [ ] `captureFrame()` 从摄像头或屏幕 canvas 生成压缩 JPEG。
- [ ] 默认只在用户点击“看这里”时发送。
- [ ] 自动低频抽帧必须受 `A3_REALTIME_FRAME_INTERVAL_MS` 控制。
- [ ] UI 显示“正在看图”和处理结果。

### 5.3 验证

- [ ] 上传一张题目图片，确认 VLM 返回题目摘要。
- [ ] 使用 PPTX 渲染图作为视觉证据，确认 citation 出现缩略图。
- [ ] 断开 VLM key，确认页面显示中文降级信息。

## Phase 6：消息持久化、总结和学习闭环

目的：实时通话结束后必须影响学生画像、计划和教师工作台。

### 6.1 新增 message route

- [ ] 新建 `D:\Download\A3\OpenMAIC\app\api\a3\coaching\realtime\message\route.ts`

职责：

- 保存 final 字幕。
- 保存 assistant final 回复。
- 保存 tool result evidence。
- 保存视觉摘要。
- partial 字幕只在前端显示，不入库。

### 6.2 新增 end route

- [ ] 新建 `D:\Download\A3\OpenMAIC\app\api\a3\coaching\realtime\end\route.ts`

职责：

- 关闭实时会话。
- 调用 Django summary。
- 统计 provider、时长、延迟、RAG 命中、视觉帧、降级次数。
- 写回 `CoachingSession.metadata.summary`。
- 触发薄弱点、复习队列、今日任务建议更新。

### 6.3 后端学习闭环

- [ ] 在 `D:\Download\A3\backend\apps\learning\services.py` 中确认 `summarize_coaching_session` 不会覆盖已有 metadata。
- [ ] 增加 summary 输出字段：
  - `weakPoints`
  - `masterySignals`
  - `nextActions`
  - `recommendedReviewTasks`
  - `verifiedReplyCount`
  - `visualEvidenceCount`
- [ ] 如已有 Profile/StudyPlan 更新接口可复用，直接调用；否则先记录 learning event，避免硬写散落逻辑。

测试：

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session --keepdb
```

## Phase 7：能力总览和教师端指标

目的：让功能可以被答辩和真实验收，而不是只能手工看页面。

### 7.1 `/api/demo/status/` 增加指标

- [ ] 修改 `D:\Download\A3\backend\apps\compat\views.py`
- [ ] 增加 `realtimeCoaching`：

```json
{
  "schemaVersion": "a3.realtime-coaching-metrics.v1",
  "available": true,
  "latestProvider": "dashscope_qwen_omni_realtime",
  "sessionCount": 3,
  "averageLatencyMs": 980,
  "ragToolCallCount": 12,
  "ragHitRate": 0.75,
  "visualFrameCount": 4,
  "verifiedAnswerRate": 0.8,
  "fallbackCount": 0,
  "latestSessionId": "123"
}
```

### 7.2 capabilities UI

- [ ] 修改 `D:\Download\A3\OpenMAIC\components\a3\features\capabilities-view.tsx`
- [ ] 展示：
  - provider
  - session count
  - latency
  - RAG hit rate
  - visual frame count
  - fallback count
  - latest session id

### 7.3 教师工作台

- [ ] 在教师工作台学生详情或辅导摘要区域展示：
  - 最近一次实时辅导时间
  - 本次薄弱点
  - 已验证回答比例
  - 引用资料
  - 建议教师干预动作

测试：

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_demo_status --keepdb

cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
```

## Phase 8：真实联调

目的：验证不是 mock。

### 8.1 无 provider key 场景

- [ ] 临时移除或注释实时 provider key。
- [ ] 打开 `http://127.0.0.1:3002/a3/coaching`。
- [ ] 点击开始通话。
- [ ] 确认显示 `local_fallback_record_then_respond`。
- [ ] 确认仍可录音或文本提问。
- [ ] 确认回答有 citation 和追问建议。
- [ ] 确认结束后写入 `CoachingSession`。

### 8.2 DashScope provider 场景

- [ ] 在 `.env` 中配置：

```env
A3_REALTIME_PROVIDER=dashscope_qwen_omni_realtime
DASHSCOPE_API_KEY=你的 DashScope Key
DASHSCOPE_REALTIME_MODEL=qwen3.5-omni-plus-realtime
```

- [ ] 重启后端和前端。
- [ ] 点击开始通话。
- [ ] 确认 provider 显示 DashScope。
- [ ] 真实说一句和知识库相关的问题。
- [ ] 确认出现字幕和 AI 回复。
- [ ] 触发一次知识库检索。
- [ ] 点击“看这里”发送一帧图片或屏幕。
- [ ] 确认视觉摘要和缩略图 evidence 出现。

### 8.3 OpenAI provider 场景

- [ ] 在 `.env` 中配置：

```env
A3_REALTIME_PROVIDER=openai_realtime_webrtc
OPENAI_API_KEY=你的 OpenAI Key
OPENAI_REALTIME_MODEL=gpt-realtime-2
```

- [ ] 重启服务。
- [ ] 确认 session API 返回短期 client secret。
- [ ] 确认前端没有出现正式 API key。
- [ ] 完成一次语音问答和结束总结。

## Phase 9：最终验证命令

后端：

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_coaching_session backend.apps.compat.tests.test_demo_status --keepdb
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
backend\.venv\Scripts\python.exe backend\manage.py evaluate_demo_retrieval --top-k 3
```

前端：

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-realtime-coaching-contract.test.ts
npx.cmd tsc --noEmit
pnpm.cmd lint
npx.cmd playwright test e2e/tests/a3-realtime-coaching-ui.spec.ts --project=chromium
```

真实页面：

```text
http://127.0.0.1:3002/a3/coaching
http://127.0.0.1:3002/a3/capabilities
http://127.0.0.1:3002/a3/teacher
```

## Phase 10：验收清单

- [ ] `/a3/coaching` 有真实实时辅导入口。
- [ ] 未配置 provider 时明确降级，不伪装成功。
- [ ] 配置 provider 后能建立真实实时连接。
- [ ] 麦克风、摄像头、屏幕共享都有权限状态和错误状态。
- [ ] 回答能使用 hybrid retrieval。
- [ ] citation UI 能展示 `previewUrl` 缩略图。
- [ ] “看这里”能触发 VLM 和 visual_vector evidence。
- [ ] 通话结束后写入 `CoachingSession` 和 `CoachingMessage`。
- [ ] 通话总结能产生薄弱点和下一步任务。
- [ ] 教师端能看到实时辅导摘要。
- [ ] `/a3/capabilities` 能看到实时辅导指标。
- [ ] 所有用户可见错误都是正常中文。
- [ ] 前端没有暴露 API key。
- [ ] 基础验证命令通过，或明确记录剩余失败原因。

## 交付说明模板

实施完成后最终回复必须包含：

```text
已完成：
- 文件和功能点

接口路径：
- 请求字段
- 响应字段
- 前端调用位置

验证：
- backend check
- backend tests
- tsc
- lint
- vitest
- playwright
- 真实页面联调

未完成：
- 明确剩余风险

下一步：
- 1-3 个可直接执行的任务
```
