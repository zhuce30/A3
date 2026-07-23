# A3 管理员用户管理与运行总览实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Every permission, audit and aggregation change must follow superpowers:test-driven-development.

**目标：** 在现有 A3 Shell 中新增管理员专属用户管理和运行总览，所有字段来自真实数据库、可信请求信息或可验证探针。

**架构：** Django 负责管理员授权、访问状态、审计、安全事件、跨业务聚合和服务探针；Redis 保存短期在线心跳与探针缓存；Next.js 负责管理员页面和必要的前端运行自检；现有业务表保持所有权不变。

**技术栈：** Django、MySQL、Redis、Celery、Next.js 15、React 19、TypeScript、ECharts、Vitest、Django TestCase、Playwright。

**设计：** `docs/superpowers/specs/2026-07-23-a3-admin-operations-console-design.md`

---

### Task 1: 建立管理员权限和接口契约

**Files:**
- Modify: `backend/apps/accounts/permissions.py`
- Create: `backend/apps/system/admin_urls.py`
- Create: `backend/apps/system/admin_views.py`
- Modify: `backend/config/urls.py`
- Create: `backend/apps/system/tests/test_admin_permissions.py`
- Create: `OpenMAIC/lib/a3/admin-types.ts`
- Create: `OpenMAIC/tests/a3-admin-contract.test.ts`

- [ ] **Step 1: 编写失败的角色权限测试**

覆盖匿名用户 401、学生 403、教师 403、管理员 200。不要复用 `require_teacher_role`，新增明确的 `require_admin_role`。

- [ ] **Step 2: 验证 RED**

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_admin_permissions
```

- [ ] **Step 3: 定义稳定响应契约**

为 overview、user list、user detail、activity、security 和 account status 定义 TypeScript 类型和 schema version。失败继续使用：

```json
{ "success": false, "error": "可读中文错误" }
```

- [ ] **Step 4: 建立空实现路由并通过权限测试**

管理员路由可以先返回空集合和 `dataStatus: "not_collected"`，不能返回演示数字。

- [ ] **Step 5: 验证 GREEN**

运行 Django 权限测试、前端契约测试和 `manage.py check`。

- [ ] **Step 6: 提交权限与契约**

```powershell
git add backend/apps/accounts/permissions.py backend/apps/system/admin_urls.py backend/apps/system/admin_views.py backend/config/urls.py backend/apps/system/tests/test_admin_permissions.py OpenMAIC/lib/a3/admin-types.ts OpenMAIC/tests/a3-admin-contract.test.ts
git commit -m "feat(admin): add operations console contracts"
```

### Task 2: 持久化可信访问状态、IP 和在线心跳

**Files:**
- Modify: `backend/apps/accounts/models.py`
- Create: `backend/apps/accounts/client_ip.py`
- Create: `backend/apps/accounts/presence.py`
- Create: `backend/apps/accounts/migrations/00xx_user_access_state.py`
- Modify: `backend/apps/accounts/services.py`
- Modify: `backend/apps/accounts/views.py`
- Modify: `backend/apps/accounts/urls.py`
- Modify: `OpenMAIC/lib/server/a3-django-api.ts`
- Modify: `OpenMAIC/components/a3/layout/a3-shell.tsx`
- Modify: `Caddyfile`
- Create: `backend/apps/accounts/tests/test_client_ip.py`
- Create: `backend/apps/accounts/tests/test_presence.py`
- Create: `OpenMAIC/tests/a3-presence-heartbeat.test.tsx`

- [ ] **Step 1: 编写失败的客户端 IP 信任测试**

覆盖：

- 受信 Cloudflare/Caddy 转发链。
- 直接请求和本地开发。
- 伪造 `X-Forwarded-For`。
- Next 内部签名转发头。
- IPv4、IPv6、非法值、私网容器地址。
- 不允许 body 覆盖 IP。

- [ ] **Step 2: 编写失败的 presence 状态测试**

要求 Redis TTL 定义 online，数据库限频持久化定义 last seen；停止心跳后按 120 秒和 15 分钟阈值转换状态。

- [ ] **Step 3: 验证 RED**

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.accounts.tests.test_client_ip backend.apps.accounts.tests.test_presence
```

- [ ] **Step 4: 新增访问模型和索引**

实现 `UserAccessState` 与 `UserAccessEvent`。旧用户不回填虚构注册 IP；migration 只创建空状态或按首次新事件创建。

- [ ] **Step 5: 接入注册和登录**

注册成功写 registration IP；登录成功更新 last IP/last login；登录失败写最少必要事件且不泄露账号是否存在。原登录响应字段保持不变。

- [ ] **Step 6: 实现心跳接口**

`POST /api/accounts/presence/heartbeat/` 只接受当前登录用户和白名单 A3 路由。Redis TTL 120 秒，数据库同一用户 5 分钟内不重复更新。

- [ ] **Step 7: 接入 A3 Shell 心跳**

页面可见且用户已登录时每 60 秒发送；隐藏时暂停；恢复时立即发送；网络错误静默降级，不能影响主业务。

- [ ] **Step 8: 验证 Caddy/Next 头部链路**

确保 Caddy 只信任 Cloudflare 网段并重建转发信息。Next 内部转发使用服务器端签名，密钥不进入浏览器。记录生产前提：源站 8000 端口不向公网开放。

- [ ] **Step 9: 验证 GREEN**

运行访问、心跳、登录注册回归、TypeScript 和 Caddy 合同测试。

- [ ] **Step 10: 提交访问状态能力**

```powershell
git add backend/apps/accounts OpenMAIC/lib/server/a3-django-api.ts OpenMAIC/components/a3/layout/a3-shell.tsx OpenMAIC/tests/a3-presence-heartbeat.test.tsx Caddyfile
git commit -m "feat(admin): track trusted user presence"
```

### Task 3: 增加可选粗粒度 GeoIP

**Files:**
- Create: `backend/apps/accounts/geoip.py`
- Modify: `backend/config/settings.py`
- Modify: `backend/.env.example`
- Modify: `docker-compose.prod.yml`
- Create: `backend/apps/accounts/tests/test_geoip.py`
- Modify: `docs/A3_GHCR前端镜像部署.md` or current deployment owner document

- [ ] **Step 1: 编写失败的 GeoIP 降级测试**

覆盖可信国家头、本地 GeoLite2 命中、数据库缺失、私网地址、未知地址和数据库异常。

- [ ] **Step 2: 实现无外部实时请求的解析器**

优先可信 `CF-IPCountry`；省市只从配置的本地数据库解析。响应包含 `country/province/city/source/databaseVersion`。不在请求中调用公共 IP API。

- [ ] **Step 3: 配置可选数据库挂载**

GeoIP 数据库不进入 Git。使用只读 volume 和 `A3_GEOIP_DB_PATH`。未配置时页面显示国家或地区未知。

- [ ] **Step 4: 验证并提交**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.accounts.tests.test_geoip
git add backend/apps/accounts/geoip.py backend/apps/accounts/tests/test_geoip.py backend/config/settings.py backend/.env.example docker-compose.prod.yml docs
git commit -m "feat(admin): add optional coarse geo lookup"
```

### Task 4: 构建管理员用户聚合接口

**Files:**
- Create: `backend/apps/system/admin_user_services.py`
- Modify: `backend/apps/system/admin_views.py`
- Modify: `backend/apps/system/admin_urls.py`
- Create: `backend/apps/system/tests/test_admin_users.py`

- [ ] **Step 1: 编写失败的列表口径测试**

用多个用户覆盖：

- 显示名称、脱敏账号和角色。
- 学习方向和首要目标。
- 辅导会话、学习事件、成功资源包、生成任务、AgentRun 数量。
- 注册时间、最近活跃、账号状态、presence 状态。
- 旧用户缺失注册 IP。
- IP 默认脱敏。

- [ ] **Step 2: 编写失败的搜索、筛选和分页测试**

覆盖名称、邮箱、手机号、学号、IP、角色、启用状态、presence、时间范围、无效参数和最大 pageSize。

- [ ] **Step 3: 验证 RED**

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_admin_users
```

- [ ] **Step 4: 实现无 N+1 查询的列表**

使用 `select_related('learner_profile', 'access_state')`、聚合注解和有限 Subquery。测试用 `assertNumQueries` 约束列表查询不会随用户数线性增长。

- [ ] **Step 5: 实现用户详情**

详情返回画像、计数和近期结构化事件。禁止返回密码 hash、验证码、完整对话、图片 data URL、服务端文件路径或内部邮箱账号 hash。

- [ ] **Step 6: 实现完整 IP reveal**

单独 POST 命令返回短期展示数据并同步写 `AdminAuditLog`。普通 list/detail 不返回完整 IP。

- [ ] **Step 7: 验证 GREEN 并提交**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_admin_users
git add backend/apps/system/admin_user_services.py backend/apps/system/admin_views.py backend/apps/system/admin_urls.py backend/apps/system/tests/test_admin_users.py
git commit -m "feat(admin): expose real user operations data"
```

### Task 5: 增加管理员审计、账号启停和安全事件

**Files:**
- Create: `backend/apps/system/models.py`
- Create: `backend/apps/system/audit.py`
- Create: `backend/apps/system/security_events.py`
- Create: `backend/apps/system/migrations/0001_admin_audit_security.py`
- Modify: `backend/apps/system/admin_views.py`
- Modify: `backend/apps/accounts/services.py`
- Modify: relevant SafetyAgent persistence owners
- Create: `backend/apps/system/tests/test_admin_audit.py`
- Create: `backend/apps/system/tests/test_security_events.py`

- [ ] **Step 1: 编写失败的审计不可绕过测试**

查看完整 IP、停用/启用账号必须在同一事务中产生审计。操作失败不得记录为成功。`before/after` 只允许白名单字段。

- [ ] **Step 2: 编写失败的安全事件测试**

覆盖登录失败、管理员接口越权、SafetyAgent 拦截、限流和系统告警。确保不保存密码、验证码、Cookie、API key、完整 prompt 或回复。

- [ ] **Step 3: 实现模型、索引和保留策略**

为时间、severity、category、actor 建索引。增加清理命令或 Celery 定时任务，默认删除超过 90 天的访问/安全明细，保留必要管理员审计。

- [ ] **Step 4: 实现账号状态命令**

只允许启用/停用，禁止管理员停用自己和最后一个可用管理员。停用后使现有会话失效或在下次请求被拒绝，历史数据不删除。

- [ ] **Step 5: 验证并提交**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_admin_audit backend.apps.system.tests.test_security_events
git add backend/apps/system backend/apps/accounts/services.py
git commit -m "feat(admin): add audit and security event records"
```

### Task 6: 把系统健康从配置检查升级为真实探针

**Files:**
- Modify: `backend/apps/system/services.py`
- Create: `backend/apps/system/admin_overview.py`
- Create: `backend/apps/system/tasks.py`
- Modify: `backend/config/settings.py`
- Modify: realtime proxy owner under `OpenMAIC/scripts/`
- Modify: `OpenMAIC/app/api/a3/system/runtime/route.ts`
- Create: `backend/apps/system/tests/test_admin_health.py`
- Modify: `backend/apps/system/tests/test_health.py`
- Create: `OpenMAIC/tests/a3-admin-runtime-security.test.ts`

- [ ] **Step 1: 编写失败的真实状态测试**

要求：

- MySQL 和 Redis 使用短超时实际探针。
- Celery Worker/Beat 使用不同 heartbeat key。
- heartbeat 过期为 degraded/down。
- Provider configured 与 lastSuccessfulCall 分离。
- Knowledge Base 包含资源、索引任务、失败和最近成功时间。
- 单个探针异常不使 overview 500。

- [ ] **Step 2: 验证 RED**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_admin_health backend.apps.system.tests.test_health
```

- [ ] **Step 3: 实现 Celery 和 Beat heartbeat**

Worker 使用周期任务或 worker signal 写 Redis；Beat 通过独立周期执行证据写 key。页面请求不调用阻塞式 Celery inspect。

- [ ] **Step 4: 实现 realtime proxy healthz**

只验证进程、路由和必要配置，不建立上游付费模型会话。设置短超时。

- [ ] **Step 5: 计算 Provider 最近运行证据**

从 `AgentSpan`/`AgentRun` 读取最近成功、失败、延迟和错误分类。没有真实调用时为 unknown/configured，不能标 healthy。

- [ ] **Step 6: 收紧运行详情权限**

保留现有能力页面需要的脱敏可用性字段，把数据库 host、内部 URL 和 provider 细节移到管理员接口。学生、教师不可访问详细运行配置。

- [ ] **Step 7: 验证 GREEN 并提交**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests
cd OpenMAIC
pnpm.cmd vitest run tests/a3-admin-runtime-security.test.ts
git add backend/apps/system backend/config/settings.py OpenMAIC/app/api/a3/system/runtime/route.ts OpenMAIC/scripts OpenMAIC/tests/a3-admin-runtime-security.test.ts
git commit -m "feat(admin): add verifiable service health probes"
```

### Task 7: 聚合核心指标、趋势、任务分布、告警和活动日志

**Files:**
- Modify: `backend/apps/system/admin_overview.py`
- Modify: `backend/apps/system/admin_views.py`
- Create: `backend/apps/system/task_status.py`
- Create: `backend/apps/system/tests/test_admin_overview.py`
- Create: `backend/apps/system/tests/test_admin_activity.py`

- [ ] **Step 1: 编写失败的数据口径测试**

针对 24h、7d、30d 固定时间数据验证：用户、活跃用户、辅导会话、学习事件、资源包、AgentRun、安全事件和前周期变化。

- [ ] **Step 2: 编写连续日期和北京时间测试**

后端返回 `Asia/Shanghai` 连续日期；UTC 跨日数据进入正确北京时间日期。

- [ ] **Step 3: 编写统一任务状态测试**

覆盖资源、视频、知识库和 AgentRun 的 queued/running/succeeded/failed/stale 映射及不同任务类型的 stale 阈值。

- [ ] **Step 4: 实现聚合和 30 秒缓存**

数据库负责分桶，缺失日期补零。响应包含每个指标的 `source`、`definition` 和 `dataStatus`。缓存失败时仍返回有界降级结果。

- [ ] **Step 5: 实现结构化活动流和告警**

合并白名单事件类型，按时间 cursor 分页。只输出摘要、状态、脱敏用户、traceId 和时间。告警基于明确规则，不解析 stdout 文本。

- [ ] **Step 6: 验证并提交**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_admin_overview backend.apps.system.tests.test_admin_activity
git add backend/apps/system
git commit -m "feat(admin): aggregate operations metrics and alerts"
```

### Task 8: 实现管理员页面和导航

**Files:**
- Create: `OpenMAIC/app/a3/admin/page.tsx`
- Create: `OpenMAIC/app/a3/admin/overview/page.tsx`
- Create: `OpenMAIC/app/a3/admin/users/page.tsx`
- Create: `OpenMAIC/components/a3/features/admin/admin-overview-view.tsx`
- Create: `OpenMAIC/components/a3/features/admin/admin-users-view.tsx`
- Create: `OpenMAIC/components/a3/features/admin/admin-user-detail-drawer.tsx`
- Create: `OpenMAIC/components/a3/features/admin/admin-service-health.tsx`
- Create: `OpenMAIC/components/a3/features/admin/admin-metrics-chart.tsx`
- Create: `OpenMAIC/lib/a3/admin-api.ts`
- Modify: `OpenMAIC/lib/a3/navigation.ts`
- Modify: `OpenMAIC/components/a3/layout/a3-shell.tsx`
- Create: `OpenMAIC/tests/a3-admin-navigation.test.ts`
- Create: `OpenMAIC/tests/a3-admin-overview-view.test.tsx`
- Create: `OpenMAIC/tests/a3-admin-users-view.test.tsx`

- [ ] **Step 1: 编写失败的管理员导航测试**

学生和教师看不到“系统管理”；管理员看到“运行总览”和“用户管理”。直接打开路由时，非管理员显示权限错误并不请求数据。

- [ ] **Step 2: 编写失败的用户页状态测试**

覆盖加载、空结果、搜索、组合筛选、分页、接口错误、陈旧数据、详情抽屉、IP reveal 二次确认和账号启停确认。

- [ ] **Step 3: 编写失败的总览页状态测试**

覆盖健康/降级/宕机/未知、未采集指标、自动刷新、页面隐藏暂停、手动刷新、部分接口失败、趋势和任务图表文字替代。

- [ ] **Step 4: 实现管理员路由和现有 Shell 集成**

沿用 A3 导航和顶栏，不创建第二套黑色侧边栏。页面服务端或首屏守卫管理员角色，后端仍是最终权限边界。

- [ ] **Step 5: 实现紧凑响应式用户表**

桌面端固定表头和横向滚动；移动端使用分组列表。默认脱敏账号和 IP。自动刷新不重置筛选、分页、滚动和详情抽屉。

- [ ] **Step 6: 实现运行总览**

使用现有 ECharts 封装或项目已启用的图表模式。任务分布同时展示数值列表；趋势图可切换系列；卡片不嵌套。

- [ ] **Step 7: 实现无重叠轮询**

30 秒默认，`AbortController` 取消过期请求。document hidden 时暂停，visible 时立即刷新。显示数据更新时间和 stale 状态。

- [ ] **Step 8: 验证 GREEN 并提交**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-admin-navigation.test.ts tests/a3-admin-overview-view.test.tsx tests/a3-admin-users-view.test.tsx
npx.cmd tsc --noEmit
pnpm.cmd lint
git add app/a3/admin components/a3/features/admin lib/a3/admin-api.ts lib/a3/admin-types.ts lib/a3/navigation.ts components/a3/layout/a3-shell.tsx tests/a3-admin-*.test.ts*
git commit -m "feat(admin): add operations console pages"
```

### Task 9: 端到端、隐私、性能和生产验证

**Files:**
- Create: `OpenMAIC/e2e/tests/a3-admin-operations.spec.ts`
- Create: `OpenMAIC/e2e/tests/a3-admin-permissions.spec.ts`
- Modify: `OpenMAIC/tests/a3-ghcr-deployment.test.ts`
- Output: `outputs/test-evidence/admin-operations/`

- [ ] **Step 1: 准备真实角色测试数据**

创建学生、教师、管理员、启用和停用用户；写入学习事件、会话、资源任务、AgentRun、presence、安全事件和审计记录。不要在生产数据库运行测试 seed。

- [ ] **Step 2: 验证权限**

学生、教师直接访问页面和 API 均失败；管理员成功。伪造客户端角色、查询参数或转发 IP 不能越权。

- [ ] **Step 3: 验证数据一致性**

对比页面值、API 和数据库计数。验证旧用户注册 IP 为未记录，新用户 IP/地区来源正确，在线 TTL 正确。

- [ ] **Step 4: 验证视觉与移动端**

截图桌面用户表、用户详情、运行总览、部分降级、空状态和移动端。检查表格、图表、筛选器、抽屉、文字和状态不重叠。

- [ ] **Step 5: 验证自动刷新和查询负载**

确认无重叠请求、隐藏页停止轮询、筛选状态保持。记录 overview/list 查询数和响应时间；用户数量增加不产生 N+1。

- [ ] **Step 6: 验证隐私**

扫描管理员 API、Next 响应和浏览器日志，禁止密码 hash、验证码、Cookie、API key、完整对话、图片 data URL、内部文件路径和未审计完整 IP。

- [ ] **Step 7: 运行完整验证**

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py makemigrations --check --dry-run
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.accounts.tests backend.apps.system.tests
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict

cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-admin-contract.test.ts tests/a3-admin-navigation.test.ts tests/a3-admin-overview-view.test.tsx tests/a3-admin-users-view.test.tsx tests/a3-admin-runtime-security.test.ts tests/a3-presence-heartbeat.test.tsx tests/a3-ghcr-deployment.test.ts
npx.cmd playwright test e2e/tests/a3-admin-operations.spec.ts e2e/tests/a3-admin-permissions.spec.ts --project=chromium
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd build
```

- [ ] **Step 8: 验证生产部署前提**

确认 migration、Redis、GeoIP 可选挂载、heartbeat、realtime proxy healthz、Caddy trusted proxy、Docker health 和回滚脚本。先部署后端并执行 migration，再部署前端。

- [ ] **Step 9: 提交验收证据**

```powershell
git add OpenMAIC/e2e/tests/a3-admin-operations.spec.ts OpenMAIC/e2e/tests/a3-admin-permissions.spec.ts OpenMAIC/tests/a3-ghcr-deployment.test.ts outputs/test-evidence/admin-operations
git commit -m "test(admin): verify operations console end to end"
```

## 交付检查点

### Checkpoint A: 安全数据底座

Tasks 1-3 完成。管理员权限、可信 IP、presence 和可选 GeoIP 可用，但导航仍不开放。

### Checkpoint B: 只读用户管理

Task 4 完成。管理员能查看真实用户和学习使用数据，旧用户缺失字段明确显示未记录。

### Checkpoint C: 运行与风险可观测

Tasks 5-7 完成。真实探针、指标、趋势、任务、告警、安全和审计有统一接口。

### Checkpoint D: 产品页面上线

Tasks 8-9 完成。管理员页面、权限、移动端、隐私、性能和部署验证全部通过。

## 接口影响

**新增接口：**

```text
GET  /api/admin/overview/
GET  /api/admin/users/
GET  /api/admin/users/<id>/
POST /api/admin/users/<id>/status/
POST /api/admin/users/<id>/reveal-ip/
GET  /api/admin/activity/
GET  /api/admin/security-events/
POST /api/accounts/presence/heartbeat/
```

**现有接口调整：**

- `/api/system/health/` 保留脱敏能力状态。
- `/api/a3/system/runtime` 保留现有能力页面兼容字段，但敏感运行详情迁移至 admin overview。
- 注册和登录响应字段不变，只增加服务端旁路访问记录。

**前端调用位置：**

- `OpenMAIC/components/a3/features/admin/`
- `OpenMAIC/lib/a3/admin-api.ts`
- `OpenMAIC/components/a3/layout/a3-shell.tsx` 的 presence heartbeat

**回归重点：**

- 学生和教师现有导航、能力页、登录注册不受影响。
- 教师工作台仍只能查看教学授权范围，不获得全站 IP 和系统详情。
- 运行探针失败不阻断学习接口。
- Redis 或 GeoIP 不可用时 presence/地区降级，不阻断认证。

## 回滚顺序

1. 隐藏“系统管理”导航并停用账号写操作。
2. 保留管理员只读 API，关闭自动刷新和高成本聚合。
3. 停止 GeoIP 和心跳持久化，登录注册继续工作。
4. 新增旁路表不删除，避免丢失审计；旧业务表和接口保持不变。
