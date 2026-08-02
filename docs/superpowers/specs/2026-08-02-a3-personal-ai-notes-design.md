# A3 个人 AI 笔记设计

日期：2026-08-02

## 1. 背景与目标

A3 已有收藏、课程知识库、今日任务、AI 课堂、学习画像和学习报告，但缺少一个以用户自己的长期文档为中心、可以持续编辑和积累的个人工作空间。现有收藏模型只适合保存资源入口，课程知识库面向课程资料检索，AI 课堂面向教学对话，均不适合承载独立笔记、版本历史、附件和受用户控制的跨会话记忆。

本功能新增独立页面 `/a3/notes`，定位为“文档优先的个人 AI 笔记工作区”。它必须满足：

- 用户不依赖 AI 也能完成笔记创建、组织、编辑、检索、恢复和导出。
- AI 只在用户指定的笔记范围内辅助理解、整理和写作。
- AI 不得静默修改正文；任何写回都先展示差异并由用户确认。
- 每日总结单独保存并保留历史版本，不覆盖原笔记。
- 跨会话记忆由系统提出候选、用户确认后生效，并可暂停、修订、替代或删除。
- 不新增第二套课程检索系统，不修改 AI 课堂的页面、提示词、接口或行为。

## 2. 范围与非目标

### 2.1 本次范围

- 独立笔记本、笔记、标签和智能视图。
- 富文本正文、图片、文件、网页链接和笔记级附件。
- 自动保存、断网恢复、版本历史、回收站和导出。
- 当前笔记、当前笔记本或手动选择笔记范围内的 AI 对话。
- 带来源定位的 AI 回答和需确认的差异写回。
- 自动每日总结、手动刷新和历史总结版本。
- 仅服务个人笔记助手的工作记忆、情景记忆和核心记忆。
- 桌面端文档主场布局和移动端分离视图。

### 2.2 明确非目标

- 不把收藏页面扩展成笔记页面。
- 不将笔记或附件自动写入课程知识库。
- 不将笔记自动转成今日任务、画像字段或学习报告结论。
- 不修改 AI 课堂 UI、对话逻辑、提示词、RetrieverAgent 接口或课堂行为。
- 不新增 RAPTOR、HippoRAG、第二个向量索引或第二张知识图谱。
- 不把所有笔记内容默认视为长期记忆。
- 不允许 AI 未经确认直接改写正文或激活长期记忆。
- 不在第一版中加入多人协作、公开分享、复杂嵌套目录或实时共同编辑。

若未来需要让 AI 课堂读取个人记忆、让笔记生成今日任务或把笔记发布到课程知识库，必须另行设计权限、数据回流和撤销机制，不属于本设计。

## 3. 产品与页面设计

### 3.1 桌面布局

页面采用“文档主场 + 可收起 AI”结构：

```text
产品导航栏 | 笔记导航约 220px | 可伸缩文档编辑区 | 默认收起的 AI 侧栏
```

- 左侧只承载笔记本、智能视图、标签和紧凑笔记列表，不放数据看板。
- 中央编辑器占据主要宽度，标题、正文和附件在连续画布中呈现。
- 右侧 AI 默认收起为窄工具栏，用户主动打开后覆盖或占用受控宽度。
- 不使用层层嵌套卡片，不把统计、提示和操作拆成大量小框。
- 笔记保存状态、版本和冲突提示放在编辑器工具栏，不侵占正文首屏。

智能视图包括：最近编辑、今天、每日总结、未整理、含附件和回收站。笔记组织采用“笔记本 + 标签”，不支持无限层级文件夹。

### 3.2 移动端布局

移动端不压缩成三列，而是三个独立视图：

1. 笔记列表。
2. 全屏文档编辑器。
3. 全屏 AI 助手。

页面通过明确的返回按钮和顶部操作切换。编辑器必须保持可用高度，软键盘出现时不能遮挡当前段落和保存状态。

### 3.3 编辑与附件体验

- 正文使用项目现有 ProseMirror 基础设施重新封装笔记编辑器，不直接复用幻灯片专用编辑组件。
- 支持标题、段落、标题层级、列表、引用、代码、表格、公式、链接、图片和附件引用。
- 附件只属于当前笔记，可以下载、重新解析、移除或在正文中引用。
- DOCX、PDF、PPTX、表格和文本文件显示解析状态；解析失败不影响原文件下载。
- 网页链接保存标题、URL、抓取时间和可选摘要，不把远程页面永久镜像为课程资料。

## 4. 系统架构与边界

### 4.1 后端

新增独立 Django 应用：

```text
backend/apps/notes/
|-- models.py
|-- urls.py
|-- views.py
|-- serializers.py
|-- services/
|   |-- note_service.py
|   |-- attachment_service.py
|   |-- assistant_service.py
|   |-- digest_service.py
|   `-- memory_service.py
|-- tasks.py
`-- tests/
```

服务边界：

- `note_service`：笔记生命周期、版本、冲突和回收站。
- `attachment_service`：文件校验、持久化、解析和清理。
- `assistant_service`：作用范围组装、LLM 调用、引用和写回预览。
- `digest_service`：每日总结快照、异步生成、版本和重试。
- `memory_service`：候选提取、确认、上下文选择、替代和删除。

笔记助手复用 `backend/apps/compat/llm.py`、已有安全过滤和 `VerifierAgent` 能力。复用指调用现有能力，不修改 AI 课堂入口或课堂 Agent 的契约。

### 4.2 前端

新增模块：

```text
OpenMAIC/app/a3/notes/
OpenMAIC/components/a3/notes/
OpenMAIC/lib/a3/notes/
OpenMAIC/app/api/a3/notes/[...path]/
```

前端职责分离：

- 页面容器负责路由、选中项和响应式布局。
- 编辑器负责 ProseMirror 状态、自动保存和本地草稿。
- AI 抽屉负责会话、作用范围、引用和写回确认。
- 笔记数据客户端统一处理认证、错误、`409` 冲突和任务轮询。
- Next API 仅做鉴权会话透传和响应代理，不保存笔记任务到内存 `Map`。

### 4.3 数据流

```text
用户编辑
-> IndexedDB 本地草稿
-> PATCH /api/notes/notes/<id>/（baseVersion + clientMutationId）
-> Django 乐观锁更新
-> 返回新 version
-> 阶段性检查点写入 NoteRevision
```

```text
用户向笔记助手提问
-> 明确选择作用范围
-> 组装笔记片段、附件解析结果和已确认记忆
-> SafetyAgent / LLM / VerifierAgent
-> 流式返回回答及引用
-> 可选生成写回预览
-> 用户确认后创建修订并更新正文
```

## 5. 数据模型

所有主键使用 UUID，所有用户数据通过 `settings.AUTH_USER_MODEL` 关联。所有列表查询必须先按当前用户过滤，再解析资源 ID。

### 5.1 `Notebook`

- `user`
- `name`
- `sort_order`
- `is_archived`
- `created_at`、`updated_at`

笔记本只允许单层组织。笔记本归档不会删除其中笔记。

### 5.2 `NoteTag`

- `user`
- `name`
- `color`
- `created_at`、`updated_at`

同一用户的规范化标签名唯一，标签不会跨用户共享。

### 5.3 `Note`

- `user`
- `notebook`，可空；为空表示“未整理”
- `title`
- `content_json`，ProseMirror 文档 JSON
- `content_text`，用于列表摘要和普通关键词搜索
- `version`，从 1 递增
- `is_pinned`
- `last_edited_at`
- `deleted_at`，可空
- `created_at`、`updated_at`
- 与 `NoteTag` 的多对多关系

正文唯一事实来源是 `content_json`；`content_text` 是同一事务中生成的派生快照，不能被客户端单独修改。

### 5.4 `NoteRevision`

- `note`
- `version`
- `source`：`checkpoint`、`manual`、`ai_writeback`、`restore`
- `title_snapshot`
- `content_json_snapshot`
- `content_text_snapshot`
- `actor_metadata`
- `created_at`

普通自动保存不为每次按键创建历史版本。满足手动保存、间隔检查点、AI 写回、恢复或标题结构显著变化时才保存修订，避免数据库无限增长。自动检查点默认保留 90 天且每篇笔记最多保留 100 个；手动、AI 写回和恢复修订保留到笔记被彻底删除。

### 5.5 `NoteAttachment`

- `user`、`note`
- `kind`：`file`、`image`、`link`
- `display_name`、`relative_path`、`source_url`
- `mime_type`、`size_bytes`、`sha256`
- `parse_status`：`pending`、`processing`、`succeeded`、`failed`
- `extracted_text`
- `preview_metadata`
- `error_code`、`error_message`
- `deleted_at`
- `created_at`、`updated_at`

数据库只保存相对路径。物理文件存放在独立持久卷，不通过静态目录公开。

### 5.6 `NoteAiSession` 与 `NoteAiMessage`

`NoteAiSession`：

- `user`
- `title`
- `scope_type`：`note`、`notebook`、`selection`
- `scope_snapshot`：会话开始时明确选中的 ID 和版本
- `status`：`active`、`archived`
- `created_at`、`updated_at`

`NoteAiMessage`：

- `session`
- `role`
- `content`
- `status`：`queued`、`streaming`、`succeeded`、`failed`
- `client_request_id`，用于流式请求幂等和断线恢复
- `citations`
- `verified`、`claims`、`safety`
- `degraded`
- `error_code`、`error_message`
- `metadata`
- `created_at`

引用至少包含 `noteId`、`noteTitle`、`noteVersion`、段落定位或附件 ID。会话历史和笔记正文分开保存。

### 5.7 `NoteWritebackPreview`

- `user`、`session`、`target_note`
- `target_version`
- `proposed_content_json`
- `diff_summary`
- `status`：`pending`、`applied`、`expired`、`rejected`
- `expires_at`
- `created_at`、`updated_at`

preview 是有时效的服务端对象，不存放在 Next.js 内存中。确认时必须同时校验所有者、状态、有效期和目标版本；同一 preview 最多应用一次。

### 5.8 `NoteDailyDigest`

- `user`
- `digest_date`
- `revision`
- `status`：`queued`、`processing`、`succeeded`、`failed`
- `title`
- `content_md`
- `source_snapshot`：来源笔记 ID、版本和附件解析版本
- `generated_by`：`automatic`、`manual`
- `error_code`、`error_message`
- `created_at`、`updated_at`

同一日期允许多个修订版本，但同一幂等任务只能生成一次。旧版本始终保留，原始笔记永不被总结任务覆盖。

### 5.9 `NoteMemory`

- `user`
- `memory_type`：`core`、`episodic`
- `content`
- `status`：`candidate`、`confirmed`、`paused`、`superseded`、`deleted`
- `importance`
- `confidence`
- `source_session_id`、`source_message_id`、`source_note_refs`
- `valid_from`、`valid_until`
- `superseded_by`
- `confirmed_at`、`deleted_at`
- `created_at`、`updated_at`

`candidate` 不进入模型上下文。只有 `confirmed` 且在有效期内的记忆可以使用。删除后立即排除，后台再清理关联派生数据。

### 5.10 `NoteExportJob`

- `user`
- `status`：`queued`、`processing`、`succeeded`、`failed`、`expired`
- `format`：`markdown_zip`、`json_zip`
- `selection_snapshot`
- `relative_path`
- `expires_at`
- `error_code`、`error_message`
- `created_at`、`updated_at`

导出由 Celery 异步完成。下载文件使用鉴权接口并默认保留 24 小时，过期后清理物理文件和路径。

### 5.11 `NoteAuditEvent`

记录以下高风险或可恢复操作：AI 写回确认、版本恢复、彻底删除、记忆确认、暂停、替代和删除。审计记录只保存必要标识和状态变化，不复制完整笔记正文。

## 6. 自动保存、版本与并发

### 6.1 自动保存协议

编辑停止约 1.5 秒后触发自动保存。请求必须包含：

```json
{
  "baseVersion": 12,
  "clientMutationId": "uuid",
  "title": "进程调度复习",
  "content": {"type": "doc", "content": []}
}
```

成功返回：

```json
{
  "success": true,
  "note": {
    "id": "uuid",
    "version": 13,
    "updatedAt": "2026-08-02T10:00:00+08:00"
  }
}
```

服务端以事务和条件更新保证 `baseVersion` 必须等于当前版本。`clientMutationId` 用于幂等处理网络重试。

### 6.2 冲突处理

版本不一致返回 `409`：

```json
{
  "success": false,
  "error": "笔记已在其他窗口更新",
  "code": "note_version_conflict",
  "serverVersion": 14,
  "serverNote": {}
}
```

前端不能自动覆盖，必须提供：查看差异、保留本地副本、采用服务器版本。第一版不实现 CRDT；对于单用户跨窗口编辑，乐观锁比引入实时协作框架更可控。

### 6.3 断网恢复

- 每次编辑先写入浏览器 IndexedDB，再尝试服务器保存。
- 恢复网络后按 `clientMutationId` 顺序重试。
- 服务器确认后清除对应本地操作。
- 浏览器崩溃或刷新后检测未同步草稿，并提示恢复，不静默替换服务器内容。

## 7. 附件、解析与持久化

新增配置：

```text
A3_NOTES_STORAGE_ROOT=/app/storage/a3-notes
A3_NOTES_ATTACHMENT_MAX_BYTES=52428800
A3_NOTES_USER_QUOTA_BYTES=536870912
A3_NOTES_PARSE_TIMEOUT_SECONDS=90
```

默认限制分别为单附件 50 MiB、单用户 512 MiB、单次解析 90 秒；生产环境可以收紧，但不能通过前端请求放宽。

Docker 增加独立命名卷 `a3-notes-data`，挂载到 backend 和处理附件的 Celery worker。前端容器和 Caddy 不直接挂载该卷。

上传流程：

```text
鉴权和用户配额检查
-> 扩展名、MIME、文件头和大小校验
-> 生成不可猜测相对路径
-> 保存文件及 SHA-256
-> 创建 pending 记录
-> Celery 异步解析
-> 成功写入提取文本和预览元数据，失败写入可读原因
```

文档从不执行宏、脚本或嵌入程序。解析器必须有超时、最大页数和最大提取字符数。附件解析失败时仍可下载原文件并单独重试。彻底删除笔记后，清理任务再删除未被引用的物理文件。

网页链接只接受 `http` 和 `https`。服务端抓取必须拒绝环回地址、内网地址、云元数据地址、非标准协议及重定向后的受限目标，防止 SSRF；抓取失败时只保留用户输入的 URL，不伪造摘要。

## 8. AI 助手与引用写回

### 8.1 作用范围

用户每次会话明确选择：

- 当前笔记，默认值。
- 当前笔记本。
- 手动选择的若干笔记。

作用范围以笔记 ID 和版本快照保存，防止回答来源在生成期间悄然变化。笔记助手不得默认读取用户全部笔记。

对于当前笔记，在上下文预算内直接使用正文和附件解析结果。对于笔记本或手动选择范围，先按标题、标签、更新时间和查询词进行有界文本片段选择；该选择不创建持久向量索引或知识图谱。只有用户明确开启“补充课程资料”时，才调用现有 RetrieverAgent 获取课程知识库证据，并在引用中区分“个人笔记”和“课程资料”。

### 8.2 回答与验证

请求：

```json
{
  "sessionId": "uuid",
  "message": "帮我比较这两篇笔记中的调度算法",
  "scope": {
    "type": "selection",
    "noteIds": ["uuid-1", "uuid-2"]
  },
  "includeCourseEvidence": false
}
```

回答通过 SSE 流式返回，结束事件包含 `verified`、`citations`、`claims`、`safety` 和 `traceId`。流式连接失败时可按消息 ID读取已持久化结果，不要求重新生成整次回答。

### 8.3 写回规则

AI 回答不能直接调用笔记更新接口。写回分两步：

1. 创建 `writeback preview`，返回目标版本、建议变更和可视化差异。
2. 用户确认后提交 preview ID，服务端再次检查版本并执行事务更新。

目标笔记版本已变化时，确认接口返回 `409`，要求重新生成差异。成功写回必须创建 `NoteRevision(source=ai_writeback)` 和审计事件。

## 9. 每日总结

Celery Beat 每天北京时间 02:10 扫描前一天有编辑活动且尚无成功自动总结的用户，并按用户拆分幂等任务。手动刷新创建新的总结修订，不覆盖已有版本。

总结只允许读取：

- 目标日期内被用户编辑的个人笔记版本。
- 这些笔记直接关联且解析成功的附件内容。

总结不得读取 AI 课堂历史、今日任务、学习画像或课程知识库，除非未来另行设计并得到用户授权。总结输出包含当天主题、关键进展、未解决问题和可继续整理的线索，但不自动创建任务或修改画像。

任务失败时保留上一版本并显示失败原因。陈旧的 `queued` 或 `processing` 任务由定时恢复任务标记失败或重新入队，重复任务通过幂等键拒绝重复写入。

## 10. 跨会话记忆设计

### 10.1 理论边界

采用 MemGPT/Letta 的分层记忆思想组织上下文，并参考 Generative Agents 对记忆流中时效、重要性和相关性的区分。这里是工程化采用其公开思想，不宣称复现论文完整系统，也不引入需要专门训练反思 token 模型的 Self-RAG。

记忆分为：

- 工作记忆：当前笔记、当前会话和用户选择的作用范围，不跨会话持久激活。
- 情景记忆：过往笔记助手讨论中的纠正、决定和未解决问题。
- 核心记忆：少量稳定的用户偏好、目标和约束。

### 10.2 候选与确认

AI 会话结束或每日总结完成后，可以异步提取记忆候选。候选必须展示：建议内容、类型、来源、建议原因和影响范围。用户确认前状态为 `candidate`，不能进入任何模型上下文。

用户可以：

- 确认并启用。
- 编辑后确认。
- 拒绝并删除候选。
- 暂停已确认记忆。
- 用新记忆替代旧记忆。
- 设置有效期。
- 彻底删除。

### 10.3 上下文选择

每次笔记助手请求按以下顺序组装：

1. 当前工作记忆。
2. Token 预算内的有效核心记忆。
3. 在当前用户、已确认、未暂停、未过期范围内，按相关性、时效和重要性选择少量情景记忆。

情景记忆候选集先由时间、来源笔记和会话范围进行数据库过滤，再使用透明的词项相关性、时效和用户确认的重要度评分。该过程不创建独立向量索引。无充分依据时不注入记忆，并允许模型明确回答“不确定”。

同一主题发生变化时，新记忆通过 `superseded_by` 替代旧记忆，旧记忆保留审计关系但不再使用。删除记忆后，它必须立即从上下文选择中排除，并由后台清理派生缓存。

### 10.4 页面隔离

`NoteMemory` 只能由个人笔记助手读取。AI 课堂、面对面辅导、学习画像、推荐和报告均不读取该表。本限制必须由后端服务边界和测试保证，不能只依赖前端隐藏入口。

## 11. API 契约

后端业务前缀为 `/api/notes/`，前端统一通过 `/api/a3/notes/*` 代理。所有接口要求登录。

### 11.1 笔记与组织

```text
GET/POST   /api/notes/notebooks/
PATCH      /api/notes/notebooks/<id>/
GET/POST   /api/notes/tags/
DELETE     /api/notes/tags/<id>/
GET/POST   /api/notes/notes/
GET/PATCH  /api/notes/notes/<id>/
DELETE     /api/notes/notes/<id>/
POST       /api/notes/notes/<id>/restore/
DELETE     /api/notes/notes/<id>/purge/
GET        /api/notes/notes/<id>/revisions/
POST       /api/notes/notes/<id>/revisions/<revision_id>/restore/
GET        /api/notes/search/?q=&notebookId=&tag=&view=
POST       /api/notes/export/
GET        /api/notes/export/<job_id>/
GET        /api/notes/export/<job_id>/download/
```

`DELETE /notes/<id>/` 只进入回收站；`purge` 才执行不可逆删除，并要求二次确认字段。

### 11.2 附件

```text
POST       /api/notes/notes/<id>/attachments/
GET        /api/notes/attachments/<id>/
GET        /api/notes/attachments/<id>/download/
POST       /api/notes/attachments/<id>/reparse/
DELETE     /api/notes/attachments/<id>/
```

上传接口单独启用 multipart parser，不改变全局 JSON parser 配置。

### 11.3 AI、总结与记忆

```text
GET/POST   /api/notes/assistant/sessions/
GET        /api/notes/assistant/sessions/<id>/messages/
POST       /api/notes/assistant/chat/
POST       /api/notes/assistant/writeback-previews/
POST       /api/notes/assistant/writeback-previews/<id>/confirm/
GET        /api/notes/digests/
POST       /api/notes/digests/generate/
GET        /api/notes/digests/<id>/
GET        /api/notes/memories/
POST       /api/notes/memories/<id>/confirm/
POST       /api/notes/memories/<id>/pause/
POST       /api/notes/memories/<id>/resume/
POST       /api/notes/memories/<id>/supersede/
DELETE     /api/notes/memories/<id>/
```

失败响应沿用 A3 契约：

```json
{
  "success": false,
  "error": "可读中文错误",
  "code": "stable_machine_code"
}
```

任何接口不得返回 traceback、API key、本地绝对路径或完整内部提示词。

## 12. 隐私、安全与恢复

- 所有对象访问先校验当前用户所有权，防止通过 UUID 越权访问。
- 附件通过鉴权下载接口提供，Caddy 和前端静态目录不能直接暴露存储卷。
- 文件名规范化，物理路径使用服务端生成的不可猜测名称。
- 限制单文件大小、单笔记附件数、用户总配额、解析页数和提取文本长度。
- 文档解析不执行宏；解析进程设置超时和资源限制。
- LLM、任务和监控日志不记录完整正文，只记录 ID、状态、耗时、错误码和 `traceId`。
- AI 写回、恢复、彻底删除和记忆状态变更写入最小化审计事件。
- 支持导出 Markdown、结构化 JSON 和附件清单；导出任务使用临时文件并在过期后清理。
- 笔记回收站默认保留 30 天。记忆删除后立即停止使用，随后异步清理派生数据。

## 13. 错误处理与降级

- LLM 不可用：编辑、保存、搜索、版本、附件下载和回收站继续可用。
- 附件解析失败：保留原文件、显示可读原因并允许单独重试。
- 每日总结失败：保留历史成功版本，不创建空白总结。
- 自动保存冲突：返回 `409`，不自动选择任一版本覆盖。
- SSE 中断：前端按消息 ID 查询已持久化状态并恢复展示。
- Celery 重复执行：通过幂等键避免重复附件解析、总结或记忆候选。
- 陈旧任务：定时检测后标记失败或重新入队，不能永久显示“处理中”。
- Verifier 无法验证：回答显示未验证状态，不伪造来源或可信结论。

## 14. 测试与评估

### 14.1 后端测试

- 模型约束、索引、软删除和级联行为。
- 未登录拦截、跨用户 UUID 访问和附件下载越权。
- 自动保存幂等、乐观锁、`409` 冲突和版本恢复。
- 文件类型、MIME、大小、配额、解析超时和物理文件清理。
- AI 作用范围快照、引用归属、Verifier 和安全结果。
- AI 写回必须经过 preview/confirm，且目标版本变化后拒绝写回。
- 每日总结来源限制、版本保留、幂等和陈旧任务恢复。
- 候选记忆不生效、确认后生效、暂停、替代、过期和删除。
- AI 课堂服务不导入或查询 `NoteMemory`。

### 14.2 前端与端到端测试

- 空状态、加载、错误、保存成功、离线和冲突状态。
- 笔记本、标签、智能视图、搜索、附件、历史版本和回收站。
- AI 抽屉默认收起，文档区域保持主导宽度。
- 作用范围切换、引用跳转、写回差异和二次确认。
- 桌面三段布局和移动端列表/编辑/AI 分离视图。
- 刷新或浏览器崩溃后恢复未同步草稿。

### 14.3 记忆专项评测

参考 LongMemEval 的能力维度建立 A3 固定测试集，但不宣称直接复现其完整排行榜结果：

- 跨会话正确回忆。
- 用户纠正后采用新信息。
- 时间变化和偏好更新。
- 无依据时拒绝猜测。
- 未确认候选不进入回答。
- 暂停或删除后无法召回。
- 替代关系使用新版本，不继续引用失效内容。
- 不同用户之间绝不串记忆。

评测同时检查回答、引用、使用的记忆 ID、记忆状态和数据库结果，不能只以文案“看起来合理”判定通过。

### 14.4 基础验证命令

实施后至少运行：

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/a3-personal-notes-*.test.ts
npx.cmd playwright test e2e/tests/a3-personal-notes.spec.ts --project=chromium

cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.notes
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

## 15. 分阶段交付

### 阶段一：可独立使用的个人笔记

完成独立路由、笔记本、标签、智能视图、编辑器、附件、自动保存、断网恢复、版本历史、搜索、回收站、导出和移动端视图。该阶段即使没有模型 API 也必须完整可用。

### 阶段二：笔记 AI 与每日总结

完成限定范围问答、流式回答、引用、Verifier、安全过滤、差异写回、自动总结、手动刷新、历史版本和任务恢复。复用现有能力但不修改 AI 课堂。

### 阶段三：私有跨会话记忆

完成记忆候选、用户确认、分层上下文、暂停、修订、替代、删除、审计和 LongMemEval 风格专项评测。记忆仍只作用于 `/a3/notes`。

每个阶段都必须有真实数据库、真实接口和可复现测试，不能用前端静态数据冒充完成。后续阶段不得降低前一阶段的无 AI 可用性。

## 16. 研究依据与使用边界

- MemGPT / Letta：采用工作上下文、核心记忆和外部持久记忆分层管理的思想。参考论文 *MemGPT: Towards LLMs as Operating Systems*（arXiv:2310.08560）与 Apache-2.0 许可的 `letta-ai/letta`。A3 不直接复制其服务端，也不宣称完整复现。
- Generative Agents：采用记忆流中相关性、时效和重要性共同参与选择，以及从历史事件提出反思候选的思想。参考论文 *Generative Agents: Interactive Simulacra of Human Behavior*（arXiv:2304.03442）与 Apache-2.0 许可的 `joonspk-research/generative_agents`。
- LongMemEval：采用跨会话回忆、时间更新、偏好修正、拒答和删除一致性等评估维度。参考 *LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory* 与 MIT 许可的 `xiaowu0162/LongMemEval`。

上述研究用于定义架构和评测，不替代产品权限规则。实际实现必须保留 A3 自己的用户确认、来源引用、删除和页面隔离机制；不得将论文名称附加到未经验证的自定义算法上。

## 17. 完成标准

- `/a3/notes` 是独立入口，不与收藏或 AI 课堂混合。
- 文档编辑区是页面主场，AI 抽屉默认收起，移动端没有压缩三栏。
- 笔记、版本、附件、总结、会话和记忆均由独立后端模型持久化。
- 自动保存具备幂等、冲突和离线恢复机制，不发生静默覆盖。
- 附件只属于个人笔记，不自动进入课程知识库。
- AI 只读取用户选定范围，回答带来源，写回必须先预览再确认。
- 每日总结单独保存、保留版本、可重试且不覆盖原文。
- 只有用户确认的记忆可以使用，并支持暂停、替代、过期和删除。
- `NoteMemory` 不被 AI 课堂、画像、推荐、报告或面对面辅导读取。
- 大模型、解析任务或 Celery 暂时失败时，基础笔记仍可编辑、保存和恢复。
- 前后端、端到端、权限隔离和记忆专项测试全部通过。
