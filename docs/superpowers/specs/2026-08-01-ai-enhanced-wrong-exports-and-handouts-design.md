# AI 增强错题导出与复习讲义设计

## 1. 背景与目标

当前错题导出会同步生成 Word、Excel 或 PDF，内容来自真实错题快照；复习讲义已使用后台任务，结合薄弱点、本地知识库与可信题目解析生成 Word/PDF。现有实现能保证数据真实和文件可下载，但内容组织主要依赖固定模板，缺少模型对共性错因、前置知识缺口、解题策略和迁移练习的深度归纳。

本次改造将两条链路统一为可审计的后台生成工作流，并调用项目已配置的 OpenAI-compatible 大模型 API。模型只能新增分析，不得覆盖题干、选项、正确答案、学生原答案、原始错因或原始解析。所有引用必须来自本次本地知识库检索结果；API 不可用或输出不可信时仍须生成可下载的基础文件。

## 2. 已确认的产品决策

- 错题 Word、Excel、PDF 导出全部改为后台任务，不再同步返回二进制文件。
- 保留所有原始题目数据，AI 内容作为独立增强字段追加。
- 优先检索本地知识库并标注可验证引用，不允许模型编造教材、页码或资料来源。
- 检索不足时，仅允许基于可信题目解析生成，并明确标记“未引用本地资料”。
- 模型超时、限流、网络错误或结构错误时自动重试 2 次；仍失败则生成基础版文件并记录降级原因。
- 单个知识点失败不拖垮整个任务，其余知识点继续完成增强。
- 错题导出与复习讲义共用模型调用、结构校验、引用校验、重试和审计能力，但使用不同 Prompt 和输出 schema。

## 3. 范围与非目标

### 3.1 本期范围

- 新增独立的错题导出任务模型、迁移、Celery 任务和任务 API。
- 将现有错题导出前端改为创建任务、轮询状态、取消、重试和下载。
- 新增统一 `AssessmentContentEnhancer`，通过 `backend.apps.compat.llm.chat_completion` 调用现有模型配置。
- 为错题导出和讲义分别定义版本化 Prompt、JSON schema 和校验器。
- 扩展讲义生成内容：学情摘要、章节讲解、共性错因、分层变式练习、7 天复习安排和引用。
- 扩展错题导出内容：AI 错因诊断、前置知识缺口、解题步骤、易混点、迁移练习、复习建议和引用。
- 在任务中记录模型、Prompt 版本、耗时、重试次数、校验结果、引用和降级状态，不记录 API Key 或完整敏感请求。

### 3.2 非目标

- 不让模型重新判定正确答案，不修改题库和错题记录。
- 不新增新的模型供应商 SDK；继续使用现有 OpenAI-compatible HTTP 客户端。
- 不把生成文件放入 Git，不暴露服务器绝对路径。
- 不让 Django 生成 OpenMAIC PPTX，本功能与 OpenMAIC artifact 链路无关。
- 不在本期提供用户自定义 Prompt 或自由输入模型参数。

## 4. 总体架构

```text
错题本操作区
  -> 创建 ExportJob 或 ReviewHandoutJob
  -> 固化用户、错题、画像、薄弱点和格式快照
  -> Celery resource-generation 队列
  -> 按知识点检索本地知识库
  -> AssessmentContentEnhancer
       -> 版本化 Prompt
       -> chat_completion
       -> JSON 解析与 schema 校验
       -> 原答案一致性校验
       -> 引用编号白名单校验
       -> 最多 2 次重试
  -> 聚合成功章节与降级章节
  -> DOCX/XLSX/PDF 渲染器
  -> 用户隔离下载
```

职责边界：

- 快照层只读取真实业务数据，不调用模型。
- 检索层只返回允许引用的证据集合，并给每条证据分配稳定 `sourceId`。
- 增强层只返回结构化内容，不写文件、不更新题库。
- 校验层拒绝答案冲突、未知引用、超长字段和不完整结构。
- 渲染层只消费已验证的增强结果或确定性降级内容。
- 任务层负责状态、进度、取消、重试、迟到 worker 保护和审计。

## 5. 数据模型

### 5.1 WrongQuestionExportJob

新增 `WrongQuestionExportJob`，不复用讲义任务表，避免格式、生命周期和历史列表语义混杂。

关键字段：

| 字段 | 用途 |
| --- | --- |
| `id`, `user`, `scope`, `format` | 任务身份、所有者、导出范围和格式 |
| `snapshot_hash`, `snapshot` | 创建时固化的真实错题数据与幂等摘要 |
| `status`, `progress`, `stage`, `message` | 前端轮询状态 |
| `trace_id`, `celery_task_id` | 工作流追踪和取消 |
| `enhancement` | 通过校验的 AI 增强结构，不含 API Key |
| `citations` | 本次实际使用的白名单引用 |
| `llm_audit` | Prompt 版本、模型、耗时、重试、错误类别与 token usage |
| `verified`, `degraded`, `degraded_reasons` | 可信与降级状态 |
| `artifact_path`, `content_type`, `filename` | 安全下载所需信息 |
| `error_message`, `started_at`, `finished_at`, `created_at`, `updated_at` | 错误和时间审计 |

索引至少覆盖 `(user, -created_at)` 和 `(user, snapshot_hash, format, status)`。相同用户、范围、格式和快照下，进行中的任务幂等复用；已完成任务保留历史，不强制复用，以允许模型或 Prompt 升级后重新生成。

### 5.2 ReviewHandoutJob 扩展

保留现有任务表，新增或规范以下 JSON 字段：

- `enhancement`
- `llm_audit`
- `degraded_reasons`
- `prompt_version`

现有 `snapshot`、`ranked_weak_points`、`citations`、`verified` 和文件路径继续使用。旧记录字段为空时序列化器必须兼容。

### 5.3 状态机

```text
queued
-> retrieval
-> enhancing
-> validating
-> rendering
-> succeeded

任意执行阶段 -> cancelled
不可恢复错误 -> failed
模型或局部章节失败 -> 继续 rendering，最终 succeeded + degraded=true
```

取消是终态。迟到 worker 不得覆盖 `cancelled`，也不得遗留可下载文件。失败任务重试会创建新任务并复用原快照，保留旧任务审计。

## 6. 统一模型增强层

新增独立模块，例如：

```text
backend/apps/assessments/content_enhancer.py
backend/apps/assessments/prompts/wrong_export_v1.py
backend/apps/assessments/prompts/review_handout_v1.py
backend/apps/assessments/content_schemas.py
```

核心接口：

```python
enhance_wrong_export(snapshot, evidence_by_point, *, cancel_check) -> EnhancementResult
enhance_review_handout(snapshot, ranked_weak_points, evidence_by_point, *, cancel_check) -> EnhancementResult
```

`EnhancementResult` 至少包含：

```json
{
  "content": {},
  "citations": [],
  "verified": true,
  "degraded": false,
  "degradedReasons": [],
  "audit": {
    "promptVersion": "wrong-export-v1",
    "provider": "dashscope",
    "model": "configured-model",
    "attempts": 1,
    "latencyMs": 1200,
    "finishReason": "stop",
    "usage": {}
  }
}
```

模型配置优先级沿用 `chat_completion`：`A3_LLM_API_KEY`、`A3_COACHING_API_KEY`、`DASHSCOPE_API_KEY`、`QWEN_API_KEY`、`OPENAI_API_KEY`。新增功能级配置只控制开关、超时、token 和批量大小，例如：

- `A3_ASSESSMENT_EXPORT_LLM_ENABLED=auto`
- `A3_ASSESSMENT_EXPORT_LLM_TIMEOUT_SECONDS=60`
- `A3_ASSESSMENT_EXPORT_LLM_MAX_TOKENS=3000`
- `A3_ASSESSMENT_EXPORT_LLM_MAX_ATTEMPTS=3`
- `A3_ASSESSMENT_EXPORT_LLM_POINTS_PER_CALL=1`

默认 `auto`：有可用 API Key 时调用模型，无 Key 时直接走显式降级，不把基础文件伪装为 AI 增强成功。

## 7. Prompt 设计

### 7.1 公共 System Prompt 约束

两个 Prompt 必须包含以下不可协商规则：

1. 你是“智学引擎 A3”的学习诊断内容生成 Agent，只能使用输入中的错题事实和证据。
2. 不得修改或质疑 `correctAnswer`；不得重写题干、选项、学生原答案和原始解析。
3. 不得编造教材名称、页码、实验结果、统计数据或引用。
4. 引用只能使用提供的 `sourceId`；没有适用证据时返回空引用并标注 `evidenceStatus=unverified`。
5. 输出必须是单个 JSON 对象，不得包含 Markdown 围栏、解释性前言或额外字段。
6. 内容面向学生，使用正常中文，给出可执行步骤，避免空泛鼓励和重复题干。
7. 迁移练习必须与原知识点一致但不得复制原题；答案与解析必须内部一致。
8. 如输入不足，明确写“不足以判断”，不得补造事实。

### 7.2 错题导出 Prompt

每次按一个知识点处理一组有限数量错题，输入包含：

- 学段、专业方向、基础水平、学习目标、偏好和薄弱点的最小必要画像字段。
- 知识点摘要和复习紧迫度。
- 该知识点下每道题的稳定 `questionId`、题干、选项、正确答案、学生答案、原始错因和解析。
- 允许引用的 `sourceId/title/location/snippet`。

输出 schema：

```json
{
  "knowledgePoint": "进程调度",
  "groupDiagnosis": "该组错题反映的共性问题",
  "prerequisiteGaps": ["缺失的前置知识"],
  "confusions": [
    {"conceptA": "...", "conceptB": "...", "difference": "..."}
  ],
  "questionAnalyses": [
    {
      "questionId": "原始 ID",
      "deepErrorDiagnosis": "为什么会错",
      "solutionSteps": ["步骤 1", "步骤 2"],
      "selfCheck": "如何检查答案",
      "reviewAdvice": "个性化复习动作",
      "citationIds": ["S1"]
    }
  ],
  "transferPractice": [
    {
      "prompt": "新情境练习",
      "answer": "答案",
      "explanation": "解析",
      "difficulty": "基础|进阶",
      "citationIds": ["S1"]
    }
  ],
  "evidenceStatus": "verified|partial|unverified"
}
```

### 7.3 复习讲义 Prompt

每个薄弱知识点独立生成章节，最后使用确定性代码汇总 7 天计划，避免一个超长 Prompt 被截断。输入除上述内容外，还包含弱点分数、到期数量、错误次数和相邻章节信息。

输出 schema：

```json
{
  "knowledgePoint": "死锁",
  "learningDiagnosis": "本章学情诊断",
  "coreConcept": "证据约束下的核心概念讲解",
  "prerequisites": ["先修知识"],
  "commonErrorPatterns": ["共性错因"],
  "method": ["识别", "推理", "检查"],
  "workedExample": {
    "prompt": "例题",
    "steps": ["步骤"],
    "answer": "答案"
  },
  "tieredPractice": [
    {
      "level": "基础|巩固|迁移",
      "prompt": "练习",
      "answer": "答案",
      "explanation": "解析"
    }
  ],
  "reviewActions": ["可执行复习动作"],
  "citationIds": ["S1"],
  "evidenceStatus": "verified|partial|unverified"
}
```

7 天计划由算法按弱点分数、到期状态和章节数量分配，不让模型决定真实任务状态。模型只可提供章节内的学习建议。

## 8. 校验、重试与降级

### 8.1 结构校验

- 从响应中解析唯一 JSON 对象，拒绝多个对象或非 JSON 文本。
- 使用显式 Python schema 校验类型、必填字段、枚举、列表数量和字段长度。
- 拒绝模型返回未请求的题目 ID。
- 要求每个输入题目最多对应一条分析；缺失条目可局部降级，重复条目拒绝本次响应。

### 8.2 事实一致性校验

- 模型输出不得包含替代 `correctAnswer` 的字段。
- 迁移练习的答案只要求与其自身解析一致，不回写题库。
- 如果文本明确声称原题正确答案与快照不一致，本次响应视为冲突并重试。
- 原始错因和解析始终单独渲染，不被 AI 内容覆盖。

### 8.3 引用校验

- 每次调用前为证据分配 `S1...Sn`，模型只能返回这些编号。
- 未知编号、虚构位置或引用空片段会导致响应拒绝。
- `verified=true` 仅在所有关键章节至少有一个有效引用且无降级时成立。
- 只使用题目解析时，章节 `evidenceStatus=unverified`，文件明确写“本节未引用本地课程资料”。

### 8.4 重试策略

最多 3 次尝试，即首次调用加 2 次重试：

- 网络错误、HTTP 429、HTTP 5xx、超时：递增等待后重试。
- JSON/schema/引用/答案冲突：将简短校验错误反馈给模型后重试，不携带敏感信息。
- HTTP 401/403：不重复消耗请求，直接降级并记录配置错误类别。
- 取消检查发生在检索前、每次模型调用前后及文件写入前。

等待时长建议为 1 秒、3 秒，并允许测试注入零等待。单章节失败时使用可信题目解析生成该章节；全部失败时生成基础导出或基础讲义。

## 9. 文件输出

### 9.1 Word 错题导出

- 封面：学生、范围、生成时间、AI/引用/降级状态。
- 总览：错题数量、重点知识点、复习优先级。
- 按知识点分组的原始错题区：原题、学生答案、正确答案、原始错因、原始解析、来源。
- 独立 AI 分析区：共性诊断、前置缺口、逐题诊断、解题步骤、易混点和复习建议。
- 迁移练习区；答案与解析统一放在文末。
- 引用清单：标题、位置、片段和引用编号。

### 9.2 Excel 错题导出

至少包含三个工作表：

- `错题明细`：保持现有真实字段和类型化日期。
- `AI分析`：按题目 ID 关联知识点、深层错因、步骤、自检、建议、证据状态。
- `迁移练习与引用`：新练习、答案、解析及引用来源。

即使完全降级，工作表结构保持稳定；AI 字段写明降级状态而不是伪造内容。

### 9.3 PDF 错题导出

内容与 Word 对齐，但采用打印友好的紧凑排版。题目、对应原始解析和逐题 AI 分析尽量保持同页；超长章节允许自然分页，不允许文本截断。

### 9.4 复习讲义 Word/PDF

- 学情摘要与薄弱点排序。
- 每章核心概念、先修知识、共性错因、解题方法和例题。
- 基础、巩固、迁移三级练习。
- 基于真实到期状态和弱点分数生成的 7 天复习安排。
- 文末答案与解析。
- 逐章引用及整体引用清单。
- 明显的 verified/partial/unverified 说明。

## 10. API 契约

### 10.1 错题导出任务

```text
POST /api/assessments/wrong-questions/exports/
GET  /api/assessments/wrong-questions/exports/
GET  /api/assessments/wrong-questions/exports/<job_id>/
POST /api/assessments/wrong-questions/exports/<job_id>/cancel/
POST /api/assessments/wrong-questions/exports/<job_id>/retry/
GET  /api/assessments/wrong-questions/exports/<job_id>/download/
```

创建请求：

```json
{
  "scope": "active|due|mastered|all",
  "format": "docx|xlsx|pdf"
}
```

创建响应为 `202`：

```json
{
  "success": true,
  "reused": false,
  "job": {
    "jobId": "uuid",
    "scope": "active",
    "format": "docx",
    "status": "queued",
    "progress": 0,
    "stage": "queued",
    "message": "错题导出已进入生成队列",
    "verified": false,
    "degraded": false,
    "createdAt": "ISO-8601"
  }
}
```

任务成功后增加 `downloadUrl`。路径、API Key、完整模型请求和 traceback 永远不返回前端。

旧 `POST /api/assessments/wrong-questions/export/` 在一个发布周期内保留，但改为创建后台任务并返回 `202` JSON，不再返回文件。前端同步更新，不依赖旧二进制行为；专项测试明确锁定新契约。

### 10.2 讲义 API

现有路径保持不变，响应新增可选字段：

- `promptVersion`
- `model`
- `attempts`
- `degradedReasons`
- `evidenceSummary`

这些字段只用于用户理解和审计，不暴露内部 Prompt 全文或密钥。

## 11. 前端交互

错题导出按钮改为“创建导出任务”。提交后：

- 显示任务已排队的成功反馈。
- 与讲义任务统一每 2 秒轮询，有活动任务时轮询，无活动任务时停止。
- 展示格式、范围、进度、当前阶段、AI/引用状态和创建时间。
- 运行中可取消；失败或取消后可重试；成功后可下载。
- 导出历史和讲义历史分区显示，避免混淆文件类型。
- 模型降级时仍允许下载，并明确显示“基础版”或“部分 AI 增强”。
- 空、加载、错误、成功状态和移动端布局均保持完整。

## 12. 安全与隐私

- 所有任务和下载接口校验登录用户与任务所有者。
- Prompt 仅包含生成所需的最小画像字段，不包含手机号、会话、密码或其他学生数据。
- 日志只记录 traceId、任务 ID、模型、耗时、attempt、错误类别和 token usage。
- 模型响应作为不可信输入处理，渲染前进行长度限制和 XML/HTML 转义。
- 文件路径必须位于配置的 artifact root 内，并校验扩展名。
- 引用响应不包含服务器 `source_path`，只返回安全标题、公开位置和片段。

## 13. 测试策略

### 13.1 单元测试

- Prompt 包含禁止改答案、禁止虚构引用、只输出 JSON 等关键约束。
- 错题与讲义 schema 的有效、缺字段、超长、错误枚举和额外题目 ID。
- 引用编号白名单、答案冲突检测和响应 JSON 提取。
- 429/5xx/超时重试 2 次、401/403 不重试。
- 单章节降级、全部降级、取消和迟到 worker 保护。
- 任务幂等、重试新建任务和用户隔离。

### 13.2 集成测试

- Mock `chat_completion` 返回真实结构，验证 DOCX/XLSX/PDF 可解析且同时包含原始内容和 AI 内容。
- 验证 Excel 三个工作表、表头、日期类型、冻结行和筛选。
- 验证讲义包含章节、三级练习、7 天计划、答案解析和引用。
- 验证 API 创建、列表、详情、取消、重试和安全下载。
- 验证完全降级时仍生成文件且任务 `succeeded + degraded=true`。

### 13.3 回归与生产验收

基础命令：

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test apps.assessments.tests.test_wrong_exports apps.assessments.tests.test_review_handouts
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py makemigrations --check --dry-run
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
```

生产 smoke 必须使用真实模型配置和演示用户，分别生成：

- Word、Excel、PDF AI 增强错题导出。
- Word、PDF AI 增强复习讲义。

验收检查：任务完成、下载权限、文件可打开、原答案未被修改、AI 分析存在、引用编号可追溯、无编造页码、降级状态准确、resource worker 无未处理异常。真实 smoke 不输出 API Key、Prompt 中的个人数据或服务器绝对路径。

## 14. 部署与回滚

- 新迁移随 backend 镜像部署，由 `A3_RUN_MIGRATIONS=1` 的 backend 启动执行。
- `resource-worker` 必须继续监听 `resource-generation` 并注册错题导出与讲义两个任务。
- 先部署后端和 worker，确认迁移及任务注册，再部署前端。
- 新前端上线前，旧同步导出路径的兼容端点必须已返回新任务契约。
- 回滚应用镜像时不能回滚已生成的任务数据；旧代码必须能忽略新增 JSON 字段。若回滚到完全不认识新任务表的版本，表保留但不被访问。

## 15. 完成标准

只有同时满足以下条件才视为完成：

- 错题三种格式均通过后台任务生成并可取消、重试、下载。
- 讲义真实调用已配置模型 API，而不是仅显示 AI 文案。
- 原始题目事实完整保留，模型无法覆盖正确答案。
- 本地资料引用可核验，未知引用会被拒绝。
- API 失败最多重试 2 次，最终仍能生成明确标记的基础文件。
- 文件内容和版式经结构解析与视觉检查。
- 前后端、任务、迁移、权限和生产 smoke 全部通过。

