# A3 独立管理员控制台与首页角色入口设计

## 1. 文档状态

- 状态：已确认设计
- 日期：2026-07-25
- 产品：智学引擎 A3
- 范围：首页角色入口、独立管理员控制台、管理员专属接口与受控管理操作
- 取代关系：本文在管理员信息架构、页面范围和视觉方向上取代 `2026-07-23-a3-admin-operations-console-design.md`；旧文档中的可信 IP、在线状态、隐私和真实探针原则继续有效。

## 2. 背景与问题

A3 已有学生学习闭环、教师工作台和两个管理员页面：

```text
/a3/admin/overview
/a3/admin/users
```

当前管理员能力存在三类问题：

1. 管理入口混在学生学习侧栏中，管理员工作区与学习工作区边界不清。
2. 管理功能只覆盖运行总览和用户管理，对话、课程知识库、任务、Agent、安全、配置和审计缺少管理员页面。
3. 现有页面以普通文档式分区呈现，缺少成熟运营后台需要的固定工具区、紧凑表格、指标层级、趋势、状态分布和操作闭环。

公开首页 `/a3/` 只有通用登录和进入学习空间入口，学生、教师、管理员无法直接识别各自工作区。

## 3. 已确认决策

### 3.1 视觉方向

采用“智学引擎专业版”：

- 以参考后台的高信息密度和清晰层级为结构基础。
- 使用暖白背景、墨绿主色、低饱和金黄提醒和低饱和红色风险色。
- 不照搬冷灰、亮蓝或纯黑模板，不形成与 A3 品牌割裂的另一套产品。
- 数据页面保持紧凑，圆角不超过 8px，不嵌套装饰性卡片。
- 数字使用等宽或 tabular figures；状态同时使用文字和颜色，不只依赖颜色。

### 3.2 管理员导航

管理员使用独立控制台布局，不再使用学生学习侧栏。

```text
智学引擎 · 管理后台
├── 运行总览
├── 用户管理
├── 对话记录
├── 课程与知识库
├── 资源任务
├── Agent 运行
├── 内容安全
├── 系统配置
└── 审计日志
```

控制台侧栏顶部提供“返回学习端”，但管理员页面不会同时展示学生功能菜单。

### 3.3 管理权限

采用受控管理：

- 允许启用或停用用户。
- 允许发布、下线课程与资料。
- 允许重试失败任务和取消符合条件的排队或运行任务。
- 允许审核安全事件、标记误报和填写审核备注。
- 允许验证系统配置和 Provider 连通性。
- 不提供用户、课程、资料和历史任务的物理删除。
- 所有敏感读取和写操作必须记录管理员审计日志。

### 3.4 首页角色入口

首页顶部导航直接展示三个精简入口：

```text
[学生] [教师] [管理员]
```

入口只包含图标和角色名称，不新增角色说明卡、说明段落或底部权限提示。

路由：

```text
学生   -> /a3/login?workspace=student
教师   -> /a3/login?workspace=teacher
管理员 -> /a3/login?workspace=admin
```

`workspace` 只表示登录意图。登录成功后必须依据后端返回的真实角色决定落点：

```text
student -> /a3/today
teacher -> /a3/teacher
admin   -> /a3/admin/overview
```

学生或教师不能通过修改 URL 获得管理员权限。

## 4. 目标与非目标

### 4.1 目标

1. 形成完整、独立、可操作的管理员工作区。
2. 所有图表、列表和日志来自真实数据库、探针或结构化事件。
3. 受控管理操作具备状态校验、二次确认、可读错误和审计证据。
4. 管理后台查询和自动刷新不能显著拖慢学生端接口。
5. 首页三角色入口清晰、精简，并保持后端权限边界。
6. 管理页面具备加载、空、错误、部分降级和成功反馈。

### 4.2 非目标

- 不替代 Django Admin 的开发调试能力。
- 不建设完整 Prometheus、Grafana、APM 或容器日志平台。
- 不展示密码、验证码、Cookie、Session、API Key、SMTP 授权码或签名 URL。
- 不允许管理员查看未审计的完整对话和完整 IP。
- 不使用前端 mock 或随机数生成趋势、告警和操作日志。
- 不修改学生 Agent、教师工作台和 OpenMAIC artifact 的既有业务契约。

## 5. 前端架构

### 5.1 路由与布局

当前 `OpenMAIC/app/a3/layout.tsx` 会无条件渲染 `A3Shell`。因此不能只在 `app/a3/admin` 下再套一层 layout，否则管理员页面仍会保留学生侧栏。

新增顶层工作区分流组件：

```text
OpenMAIC/components/a3/layout/a3-workspace-frame.tsx
OpenMAIC/components/a3/features/admin/admin-console-layout.tsx
OpenMAIC/components/a3/features/admin/admin-sidebar.tsx
OpenMAIC/components/a3/features/admin/admin-page-header.tsx
```

`app/a3/layout.tsx` 继续统一提供 `A3AuthGate`，内部由 `A3WorkspaceFrame` 根据 pathname 分流：

```text
/a3/admin/* -> AdminConsoleLayout
其他 /a3/* -> A3Shell + A3GuidedTourProvider
```

管理员页面继续复用 A3 登录 Session、API Client、颜色变量和基础按钮，但不渲染 `A3Shell` 的学习导航。该分流只负责布局，页面和 Django 接口仍分别校验管理员角色。

### 5.2 页面路由

```text
/a3/admin/overview
/a3/admin/users
/a3/admin/conversations
/a3/admin/catalog
/a3/admin/tasks
/a3/admin/agents
/a3/admin/safety
/a3/admin/settings
/a3/admin/audit
```

### 5.3 通用页面结构

```text
固定页面标题区
-> 页面名称、更新时间、自动刷新、手动刷新、主操作
筛选工具区
-> 搜索、状态、类型、时间范围、总数
主数据区
-> 指标、图表、表格或分栏详情
详情抽屉
-> 结构化详情、敏感信息确认、受控操作
```

自动刷新保留筛选、分页、滚动和已打开详情，不整页闪烁。页面不可见时暂停轮询，恢复可见时刷新一次。

## 6. 运行总览

### 6.1 服务健康

展示 A3 真实架构：

```text
Next.js Frontend
Django Backend
MySQL
Redis
Celery Worker
Celery Beat
Realtime Proxy
Knowledge Base
Model Providers
```

状态定义：

```text
healthy     真实探针或近期心跳成功
configured  已配置但未采集运行心跳
degraded    可用但存在积压、过期心跳或部分失败
down        关键探针失败
unknown     无足够证据
```

“已配置”不得显示为“在线”。Celery 和 Celery Beat 在未接入心跳前显示“已配置 · 未监控”。

### 6.2 核心指标和 7 日趋势

指标：

- 用户总数和周期新增。
- 活跃用户。
- 辅导会话。
- 成功资源包。
- Agent 运行数与失败率。
- 安全事件。

趋势线：活跃用户、辅导会话、成功资源包、Agent 运行。后端按 `Asia/Shanghai` 自然日聚合连续 7 天，缺失日期补零。

### 6.3 任务分布、告警和操作动态

任务状态聚合资源生成、视频生成、知识库索引和 AgentRun，统一为：

```text
queued / running / succeeded / failed / stale / cancelled
```

任务环图旁必须展示文字和数值列表。

近期告警来自真实服务状态、失败或陈旧任务、Agent 失败、安全事件和资源索引错误。

操作动态来自结构化业务记录和 `AdminAuditLog`，不直接把容器 stdout 输出到页面。

## 7. 用户管理

列表字段：

```text
用户 | 角色 | 账号状态 | 在线状态 | 注册 IP | 最近 IP |
学习方向 | 会话/资源 | 最近活跃 | 注册时间 | 操作
```

要求：

- 支持姓名、账号、学号和 IP 搜索。
- 支持角色、账号状态、在线状态和时间筛选。
- 默认分页 20，允许 20/50，不允许一次返回全部。
- IP 默认脱敏；查看完整 IP 必须二次确认并写审计日志。
- 详情抽屉展示账号、画像、学习使用、访问摘要和近期事件。
- 只提供启用或停用，不提供删除。
- 禁止停用当前管理员和最后一个有效管理员。

## 8. 对话记录

首批管理范围为 Django 已持久化的 `CoachingSession` 和 `CoachingMessage`。

列表默认展示：

- 用户和会话状态。
- 创建、最近活动和结束时间。
- 消息数、验证消息数、降级消息数和安全拦截数。
- 关联目标、课程或 traceId（存在时）。

正文默认隐藏。管理员点击“查看正文”后：

1. 前端展示敏感信息提示。
2. Django 再次验证管理员角色。
3. 写入 `conversation.reveal` 审计记录。
4. 只返回该会话分页消息，不返回 Cookie、内部文件路径和密钥字段。

## 9. 课程与知识库

页面分为“课程”和“知识资料”两个标签页。

课程：

- 展示课程、章节数、知识点数、教师数、学生数和启用状态。
- 支持启用和下线，复用 `Course.is_active`。

知识资料：

- 展示资料名、范围、课程、所有者、状态、分块数、索引任务和错误摘要。
- 支持发布/下线（通过白名单 `visibility` 和状态转换）。
- 支持对失败或已完成资料重新建立索引。
- 不展示服务器绝对路径，不提供物理删除。

## 10. 资源任务

统一展示：

- `ResourceGenerationJob`
- `VideoGenerationJob`
- `VideoComposition`
- `KnowledgeIndexJob`

列表包含任务类型、用户、状态、阶段、进度、更新时间、耗时、错误摘要和关联 traceId。

操作规则：

- 失败任务允许重试。
- 排队任务允许取消。
- 运行任务只有保存了 `celery_task_id` 且工作流支持安全停止时才允许取消。
- 已完成和已取消任务不可重复取消。
- 所有操作由后端状态机校验，前端禁用不是安全边界。

`ResourceGenerationJob` 当前没有 `celery_task_id`。在未补齐持久任务 ID 前，该类型只支持失败重试，不提供运行中取消。

## 11. Agent 运行

列表来自 `AgentRun`，详情来自 `AgentStep` 和 `AgentSpan`：

- traceId、用户、workflow、goal 摘要、状态、耗时和降级策略。
- 步骤顺序、角色、状态和耗时。
- Span 类型、模型/检索调用、状态和耗时。
- metadata 仅返回白名单字段，密钥、正文和本地路径必须过滤。

Agent 页面只负责观察和定位问题，不允许从管理员页面修改 Agent prompt 或业务接口。

## 12. 内容安全

扩展 `SecurityEvent`：

```text
review_status: pending / confirmed / false_positive / resolved
reviewer
reviewed_at
review_note
```

页面支持类别、等级、来源、处理状态和时间筛选。管理员可确认、标记误报、解决并填写备注；每次处理同时写入 `AdminAuditLog`。

## 13. 系统配置

系统配置页面只展示：

- 配置项名称。
- 已配置/未配置/未监控/异常。
- 最近验证时间。
- 可读错误和建议动作。
- “验证连接”操作。

配置项包括数据库、Redis、Celery、Celery Beat、SMTP、短信、模型 Provider、对象/本地存储、实时代理和知识库索引。

接口不得返回密钥值、授权码、完整 DSN 或含凭据 URL。连接验证设置短超时，模型 Provider 验证不得由自动刷新触发付费调用。

## 14. 审计日志

扩展 `AdminAuditLog` 以支持非用户目标：

```text
target_type
target_id
summary
metadata
```

保留现有 `target_user` 兼容字段。日志记录：

- actor、actor IP、action、reason。
- target type/id。
- 白名单 before/after。
- success、错误码和时间。

密码 hash、验证码、Cookie、Session、API Key、授权码、完整对话正文和原始文件内容禁止进入审计字段。

## 15. 后端接口

所有接口位于 `/api/admin/*` 并调用 `require_admin_role`：

```text
GET  /api/admin/overview/?range=7d

GET  /api/admin/users/
GET  /api/admin/users/<id>/
POST /api/admin/users/<id>/status/
POST /api/admin/users/<id>/reveal-ip/

GET  /api/admin/conversations/
GET  /api/admin/conversations/<id>/
POST /api/admin/conversations/<id>/reveal/

GET  /api/admin/catalog/courses/
POST /api/admin/catalog/courses/<id>/status/
GET  /api/admin/catalog/resources/
POST /api/admin/catalog/resources/<id>/status/
POST /api/admin/catalog/resources/<id>/reindex/

GET  /api/admin/tasks/
POST /api/admin/tasks/<kind>/<id>/retry/
POST /api/admin/tasks/<kind>/<id>/cancel/

GET  /api/admin/agent-runs/
GET  /api/admin/agent-runs/<id>/

GET  /api/admin/security-events/
POST /api/admin/security-events/<id>/review/

GET  /api/admin/configuration/
POST /api/admin/configuration/<check>/verify/

GET  /api/admin/audit-logs/
```

成功响应保持 `{ "success": true }`，失败返回 `{ "success": false, "error": "正常中文" }`。列表统一分页或 cursor，不返回无界数据。

## 16. 数据与性能

### 16.1 数据迁移

- `SecurityEvent` 增加审核字段和审核状态索引。
- `AdminAuditLog` 增加通用目标、摘要和 metadata 字段。
- 任务取消只复用已存在的 `celery_task_id`；不为不支持安全取消的任务伪造取消能力。

### 16.2 查询规则

- 用户、会话和资源列表使用 `select_related`、`prefetch_related`、注解或批量水合，禁止 N+1。
- 7 日趋势由 Django ORM/数据库聚合，前端不下载原始事件重新统计。
- overview 缓存 30 秒，缓存键包含时间范围。
- 自动刷新请求不允许重叠；前一次未完成时跳过下一次。
- 单个非关键探针失败不能阻塞整个 overview，响应标记 `partial`。
- 所有管理列表默认分页 20，并对筛选字段建立或复用索引。

## 17. 权限与隐私

```text
未登录          -> 401
student/teacher -> 403
admin           -> 允许
```

- 前端隐藏菜单不是权限控制，Django 必须逐接口校验。
- IP 使用可信代理链解析，不能信任客户端自行提交的转发头。
- 完整 IP、对话正文等敏感读取必须单独审计。
- GeoIP 只提供粗粒度地区，缺失时显示“地区未知”，不能编造城市。
- 管理端不展示用户密码、验证码、Cookie、密钥、签名 URL、本地绝对路径和模型内部敏感 metadata。

## 18. 状态与错误体验

每页必须具备：

- 与最终布局一致的加载骨架。
- 无数据时的明确空状态和下一步。
- 筛选无结果状态。
- 接口失败的行内错误和重试。
- 部分探针失败的局部降级状态。
- 写操作的进行中、成功和失败反馈。
- 高风险操作二次确认和必填原因。

不使用 `window.alert()` 完成最终交互；写操作采用项目现有确认对话框或新增统一管理确认组件。

## 19. 测试与验收

### 19.1 后端

- 学生、教师调用每个管理员接口均返回 403。
- overview 指标、趋势、任务分布可追溯到真实表。
- 列表筛选、分页和排序组合正确且无 N+1 回归。
- 对话正文和完整 IP 未确认时不可返回；确认后产生审计日志。
- 用户启停、课程上下线、资料状态、任务重试/取消和安全审核遵守状态机。
- 最后一个有效管理员不能被停用。
- 配置接口不返回任何密钥明文。

### 19.2 前端

- 首页三个角色入口在桌面和移动端均可见且文字不溢出。
- 登录意图不改变账号真实角色，成功后落点正确。
- 管理员独立侧栏具有正确当前页状态和移动端收起能力。
- 图表在零数据、部分数据和错误数据下仍可理解。
- 所有表格支持横向滚动或移动端分组，不遮挡操作。
- 自动刷新不重置筛选、分页和详情抽屉。
- loading、empty、error、success 和 permission denied 状态可回归。

### 19.3 基线验证

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/admin

cd ..
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

## 20. 分批实施与发布

### 批次一：入口、骨架和核心后台

- 首页顶部三角色入口。
- 独立管理员布局和全部菜单路由骨架。
- 运行总览、用户管理和审计日志。
- 7 日真实趋势、任务分布、告警和操作动态。

### 批次二：业务运行管理

- 对话记录。
- 课程与知识库。
- 资源任务。
- Agent 运行。

### 批次三：治理与配置

- 内容安全审核。
- 系统配置与连通性验证。
- 全量权限、隐私、性能和移动端回归。

每个批次使用固定 Git SHA 构建前后端镜像。涉及 migration 的批次先执行迁移，再按需重建 backend、celery、celery-beat、frontend 和 caddy。上线后验证管理员接口、学生学习接口和教师工作台，不允许只检查容器状态。

## 21. 回滚

- 首页角色入口可独立回滚，不影响现有 `/a3/login`。
- 独立管理员布局可回滚到旧两个页面，不影响学生和教师路由。
- 新增审核和审计字段为兼容性迁移，不删除现有列。
- 管理写操作可通过后端开关退化为只读，保留监控页面。
- 某个探针失败时显示 unknown/degraded，不回退到伪造在线。
