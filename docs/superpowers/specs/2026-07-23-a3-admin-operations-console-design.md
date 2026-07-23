# A3 管理员用户管理与运行总览设计

## 1. 背景

当前 A3 已有学生端、教师工作台、能力总览、系统健康检查、Caddy 访问日志和大量真实业务数据，但没有管理员专属的运营控制台。管理员无法在产品内完成以下工作：

- 查看已注册用户、账号状态、学习方向、近期活跃和业务使用情况。
- 查看注册 IP、最近访问 IP 及其粗粒度地区。
- 判断用户当前在线、暂时离开还是已经离线。
- 查看 Django、MySQL、Redis、Celery、实时代理、知识库和模型 Provider 的真实运行状态。
- 查看用户增长、学习会话、资源生成、Agent 调用、任务状态和安全事件趋势。
- 查看管理员操作记录和近期系统告警。

用户提供的两张参考图可以实现，但不能直接照搬字段和服务名称。A3 生产技术栈是 Django、MySQL、Redis、Celery、Next.js、Caddy 和实时代理，不是图中的 FastAPI、SQLite。所有指标必须来自真实数据、探针或审计事件，不能用写死数字或把“已配置”冒充“在线”。

## 2. 目标

新增管理员专属“系统管理”功能域，首批包含两个页面：

```text
/a3/admin/overview   运行总览
/a3/admin/users      用户管理
```

目标：

1. 管理员能检索、筛选和查看真实用户及其学习使用情况。
2. 管理员能区分账号启用状态、在线状态和学习活跃状态。
3. 管理员能查看可信来源的注册 IP、最近 IP 和可用的地区信息。
4. 管理员能看到当前服务健康、核心业务指标、趋势、任务分布、告警和操作日志。
5. 页面自动刷新不会制造高数据库负载，也不会把轮询伪装成 WebSocket 实时流。
6. 所有接口严格限制 `admin`，教师和学生不能读取运营数据。
7. IP、账号和行为数据遵循最小展示、脱敏、留痕和保留期限原则。

## 3. 非目标

- 不用该页面替代 Django Admin。
- 不在首批实现完整 APM、Prometheus、Grafana 或日志检索平台。
- 不展示用户密码、验证码、Cookie、API key、完整对话内容或图片内容。
- 不根据 IP 精确定位地址，也不声称城市信息百分之百准确。
- 不把登录成功等同于在线。
- 不允许管理员直接物理删除用户及其学习数据；首批只支持启用/停用。
- 不向教师开放全站用户、IP、系统配置和安全事件。
- 不从 Caddy 历史日志猜测已有用户的注册 IP，因为日志无法可靠映射到具体账号。

## 4. 当前数据可用性

### 4.1 用户管理字段

| 参考字段 | 当前状态 | 设计处理 |
|---|---|---|
| 用户名 | 已有 `User.display_name` | 直接展示 |
| 账号 | 已有邮箱、手机号、学号 | 默认脱敏；邮箱注册账号不展示内部 `email:<hash>` |
| 注册 IP | 当前未持久化 | 新增采集；旧用户显示“历史未记录” |
| 最近 IP | 当前未持久化 | 登录和心跳更新 |
| IP 地区 | 当前只有 Caddy 国家级信息可能可用 | 采用可信请求头或本地 GeoIP，显示粗粒度结果和来源 |
| 学习方向 | 已有 `LearnerProfile.major_direction`、学习目标 | 展示方向和首要目标 |
| 会话数 | 已有 `CoachingSession` | 首批明确标为“辅导会话”或在说明中定义口径 |
| 生成资源 | 已有 `ResourcePackLog`、生成任务 | 区分成功资源包和生成请求 |
| 最近活跃 | 可从学习事件近似 | 新增心跳后使用准确 `last_seen_at` |
| 注册时间 | 已有 `User.created_at` | 直接展示，统一北京时间 |
| 账号状态 | 已有 `User.is_active` | 启用/停用 |
| 在线状态 | 当前没有 | 新增 Redis 心跳和持久快照 |

### 4.2 运行总览数据

| 参考指标 | 现有来源 | 缺口 |
|---|---|---|
| 用户总数 | `User` | 无 |
| 新增用户 | `User.created_at` | 无 |
| 辅导会话 | `CoachingSession` | 无 |
| 学习交互 | `LearningEvent` | 需要定义事件口径 |
| 生成资源 | `ResourcePackLog`、`ResourceGenerationJob` | 需要区分成功与请求 |
| Agent 调用 | `AgentRun`、`AgentSpan` | 无 |
| 任务状态 | 资源、视频、知识库任务和 AgentRun | 需要统一状态映射 |
| 安全事件 | `CoachingMessage.safety/refusal_reason` 有部分证据 | 登录失败、越权和限流缺少统一事件表 |
| 数据库 | 已有真实 `SELECT 1` | 无 |
| Redis | readiness 已有 `PING` | 无 |
| Celery | 当前只检查配置 | 缺少 worker 心跳 |
| Celery Beat | 当前只检查 schedule 注册 | 缺少调度器心跳 |
| 实时代理 | 当前无产品内探针 | 新增轻量健康端点 |
| 模型 Provider | 当前能判断是否配置 | 需要区分配置状态和最近真实调用状态 |
| 知识库 | 已有索引目录、资源和任务 | 需要聚合数量、失败和最近成功时间 |

## 5. 信息架构

在现有 A3 侧边栏增加仅 `admin` 可见的一级入口“系统管理”，而不是复制参考图的独立黑色导航。

```text
系统管理
├── 运行总览
└── 用户管理
```

教师工作台继续负责教学干预；管理员控制台负责全站账号、运行状态、风险和审计，两者不混合。

## 6. 用户管理页面

### 6.1 页面结构

```text
标题：用户管理
副标题：账号、访问状态与学习使用情况

搜索框  角色筛选  账号状态  在线状态  注册时间  总数  刷新

用户表格
用户名 | 账号 | 角色 | 注册 IP | 最近 IP | 学习方向 |
辅导会话 | 成功资源包 | 最近活跃 | 注册时间 | 状态

分页
```

表格保持适合运营工具的紧凑密度。桌面端使用固定表头和横向滚动；移动端切换为分组列表，不压缩成不可读的超宽表格。

### 6.2 搜索与筛选

支持：

- 显示名称、完整账号精确匹配、学号。
- 注册 IP、最近 IP 的管理员精确搜索。
- 角色：学生、教师、管理员。
- 账号：启用、停用。
- 状态：在线、暂离、离线。
- 注册时间和最近活跃时间范围。

搜索输入做长度限制，后端使用参数化 ORM 查询。默认按最近活跃降序，分页大小 20，允许 20/50，不允许一次返回全部用户。

### 6.3 行状态定义

三个概念分开显示：

- 账号状态：`active/disabled`，来自 `User.is_active`。
- 在线状态：来自 Redis 心跳。
- 学习活跃：来自最近学习事件、会话、资源和 AgentRun。

在线口径：

```text
online   最近心跳 <= 120 秒
idle     最近心跳 > 120 秒且 <= 15 分钟
offline  最近心跳 > 15 分钟或从未心跳
```

关闭页面、浏览器休眠和网络中断都会在 TTL 后自动离线，不依赖前端发送不可靠的 logout 事件。

### 6.4 用户详情抽屉

点击用户行打开详情抽屉，不跳离列表：

- 基本资料：显示名称、角色、学校、脱敏账号、注册时间、账号状态。
- 学习画像：年级、方向、基础水平、学习目标、薄弱点、学习偏好。
- 使用概览：最近活跃、辅导会话、学习事件、成功资源包、生成任务、AgentRun。
- 近期记录：只展示事件类型、页面、状态、时间和 traceId，不展示完整对话正文。
- 访问摘要：注册 IP、最近 IP、地区、最后路由、最近登录。
- 管理操作：启用/停用账号；高风险操作二次确认并写审计日志。

首批不提供“删除用户”。停用账号不会删除历史学习证据。

## 7. IP、地区与在线状态

### 7.1 可信客户端 IP

IP 只能从可信代理链解析：

```text
浏览器
-> Cloudflare
-> Caddy trusted_proxies
-> Django / Next internal proxy
```

规则：

1. 优先使用由受信 Cloudflare/Caddy 重建的客户端 IP 信息。
2. 只在请求确实来自受信反向代理或内部服务时接受转发头。
3. 不直接信任公网客户端自行提交的 `X-Forwarded-For`、`X-Real-IP` 或 body IP。
4. Next 内部代理如需转发 IP，使用固定内部请求头并由服务器端生成；Django 只接受来自内部网络和预共享签名的该头。
5. IPv4、IPv6 使用标准解析库校验，拒绝非法、私网伪造和超长值。

### 7.2 持久数据

新增一对一访问状态和追加事件：

```text
UserAccessState
- user
- registration_ip / registration_geo / registration_at
- last_ip / last_geo / last_seen_at / last_route
- last_login_at
- last_user_agent_hash
- updated_at

UserAccessEvent
- user nullable
- event_type: register/login_success/login_failed/logout/heartbeat
- ip / geo / route / user_agent_hash
- success / reason_code
- created_at
```

心跳不应每分钟都追加事件表。Redis 保存实时 TTL；数据库 `UserAccessState` 最多每 5 分钟落一次。注册、登录成功、登录失败和账号管理操作保留独立事件。

### 7.3 地区解析

地区仅用于粗粒度运营判断：

- 国家优先使用可信 `CF-IPCountry`。
- 省市可选用本地 MaxMind GeoLite2 数据库，不能在每次请求中调用不受控第三方 IP API。
- GeoIP 数据库未配置或匹配失败时显示“地区未知”，不能编造城市。
- 每条地区结果记录 `source` 和 GeoIP 数据库版本。
- 历史记录不因 GeoIP 数据库更新而自动改写，避免审计结果漂移。

### 7.4 隐私展示

- 用户表默认显示脱敏 IP，例如 `117.86.*.*` 或 IPv6 前缀。
- 管理员在详情抽屉中点击“查看完整 IP”后展示，并写入 `AdminAuditLog`。
- IP 和访问事件默认保留 90 天；注册 IP 可随账号保留，但导出和展示受审计控制。
- 不保存原始 User-Agent，只保存归一化设备类型和不可逆 hash。

## 8. 运行总览页面

### 8.1 顶部状态

顶部显示：

- 数据更新时间，例如“更新于 22:54:37”。
- 自动刷新开关，默认 30 秒。
- 手动刷新按钮。
- 数据超过 90 秒未更新时显示“数据可能已过期”。

不使用每秒变化的“实时”时钟冒充数据实时性。12 个用户规模不需要 WebSocket；30 秒有界轮询更稳定。页面隐藏时停止轮询，恢复可见时立即刷新。

### 8.2 服务健康

服务卡片按 A3 真实架构展示：

```text
Frontend / Next.js
Backend / Django
MySQL
Redis
Celery Worker
Celery Beat
Realtime Proxy
Knowledge Base
Model Providers
```

统一状态：

```text
healthy    实际探针成功
degraded   可用但存在延迟、积压、过期心跳或部分 provider 失败
down       探针失败或关键依赖不可用
unknown    只有配置，没有近期运行证据
```

必须把“configured”与“healthy”分开。例如 LLM key 存在只能说明 `configured=true`；只有最近真实 AgentSpan 成功，才能显示“最近调用成功”。

探针口径：

- Backend：liveness/readiness。
- MySQL：`SELECT 1` 和短超时。
- Redis：`PING`。
- Celery Worker：worker 定期写 Redis heartbeat，不在页面请求中执行高延迟 inspect。
- Celery Beat：调度器或周期任务写独立 heartbeat。
- Realtime Proxy：轻量 `/healthz`，不建立付费模型会话。
- Knowledge Base：索引资源数量、失败任务、最近成功索引时间。
- Model Providers：配置状态、最近真实调用时间、最近失败率，不在刷新时发送付费探测请求。
- Frontend：当前 Next route 自检和构建 revision。

### 8.3 核心指标

默认统计近 7 天，同时支持 24 小时、7 天、30 天：

- 用户总数和周期新增用户。
- 活跃用户数，按有心跳或学习事件的去重用户计算。
- 辅导会话数，来自 `CoachingSession`。
- 学习交互数，来自已允许的 `LearningEvent.event_type`。
- 成功资源包数，来自 `ResourcePackLog`。
- Agent 调用数和失败率，来自 `AgentRun`。
- 安全事件数，来自统一安全事件表。

每张指标卡显示当前值、同比前一相同周期变化和数据口径提示。没有采集的数据展示“未采集”，不能展示误导性的 `0`。

### 8.4 趋势图

趋势图支持勾选：

- 活跃用户。
- 辅导会话。
- 成功资源包。
- Agent 调用。

后端按 `Asia/Shanghai` 自然日聚合并返回连续日期，缺失日补零。前端不自行从 UTC 时间猜分桶。

### 8.5 任务状态分布

统一聚合：

- `ResourceGenerationJob`
- `VideoGenerationJob`
- 知识库索引任务
- `AgentRun`

映射为：

```text
queued       等待中
running      执行中
succeeded    已完成
failed       失败
stale        超过任务类型阈值仍未更新
```

图表中心显示总任务数，旁边必须同时显示数值列表，不能只依赖颜色。点击某个状态筛选下方任务/操作日志。

### 8.6 近期告警

首批告警来自可验证规则：

- 服务探针 down 或 heartbeat 过期。
- 资源、视频、知识库任务失败或长时间无更新。
- Agent workflow 失败率超过阈值。
- SafetyAgent 拦截、连续登录失败、越权访问和限流事件。
- 磁盘空间、队列长度等数据只有接入可靠探针后才展示。

告警包含等级、来源、开始时间、最近时间、影响对象、建议动作和是否已恢复。

### 8.7 实时操作日志

操作日志展示结构化事件，不直接读取和渲染容器 stdout：

- 用户注册、登录和账号停用。
- 学习会话开始/结束。
- 资源和视频任务状态变化。
- 知识库索引状态变化。
- AgentRun 成功、降级、失败。
- 管理员查看完整 IP、修改账号状态。

默认只显示事件摘要、类别、状态、时间、脱敏用户和 traceId。用户问题正文、模型回答、图片、文件路径、密钥和 Cookie 不进入该列表。

## 9. 安全事件与管理员审计

新增：

```text
SecurityEvent
- category: auth/safety/authorization/rate_limit/system
- severity: info/warning/high/critical
- user nullable
- source / reason_code / status
- ip_masked / metadata
- occurred_at

AdminAuditLog
- actor
- action
- target_type / target_id
- summary / before / after
- ip / created_at
```

高风险事件只保存必要元数据。`before/after` 仅允许白名单字段，禁止把完整用户对象、密码 hash、验证码或密钥写入审计表。

## 10. 权限边界

新增独立 `require_admin_role`：

```text
未登录 -> 401
student/teacher -> 403
admin -> 允许
```

前端隐藏导航不是安全控制。所有用户列表、完整 IP、运行详情、告警、审计和账号操作接口必须在 Django 端再次验证管理员角色。

现有 `/api/system/health/` 和 `/api/a3/system/runtime` 含有数据库 host、provider 配置等细节。实施时应拆分：

- 普通登录用户只能得到脱敏的能力可用性。
- 管理员接口才能得到运行详情。

拆分必须保持能力总览页面的现有契约可用，不能直接删除它依赖的字段。

## 11. API 设计

建议接口：

```text
GET  /api/admin/overview/?range=7d
GET  /api/admin/users/?q=&role=&accountStatus=&presence=&page=1&pageSize=20
GET  /api/admin/users/<user_id>/
POST /api/admin/users/<user_id>/status/
POST /api/admin/users/<user_id>/reveal-ip/
GET  /api/admin/activity/?cursor=&category=&status=
GET  /api/admin/security-events/?severity=&cursor=
POST /api/accounts/presence/heartbeat/
```

所有列表使用分页或 cursor。`overview` 响应按 30 秒缓存，缓存键包含时间范围但不包含用户输入文本。

## 12. 查询与性能

- 用户列表使用 `select_related`、聚合注解和有限 `Subquery`，禁止逐用户查询会话和资源数量。
- 给 `UserAccessState.last_seen_at`、访问事件时间、SecurityEvent 时间/等级、AdminAuditLog actor/时间增加索引。
- 趋势按数据库聚合，不把全部事件传给 Next.js 再计算。
- 运行探针使用 1 秒级超时和 30 秒缓存；单个非关键探针失败不阻塞整个 overview。
- 自动刷新请求设置取消控制，前一次未完成时不并发发起下一次。
- 操作日志使用 cursor pagination，避免大 offset。
- 心跳 Redis 写入设置 TTL，数据库最多每 5 分钟持久化一次。

## 13. UI 设计

- 沿用 A3 现有字体、浅色背景、8px 以内圆角、侧边栏和顶栏。
- 状态色使用青绿、黄色和红色，但正文不依赖颜色表达。
- 服务健康卡和核心指标卡为重复数据单元；趋势、任务分布、告警和日志保持清晰的全宽区域。
- 不把卡片嵌套在卡片中。
- 刷新、搜索、筛选、查看详情和状态操作使用现有 Lucide 图标。
- 表格空状态、加载骨架、权限错误、接口错误、陈旧数据和部分探针失败均有独立状态。
- 自动刷新时保留筛选、分页、滚动位置和已打开详情抽屉，不整页闪烁。
- 时间统一显示北京时间，并在接口返回中保留 ISO 8601 原值。

## 14. 验收标准

### 用户管理

- 只有管理员能进入页面和调用接口。
- 用户列表全部来自数据库，无 mock 数据。
- 搜索、角色、账号状态、在线状态和分页可组合使用。
- 会话数、资源数、学习方向、注册时间与数据库一致。
- 新注册/登录用户可以记录可信 IP；旧用户注册 IP 显示“历史未记录”。
- 在线状态会在停止心跳后自动从 online 变为 idle/offline。
- 查看完整 IP 和停用账号均产生管理员审计记录。
- 停用用户不能继续建立新会话，但历史学习数据保留。

### 运行总览

- 服务状态区分 configured、healthy、degraded、down、unknown。
- Celery 和 Beat 使用真实 heartbeat，不再把配置存在当作在线。
- LLM Provider 不通过刷新页面触发付费调用。
- 指标、趋势、任务分布可以追溯到真实表和明确口径。
- 未采集的安全或运行数据显示“未采集”，不显示误导性 0。
- 自动刷新不会产生重叠请求，页面隐藏后停止。
- 一个探针失败时其余指标仍能返回，并明确标记部分降级。

### 安全与隐私

- 学生和教师访问管理员接口均返回 403。
- 伪造转发头不能覆盖可信客户端 IP。
- 响应和日志不包含密码、验证码、Cookie、API key 或完整对话正文。
- IP 默认脱敏，完整查看有审计，访问事件有保留期限。

## 15. 发布顺序

1. 先完成管理员权限、数据模型、可信 IP 和心跳，不开放页面。
2. 发布只读用户管理列表和详情。
3. 发布真实运行探针、核心指标和趋势。
4. 发布安全事件、审计日志和账号启停操作。
5. 数据口径和权限回归通过后再把“系统管理”加入管理员导航。

## 16. 回滚

- 前端导航和页面可独立移除，不影响学生和教师业务。
- 新增访问、审计和安全表为旁路数据，不改变现有学习表结构。
- 心跳失败时用户仅显示 offline/unknown，不阻断登录和学习。
- GeoIP 未配置时退化为国家或“地区未知”。
- 实际探针异常时返回 unknown/degraded，不回退到伪造的在线状态。
- 账号状态接口出现风险时先关闭写操作，保留只读控制台。
