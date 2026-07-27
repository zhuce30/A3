# AGENTS.md

本文件是 A3“智学引擎”项目的后续开发协议。后续 Codex、superpowers 插件或其他 agent 接手时，必须先阅读本文件，再开始修改代码。

目标不是做静态 demo，而是把项目推进到接近成熟学习软件的水平：能诊断、能计划、能推荐、能辅导、能测评、能复习、能报告、能被教师管理，并且所有关键功能都有真实后端接口、真实数据回流和可复现测评。

## 1. 项目定位

项目名称：智学引擎 A3

核心目标：基于 OpenMAIC 多智能体互动课堂底座，完成符合 A3 赛题要求的个性化学习资源生成系统。

必须形成以下闭环：

```text
注册/登录
-> 手机绑定/隐私授权
-> 学习画像采集
-> 入学诊断
-> 个性化学习路径
-> 7/14/30 天学习计划
-> 今日任务
-> 本地知识库检索
-> 个性化资源推荐
-> AI 课堂/面对面辅导
-> 引用验证与安全过滤
-> 测评判分
-> 错题本与间隔复习
-> 画像更新
-> 学习报告/通知提醒
-> 教师工作台干预
```

产品标准参考成熟学习软件，例如“流利说英语”的诊断、计划、每日任务、即时反馈、复习提醒和阶段报告。不能退化成一次性问答、课件生成器或只有页面没有接口的 UI demo。

## 2. 工程结构

```text
<project-root>
|-- OpenMAIC/          # Next.js 前端，A3 页面与 Next API 代理
|-- backend/           # Django 后端，A3 业务 API、Agent、知识库、测评命令
|-- data/              # 课程资料、问答数据、知识库来源
|-- docs/              # 架构、答辩、页面分工和交接文档
|-- docker-compose.yml # MySQL/Redis/backend/celery/frontend 编排
|-- AGENTS.md          # 本文件
```

Git 管理约定：

- 本项目根目录 `D:\Download\A3` 已初始化为 Git 仓库，后续开发应默认使用 Git 管理变更。
- 远程仓库为 GitHub 私有仓库；提交前必须检查 `git status --short --branch`，不要混入无关本地文件。
- `.env`、本地运行时、依赖目录、知识库索引、上传资料和课程原始大文件不进入 Git；需要共享大数据时另走 Git LFS 或对象存储。
- `OpenMAIC` 和 `OpenMontage` 在本仓库中按普通目录管理；原嵌套 Git 元数据本地备份在 `.nested-git-backups/`，该目录不上传。

前端重点目录：

```text
OpenMAIC/app/a3/
OpenMAIC/app/api/a3/
OpenMAIC/components/a3/
OpenMAIC/lib/a3/
OpenMAIC/lib/server/
OpenMAIC/lib/export/
```

后端重点目录：

```text
backend/apps/accounts/
backend/apps/profiles/
backend/apps/learning/
backend/apps/assessments/
backend/apps/knowledge_base/
backend/apps/engagement/
backend/apps/compat/
backend/apps/system/
backend/domains/knowledge_base/
```

## 3. OpenMAIC 接入边界

A3 是主产品入口，OpenMAIC 是能力底座。用户学习闭环必须留在 A3 页面内完成。

当前 OpenMAIC 相关 artifact 类型：

```text
openmaic_classroom     # OpenMAIC 课堂 job 写回
openmaic_pptx_export   # OpenMAIC 课堂前端完成 PPTX 导出后写回
openmaic_video         # 短视频/动画脚本提交真实 provider 或降级写回
```

关键链路：

```text
/a3/recommendations
-> POST /api/a3/resources/openmaic-classroom
-> Django POST /api/resources/packs/<pack_id>/openmaic-classroom/
-> resourcePack.multimodalArtifacts 写入 openmaic_classroom
-> OpenMAIC classroomUrl 携带 a3PackId / a3ClassroomJobId / a3ClassroomId
-> OpenMAIC 课堂前端 useExportPPTX 导出
-> POST /api/a3/resources/openmaic-pptx-export
-> Django POST /api/resources/packs/<pack_id>/openmaic-pptx-export/
-> resourcePack、教师端、能力页展示 PPTX 导出证据
```

视频链路：

```text
micro_video_script
-> POST /api/a3/resources/openmaic-video
-> OpenMAIC POST /api/generate/video
-> Django POST /api/resources/packs/<pack_id>/openmaic-video/
-> 有 key 时写回 succeeded artifact；无 key 时写回 failed/degraded artifact
```

禁止事项：

- 不要让 Django 直接生成 PPTX。PPTX 导出必须由 OpenMAIC 课堂前端 hook 完成。
- 不要把本地绝对路径、API key、signed video URL 暴露到页面或文档。
- 不要把 OpenMAIC 原始页面当成 A3 产品闭环完成度。
- 不要新增前端 mock 来冒充 OpenMAIC job、artifact、视频或 PPTX 已成功。

## 4. 页面分工

| A3 页面 | 职责 | OpenMAIC 能力 | 关键接口 | 证据 |
|---|---|---|---|---|
| `/a3/recommendations` | 生成六类资源包，触发课堂、PPTX、视频任务 | 课堂生成、视频生成、artifact 写回 | `POST /api/resources/generate/`、`POST /api/a3/resources/openmaic-classroom`、`POST /api/a3/resources/openmaic-video` | `resourcePack.multimodalArtifacts`、课堂/视频卡片 |
| `/a3/resources/[packId]` | 展示资源包详情和 artifact 历史 | 课堂、PPTX、视频 artifact 审计 | `GET /api/resources/packs/<id>/` | `a3-resource-pack-artifact-history`、`a3-resource-pack-artifact-summary` |
| `/a3/classroom` | 学生打开来自资源包的 OpenMAIC 课堂 | classroomUrl、PPTX 导出提示 | `GET /api/resources/packs/`、`GET /api/learning/classroom/` | `a3-classroom-openmaic-entry`、`a3-classroom-openmaic-pptx-hint` |
| `/a3/teacher` | 教师查看资源效果并下发干预 | 班级维度 artifact 效果聚合 | `GET /api/learning/teacher/workbench/`、`POST /api/learning/teacher/tasks/execute/` | `a3-teacher-openmaic-artifacts`、`resourcePackSummary.artifactCounts` |
| `/a3/capabilities` | 展示答辩证据、trace、smoke、页面分工 | OpenMAIC 接入可验证性 | `GET /api/demo/status/`、`GET /api/a3/system/runtime`、`POST /api/a3/resources/openmaic-video-smoke-writeback` | `a3-openmaic-artifact-audit`、`a3-openmaic-smoke-report` |
| `/a3/knowledge-base` | 上传、索引、检索本地资料 | RAG 证据来源 | `GET /api/kb/resources/`、`POST /api/kb/resources/upload/`、`GET /api/kb/search/` | 搜索结果、课堂/资源引用 |

详细文档见：

```text
docs/A3_OpenMAIC页面分工与接入边界.md
docs/A3_6分钟答辩脚本.md
```

## 5. A3 赛题能力标准

判断“完成”必须以页面、接口、数据回流和验证命令为准。

| 能力 | 合格标准 | 不合格表现 |
|---|---|---|
| 学习画像 | 至少包含年级、专业方向、基础水平、每日时间、学习目标、薄弱点、偏好资源 | 只保存昵称或简单标签 |
| 入学诊断 | 题目能定位水平和薄弱知识点，并刷新路径与计划 | 诊断结果只展示不写回 |
| 学习路径 | 基于知识点、先修关系、画像和薄弱点生成 | 固定静态列表 |
| 学习计划 | 支持 7/14/30 天计划，含每日任务、时长、复习队列、进度反馈 | 只有今日推荐，没有周期计划 |
| 今日任务 | 用户打开产品后知道今天该学什么、还差多少、完成后去哪 | 首页只是数据看板 |
| 本地知识库 | 支持资源上传、索引、检索、引用来源展示 | 模型自由回答，无来源 |
| 个性化推荐 | 推荐必须带理由、来源、匹配分或排序依据，可收藏 | 通用资源列表 |
| AI 课堂/辅导 | 回答结合当前目标、路径节点和知识库来源 | 通用聊天机器人 |
| 防幻觉验证 | 输出 verified、citations、claims、safety，前端展示来源或未验证状态 | 编造引用或无证据仍标可信 |
| 内容安全 | 拦截隐私、作弊、危险、越权或明显不确定请求 | 对所有问题无差别回答 |
| 测评闭环 | 答题结果写入错题和画像薄弱点，触发推荐或计划调整 | 测完只显示分数 |
| 错题复习 | 错题有错因、解析、重练、掌握状态和复习节奏 | 错题只做列表展示 |
| 报告提醒 | 报告解释进步、薄弱点、计划完成度；通知能引导回任务 | 只有静态通知 |
| 教师工作台 | 教师可看学生进度、风险、薄弱点，并推送任务 | 只有学生端 |
| 演示验收 | 有 demo 数据、自动验证命令、指标输出、固定演示脚本 | 只能手工点页面 |

## 6. Agent 分工标准

每个关键工作流应能被追踪、解释和降级。

- `OrchestratorAgent`：串联任务，生成 traceId，记录 workflow、goal、status、latencyMs、steps。
- `ProfileAgent`：采集、抽取、更新学习画像；测评错题必须同步到 weakPoints。
- `DiagnosticAgent`：入学诊断和水平分层；结果包含 score、level、weakPoints、nextAction。
- `PlannerAgent / StudyPlanAgent`：生成学习路径和周期计划；计划包含 dailyMinutes、days、tasks、mastery、reviewQueue、coachTip。
- `RetrieverAgent`：检索本地知识库；优先 FAISS/向量库，兜底 BM25/关键词，必须返回 title、location、snippet、score。
- `RecommendAgent`：结合画像、目标、薄弱点、路径和知识库生成推荐；必须有 reason、score 或 ranking basis。
- `TeacherAgent / CoachAgent`：围绕当前目标和路径节点讲解，不能编造教材、页码或来源。
- `VerifierAgent`：返回 verified、citations、claims、safety；无证据不能标 verified。
- `SafetyAgent`：拦截作弊、隐私泄露、危险行为、越权请求和明显不确定内容。
- `AssessmentAgent`：判分、错题、报告；答题反馈包含 correctness、explanation、errorCause。
- `TeacherWorkbenchAgent`：教师端学情工作台；教师任务推送必须写入通知系统。

## 7. 后端接口标准

业务 API 尽量保持：

```json
{
  "success": true
}
```

失败返回：

```json
{
  "success": false,
  "error": "可读错误信息"
}
```

要求：

- 需要登录的接口必须校验 `request.user.is_authenticated`。
- 教师接口必须校验 `teacher` 或 `admin` 角色。
- 用户输入必须做长度和类型校验。
- 不能把 traceback 直接暴露给前端。
- 用户可见错误必须是正常中文。
- 不允许新增乱码字符串。

## 8. UI/UX 标准

前端必须以“学习软件产品”标准实现，不得只做静态页面。

每个功能页至少满足：

- 有明确主任务。
- 有空状态。
- 有错误状态。
- 有加载状态。
- 有成功反馈。
- 有下一步动作。
- 文案为正常中文，无乱码。
- 移动端不出现布局崩坏。
- 每个按钮必须对应真实 API、真实路由，或明确禁用原因。

重点页面：

```text
/a3/login
/a3/register
/a3/phone-binding
/a3/privacy
/a3/profile-setup
/a3/admission-diagnostic
/a3/today
/a3/study-plan
/a3/dashboard
/a3/learning-path
/a3/knowledge-graph
/a3/recommendations
/a3/classroom
/a3/coaching
/a3/assessment
/a3/wrong-notebook
/a3/report
/a3/favorites
/a3/notifications
/a3/teacher
/a3/knowledge-base
/a3/capabilities
/a3/demo-flow
```

## 9. 验证命令

每批开发必须至少跑基础验证，不要只凭页面截图判断完成。

前端：

```powershell
cd <project-root>\OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
```

当前允许存在的历史 warning：

```text
app/page.tsx: unused Sparkles, loadClassrooms dependency
components/roundtable/index.tsx: hook deps
components/scene-renderers/pbl-renderer.tsx: hook deps
lib/action/engine.ts: unused import
lib/generation/scene-generator.ts: unused imports
```

后端：

```powershell
cd <project-root>
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

OpenMAIC 接入专项：

```powershell
cd <project-root>\OpenMAIC
pnpm.cmd vitest run tests/a3-openmaic-classroom-bridge.test.ts tests/a3-openmaic-artifact-history.test.ts tests/a3-openmaic-page-ownership.test.ts tests/a3-openmaic-handoff-sync.test.ts tests/a3-openmaic-text-quality.test.ts
npx.cmd playwright test e2e/tests/a3-openmaic-bridge.spec.ts --project=chromium
```

文本语义索引（换机器 / 重装 / 清空 `backend\knowledge_base\faiss_index\` 后必须重跑）：

```powershell
cd <project-root>
backend\.venv\Scripts\python.exe backend\manage.py build_text_vector_index
```

`backend\knowledge_base\faiss_index\` 已被 `backend\.gitignore` 忽略，索引是生成物、不入库，新环境不会自带。

必须重跑的原因：默认文本嵌入模型 `BAAI/bge-small-zh-v1.5` 依赖本地 HuggingFace 缓存。当它不可用时，
在线检索会退化成 BM25 关键词命中。本命令使用已配置的 `A3_VISUAL_EMBED_*` provider 为全部文本、表格和
公式块建立独立语义索引；使用 DashScope 时需要有效 API key，不能把 key 写入仓库。

自检：

```powershell
backend\.venv\Scripts\python.exe backend\manage.py shell -c "from backend.domains.knowledge_base.text_vector_retriever import text_vector_index_available; print(text_vector_index_available())"
```

返回 `True` 才说明语义检索生效；此时检索结果的 `metadata.retriever` 应是 `text_vector` 而不是 `bm25`。

检索与安全评测：

```powershell
backend\.venv\Scripts\python.exe backend\manage.py evaluate_demo_retrieval --top-k 3
backend\.venv\Scripts\python.exe backend\manage.py evaluate_demo_retrieval --top-k 3 --json --output backend\tmp\demo_retrieval_metrics.json
```

视频 smoke：

```powershell
cd <project-root>\OpenMAIC
$env:A3_RUN_REAL_VIDEO_SMOKE="1"
$env:A3_VIDEO_SMOKE_PROVIDER="seedance"
$env:A3_VIDEO_SMOKE_BASE_URL="http://localhost:3002"
pnpm.cmd smoke:a3-video
```

没有 provider key 时，smoke 必须输出 skipped/failed 和明确原因，不能伪造成 succeeded。

## 10. 按钮级巡检标准

必须覆盖的端到端路径：

```text
注册 -> 绑定手机 -> 欢迎 -> 隐私授权 -> 画像采集 -> 入学诊断 -> 今日任务
今日任务 -> 完成任务 -> 学习路径进度变化 -> 报告变化
测评 -> 判分 -> 错题本 -> 画像薄弱点更新 -> 推荐刷新
推荐 -> 收藏 -> 我的收藏管理
推荐 -> 生成资源包 -> OpenMAIC 课堂 -> PPTX 导出 -> A3 artifact 写回
推荐 -> micro_video_script -> 视频生成/降级 -> A3 artifact 写回
课堂/辅导 -> 提问 -> 引用验证 -> 存为笔记 -> 收藏复习
教师登录 -> 工作台 -> 查看资源效果 -> 推送任务 -> 学生通知收到
知识库 -> 上传资源 -> 索引任务 -> 搜索 -> 课堂引用
```

## 11. 禁止事项

- 不要新增纯 mock 页面冒充已完成功能。
- 不要绕过已有后端接口，在前端写本地假数据完成闭环。
- 不要新增乱码文件。
- 不要删除用户已有改动。
- 不要破坏现有 A3 路由和接口契约。
- 不要把 OpenMAIC 原始功能误改坏。
- 不要新增无法验证的“大模型智能”描述，必须能通过页面、接口或测评命令证明。
- 不要把 API key、signed URL、本地绝对素材路径写进前端页面或文档。

## 12. 推荐后续开发顺序

第一批：产品级可用性

1. 按按钮级巡检标准逐页修复 CTA。
2. 补齐 loading、error、empty、success 状态。
3. 修复剩余 A3 页面乱码。
4. 统一演示账号、入口和答辩脚本。

第二批：学习软件体验

1. 今日任务页强化“下一步学什么”。
2. 学习计划增加调整理由、延期任务、复习节奏。
3. 报告页增加周总结、薄弱趋势、下周建议。
4. 通知页增加学习提醒和错题复盘提醒。

第三批：企业级 Agent

1. AgentRun 从 `extra_profile` 升级为独立表。
2. 每个 Agent 输出增加 schema version。
3. 增加超时、重试、降级、熔断策略。
4. 能力总览页展示 trace waterfall。

第四批：评测与答辩

1. 扩展评测集到至少 50 条。
2. 生成 `backend/tmp/demo_retrieval_metrics.json`。
3. 在 `/a3/capabilities` 展示指标。
4. 准备 6 分钟固定演示脚本和录屏。

第五批：部署交付

1. 在 Docker Desktop 环境实际跑通 `docker compose up --build`。
2. 补充 `.env.example` 和部署说明。
3. 确认首次启动自动 migrate 和 seed demo data。
4. 输出最终验收清单。

## 13. 交接格式

每个 agent 完成一批任务后，最终回复必须写清楚：

```text
已完成：
- 文件和功能点

验证：
- tsc / lint / backend check / validate_demo_flow / evaluate_demo_retrieval

未完成：
- 明确剩余风险，不要笼统说“还需优化”

下一步：
- 1-3 个可直接执行的任务
```

如果修改了核心接口，必须说明：

```text
接口路径：
请求字段：
响应字段：
前端调用位置：
回归验证方式：
```

## 14. 当前基线

当前项目已经具备以下能力：

```text
认证/注册/首启/画像设置
入学诊断
学习路径
学习计划
今日任务
知识库资源管理和检索
推荐与收藏
AI 课堂/面对面辅导
VerifierAgent 引用验证
SafetyAgent 安全过滤
测评判分
错题本
报告
通知
教师工作台
能力总览和 demo flow
Agent 执行轨迹
OpenMAIC 课堂 artifact 写回
OpenMAIC PPTX 导出 artifact 写回
OpenMAIC 视频 artifact 写回或降级
```

后续任何改动不得低于该基线。
