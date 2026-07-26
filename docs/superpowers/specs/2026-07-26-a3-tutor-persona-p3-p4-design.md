# A3 导师人格 P3/P4、音色试听与 OpenMAIC Handoff 设计

> 项目：智学引擎 A3
>
> 日期：2026-07-26
>
> 状态：已确认，待实施计划
>
> 基线分支：`codex/unified-tutor-persona`

## 1. 目标

在现有统一导师人格链路上完成四项扩展：

1. 为四种导师人格提供真实、受控、可缓存的音色试听。
2. 让 A3 生成 OpenMAIC 课堂时携带并应用导师人格快照。
3. 建立可扩展的多 VRM 资产管理框架，但在没有第二套授权资产时继续只启用现有 `teacher.vrm`。
4. 增加管理员导师中心，支持人格启停、VRM 绑定、运行状态和聚合效果评估。

本设计不把视觉外观数量当作导师能力。导师人格首先改变教学策略、语音和工作流；VRM 只是可替换的视觉表现层。

## 2. 当前基线

当前功能分支已经具备：

- 四种受控人格：`structured-teacher`、`socratic-guide`、`practice-coach`、`foundation-coach`。
- `LearnerProfile.extra_profile.tutorPreference` 用户偏好。
- `CoachingSession.metadata.tutorPersona` 会话快照。
- 文本 QA、OpenAI realtime、DashScope realtime 的人格绑定。
- 面对面辅导与 A3 AI 课堂共享人格选择器。
- 服务端白名单解析；浏览器不能提交任意 prompt 或 provider voice。

当前只有一套视觉资产：

- `/a3/assets/teacher-avatar/teacher.vrm`
- 对应源文件 `teacher.vroid`
- 四种人格均使用 `teacher-default-v1`

## 3. 范围与非目标

### 3.1 本批范围

- 音色试听 API、缓存、UI 状态和真实 provider 降级。
- OpenMAIC 课堂生成请求、Stage、artifact 的公开导师快照。
- 版本化 VRM 资产记录、许可证元数据、启停和人格绑定。
- 当前默认资产的数据迁移与回退策略。
- 管理员导师中心 `/a3/admin/tutors`。
- 会话后 1-5 分和固定标签反馈。
- 运营指标、会话质量指标和辅导后 7 天测评关联指标。
- 管理操作审计、权限、缓存和契约测试。

### 3.2 非目标

- 不从互联网自动下载未知许可证的 VRM。
- 不复制现有 VRM 冒充多个数字人。
- 不开放浏览器上传 VRM 或填写任意模型 URL。
- 不允许管理员在线编辑私有 system prompt、provider voice 或 API key。
- 不把辅导后测评变化描述为因果效果。
- 不同时渲染或预加载多套 VRM。
- 不在本批引入照片级服务端数字人或 GPU 推理。

## 4. 总体架构

采用“代码白名单 + 数据库管理覆盖层”。

```text
服务端受控人格目录
├─ 私有教学策略
├─ realtime/TTS 音色映射
└─ 允许的工作流

数据库管理覆盖层
├─ 人格启用状态
├─ avatarAssetId 绑定
├─ VRM 授权元数据
└─ 管理员审计记录

学生使用链路
├─ 音色试听
├─ 文本/实时辅导
├─ OpenMAIC 课堂 handoff
├─ 会话结束反馈
└─ 后续测评结果

管理员导师中心
├─ 人格与 VRM 管理
├─ provider/音色可用性
├─ 采用率与会话质量
└─ 辅导后 7 天测评变化
```

私有策略仍以代码目录为权威来源。数据库只能启停既有人格、绑定已登记资产和保存运营数据，不能引入任意指令、音色或资源 URL。

## 5. 数据模型

### 5.1 `TutorAvatarAsset`

建议归属 `backend.apps.learning`，字段如下：

| 字段 | 说明 |
|---|---|
| `asset_id` | 稳定 ID，例如 `teacher-default-v1` |
| `display_name` | 管理员可见名称 |
| `public_path` | 受控静态相对路径，只允许 `/a3/assets/teacher-avatar/` 前缀 |
| `thumbnail_path` | 受控缩略图相对路径 |
| `author` | 作者或制作方 |
| `source_name` | 来源平台或内部来源 |
| `source_url` | 来源证明链接，可为空但会标记许可证资料不完整 |
| `license_name` | 许可证名称 |
| `license_url` | 许可证或书面授权证明链接 |
| `usage_scope` | 比赛展示、网站部署、商业使用、修改、再分发等范围 |
| `sha256` | 文件内容哈希 |
| `file_size_bytes` | 文件大小 |
| `status` | `draft`、`enabled`、`disabled` |
| `is_default` | 是否为默认回退资产，只能有一个 |
| `metadata` | 版本、兼容性、动作集等非敏感元数据 |
| `created_at/updated_at` | 审计时间 |

首次迁移只登记 `teacher-default-v1`。其许可证字段必须根据项目实际来源填写；未知时标记资料不完整，不伪造许可证。

新增的外部 VRM 只有在作者、来源、许可证、使用范围和哈希均完整时才能从 `draft` 改为 `enabled`。现有 `teacher-default-v1` 为保证历史功能兼容可继续运行；如果其授权资料尚未登记，管理员页必须显示“授权资料待补充”，不能显示“已验证”。

### 5.2 `TutorPersonaConfiguration`

| 字段 | 说明 |
|---|---|
| `persona_id` | 对应代码白名单中的人格 ID，唯一 |
| `enabled` | 是否允许新会话选择 |
| `avatar_asset` | 当前绑定的 `TutorAvatarAsset` |
| `voice_preview_enabled` | 是否允许试听 |
| `updated_by` | 最近修改管理员 |
| `created_at/updated_at` | 审计时间 |

不保存私有 instruction、OpenAI voice、DashScope voice 或 API key。

### 5.3 `TutorPersonaFeedback`

| 字段 | 说明 |
|---|---|
| `user` | 提交学生 |
| `session` | 学生拥有的辅导会话 |
| `persona_id` | 会话人格快照 ID |
| `rating` | 1-5 整数 |
| `tags` | 固定标签数组 |
| `created_at/updated_at` | 提交和修改时间 |

约束：`(user, session)` 唯一。允许修改，不允许针对他人会话提交。

### 5.4 历史兼容

- 历史 `CoachingSession.metadata.tutorPersona` 保持不变。
- 人格被停用后，历史会话仍展示原快照。
- 已保存但已停用的人格偏好在新会话创建时回退到 `structured-teacher`；若默认人格也被错误停用，则使用第一个启用人格并记录降级。
- 系统必须阻止管理员停用最后一个可用人格。
- 被人格引用的默认资产不能停用。

## 6. VRM 资产接入与运行时

本批不提供浏览器上传。新增授权资产的标准流程是：

```text
核对许可证
-> 将 .vrm 与缩略图加入固定静态目录
-> 构建并部署前端镜像
-> 使用管理命令登记资产元数据、SHA-256 和路径
-> 管理员页面验证可访问性与许可证完整性
-> 绑定人格
-> 启用资产
```

管理命令必须拒绝：

- 绝对路径。
- `..` 路径穿越。
- 非 `.vrm` 文件。
- 非允许静态目录前缀。
- 缺少哈希或文件大小。

浏览器运行时：

- 人格公开快照增加受控的 `avatarAsset` 描述或可解析路径。
- 同一资产的人格切换不重载 VRM。
- 不同资产切换时继续复用同一个 Canvas 和 renderer，释放旧模型后加载新模型。
- 加载期间保留静态 fallback，不改变页面几何尺寸。
- 加载失败自动回退 `teacher-default-v1`，并在 UI 显示降级状态。
- 每次只保留一个活动 VRM；不预加载全部资产。

## 7. 音色试听

### 7.1 接口

```http
POST /api/a3/tutors/voice-preview
Content-Type: application/json

{
  "personaId": "foundation-coach"
}
```

该接口位于 Next 服务端，因为 TTS provider、密钥和音频生成器均在 OpenMAIC 服务端运行。接口必须通过 Django cookie 验证登录，并确认人格在 Django 管理覆盖层中启用。

成功返回 `audio/mpeg`、`audio/wav` 等二进制响应。客户端只获得音频，不获得 provider ID、voice ID、base URL 或密钥。

### 7.2 Provider 选择

首期优先级：

1. 已配置的 Qwen TTS。
2. 已配置的 OpenAI TTS。
3. 返回 503 和中文错误“当前未配置音色试听”。

不使用浏览器原生随机音色冒充导师音色。每种人格在 Next 私有运行时目录中映射 provider voice；未知人格返回 400。

### 7.3 防滥用与缓存

- 试听文案由服务端固定，用户不能提交任意文本。
- 文案控制在 80 个中文字符以内。
- 音频缓存到 `/app/data/tutor-previews`，该目录使用现有 `a3-frontend-data` 持久卷。
- 缓存键由 provider、model、voice、文案和策略版本哈希组成，不包含 API key。
- 同键请求合并，防止并发重复付费调用。
- 单次生成超时 15 秒。
- 响应使用私有缓存头；失败结果不写入长期缓存。

### 7.4 前端交互

- 每个人格项提供播放图标按钮和 tooltip。
- 点击当前试听按钮可停止；点击另一人格先停止当前音频再播放。
- 显示加载、播放、不可用和失败重试状态。
- 组件卸载时暂停音频并释放 object URL。
- 试听不自动改变选中人格。

## 8. OpenMAIC 课堂 Handoff

### 8.1 数据流

```text
A3 推荐页触发课堂生成
-> Next 服务端读取当前登录用户导师偏好
-> Django 返回已启用人格的公开快照
-> Next 只把 allowlisted personaId 传入课堂生成器
-> 生成器从私有运行时目录解析教学策略
-> 教学策略影响课堂 requirement 和主讲 Agent 生成
-> Stage 写入公开 tutorPersona 快照
-> artifact 回写同一公开快照
-> OpenMAIC 课堂展示“主讲方式”
```

客户端传入的 `learnerProfileSnapshot` 或资源包内容不能覆盖人格快照。人格偏好必须由已认证服务端读取。

### 8.2 Stage 契约

`Stage` 增加可选字段：

```json
{
  "a3Context": {
    "tutorPersona": {
      "id": "foundation-coach",
      "name": "基础补强",
      "teachingStyle": "foundation",
      "avatarAssetId": "teacher-default-v1",
      "voiceProfileId": "voice-patient-coach",
      "schemaVersion": "a3.tutor-persona.v1"
    },
    "fallbackUsed": false
  }
}
```

Stage 和 artifact 不包含私有 prompt、provider voice、API key 或本地路径。

### 8.3 教学行为

- `GenerateClassroomInput` 接受受控 `a3TutorPersonaId`。
- `/api/generate-classroom` 对未知 ID 返回 400；缺失 ID 使用默认人格。
- 课堂 requirement 加入服务端解析的教学策略，而不是前端自然语言描述。
- 生成的主讲 Agent 使用与人格一致的公开 persona 描述。
- OpenMAIC 圆桌其他 Agent 保持独立，不被替换为 A3 导师人格。
- 旧课堂没有 `a3Context` 时继续正常打开。

### 8.4 Artifact

`openmaic_classroom` artifact 增加公开 `tutorPersona` 和 `fallbackUsed`。queued、running、succeeded、failed 各状态都保留生成时快照，保证审计一致。

## 9. 学生反馈

会话结束或总结完成后，在面对面辅导页显示紧凑反馈区：

- 1-5 分。
- 固定标签：`讲解清楚`、`节奏合适`、`帮助理解`、`仍然困惑`。
- 提交后提供成功反馈；允许修改。
- 不要求自由文本，避免增加内容审核和隐私风险。

接口：

```http
POST /api/learning/coaching/sessions/<session_id>/tutor-feedback/
{
  "rating": 4,
  "tags": ["讲解清楚", "帮助理解"]
}
```

服务端从会话快照提取 `persona_id`，不信任客户端提交的人格 ID。

## 10. 管理员导师中心

### 10.1 路由和导航

- 新增 `/a3/admin/tutors`。
- 在管理员侧栏增加“导师管理”一级入口。
- 页面使用现有 `AdminConsoleLayout`、`AdminAccessGuard`、状态徽标、原因对话框和审计规范。

### 10.2 页面结构

采用已确认的平衡型工作台：

1. 页面头和 `7d / 30d / 90d` 范围控件。
2. 核心指标条：启用人格、会话数、引用验证率、满意度。
3. 主区左侧：人格管理表；右侧：VRM 资产与 provider 状态。
4. 下方：采用趋势、会话质量、反馈和测评关联分析。

不使用大面积营销卡片，不嵌套卡片，不显示学生姓名或对话正文。

### 10.3 管理接口

```http
GET /api/admin/tutors/?range=7d|30d|90d

PATCH /api/admin/tutors/personas/<persona_id>/
{
  "enabled": true,
  "avatarAssetId": "teacher-default-v1",
  "voicePreviewEnabled": true,
  "reason": "更新导师视觉绑定"
}
```

PATCH 只允许已知人格和已登记、已启用的资产。每次变更记录 before、after、理由、管理员和 IP；敏感字段不进入审计日志。

音色试听复用 `/api/a3/tutors/voice-preview`，管理员身份同样需要 Django 校验。

## 11. 统计指标与口径

### 11.1 运营与质量指标

| 指标 | 定义 |
|---|---|
| 人格采用率 | 带有效人格快照的辅导会话 / 周期内全部辅导会话 |
| 人格会话数 | 按 `CoachingSession.metadata.tutorPersona.id` 分组 |
| 平均追问轮次 | 每会话学生消息数平均值 |
| 引用验证率 | `verified=true` 的 assistant 消息 / assistant 消息总数 |
| 正常结束率 | `status=ended` 的会话 / 已结束或活动会话总数 |
| 满意度 | 有效反馈的平均评分，显示反馈样本数 |
| 反馈覆盖率 | 有反馈会话 / 可反馈的已结束会话 |
| 运行降级率 | `fallbackUsed=true` 的人格会话 / 人格会话总数 |

### 11.2 辅导后测评变化

对每次人格辅导会话寻找：

- 同一学生、同一知识点在会话前 7 天的最近一次有效测评分数。
- 同一学生、同一知识点在会话后 7 天的首次有效测评分数。
- 无知识点关联时不做跨主题配对。

聚合返回：

- 平均分数变化。
- 正向、持平、负向样本数。
- 有效配对样本数。
- 数据覆盖率。
- `dataStatus`。

少于 5 对有效样本时 `dataStatus=insufficient_sample`，页面显示“样本不足”，不显示 0 或虚假提升。页面固定显示“观察到的相关性，不代表因果关系”。

### 11.3 数据状态

所有指标必须返回：

- `collected`
- `partial`
- `not_collected`
- `insufficient_sample`

不能用 0 代替未采集或样本不足。

### 11.4 性能

- 管理统计缓存 60 秒，配置和反馈更新后使相关缓存失效。
- 聚合查询按周期限制为 7、30、90 天。
- 使用已有会话、消息、学习事件索引；新增反馈表索引。
- 批量读取测评事件后在服务层配对，避免逐会话 N+1 查询。
- 管理页默认 30 秒刷新 provider 状态，统计数据不高频重算。

## 12. 权限与安全

- 学生只能读取公开人格、试听启用人格、提交自己的会话反馈。
- 教师不能访问管理员导师配置接口。
- 管理员只能修改启停、资产绑定和试听开关。
- 私有 prompt、provider voice 和 API key 永远不进入公开 serializer、Stage、artifact、审计日志或浏览器状态。
- 所有人格和资产 ID 使用 allowlist 校验。
- VRM 路径必须是固定静态相对路径，禁止协议 URL、绝对路径和路径穿越。
- 至少保留一个启用人格和一个可用默认资产。
- 管理变更必须有理由并写入 `AdminAuditLog`。
- 试听接口固定文案、登录校验、速率限制和超时，不能作为开放 TTS 代理。

## 13. 错误与降级

| 场景 | 行为 |
|---|---|
| 未配置 TTS | 试听按钮显示不可用，接口返回 503 中文错误 |
| TTS 超时或 provider 失败 | 保留当前选择，允许重试，不改变人格偏好 |
| 人格被停用 | 新会话回退启用的默认人格，历史会话不变 |
| VRM 资产失败 | 同一 Canvas 回退 `teacher-default-v1` 或静态 fallback |
| 管理接口并发修改 | 使用事务和更新时间校验，返回可读冲突信息 |
| Handoff 无法读取偏好 | 使用默认人格并记录 `fallbackUsed=true` |
| Handoff 未知人格 | 直接拒绝 400，不接受任意描述 |
| 统计无数据 | 返回明确 `dataStatus`，页面显示空状态 |
| 测评样本不足 | 显示样本不足，不显示效果提升值 |

## 14. 测试与验收

### 14.1 后端

- 模型约束、默认资产迁移和许可证字段。
- 人格配置权限、最后一个启用人格保护、资产绑定校验。
- 管理变更审计和敏感字段清理。
- 学生反馈所有权、评分/标签校验和 update-or-create。
- 统计口径、数据状态、缓存失效和测评配对。
- 已停用人格的历史会话兼容。

### 14.2 Next/前端

- 音色试听鉴权、固定文本、allowlist、provider 选择、缓存和错误状态。
- 试听按钮播放、停止、切换、资源释放和不可用状态。
- OpenMAIC 生成接口服务端读取人格，客户端不能覆盖。
- Stage 和 artifact 包含公开快照且不包含私有字段。
- 管理页面 loading、error、empty、partial、insufficient sample 状态。
- 管理导航只对管理员显示。
- 单页面始终只有一个 Canvas 和一个活动 VRM。

### 14.3 回归

- 现有导师人格 21 个前端测试和 14 个后端测试继续通过。
- OpenMAIC classroom bridge、artifact history、handoff sync、page ownership 测试通过。
- 数字人 avatar/runtime/realtime 合同测试通过。
- `npx tsc --noEmit`、`pnpm lint`、Django `check` 通过。
- migration 可在空库和现有生产数据上执行。

### 14.4 视觉验收

- 管理页桌面和移动端无重叠、横向溢出或文字截断。
- 人格表和资产状态可扫描，不使用卡片堆叠填满页面。
- VRM 切换不重建 Canvas，加载过程中画面不空白。
- 试听控件具有稳定尺寸，不因状态文字改变布局。

## 15. 部署影响

- 后端镜像：新增 models、migration、管理接口、统计和管理命令。
- 前端镜像：新增试听 route、Stage 契约、管理页、导航和 VRM 解析。
- MySQL：执行 migration，首次登记默认资产与四种人格配置。
- 前端持久卷：复用 `a3-frontend-data` 保存试听缓存。
- 不需要 GPU。
- 当前没有新 VRM 文件，因此镜像大小不会因本批显著增长。
- 新增授权 VRM 时需重新构建前端镜像，并在部署后登记资产。

## 16. 明确交付边界

本批完成后可以真实声明：

- 四种导师人格可试听、可启停、可绑定受控 VRM。
- A3 生成 OpenMAIC 课堂时导师人格会进入生成策略、Stage 和 artifact。
- 管理员能查看人格运行、资产授权状态和聚合效果指标。
- 学生能提交会话反馈，管理员能看到真实样本量。
- 系统具备接入第二套授权 VRM 的工程能力。

本批完成后仍不能声明：

- 当前已经拥有多套不同外观的数字人。
- 某种人格必然提升学习成绩。
- 科大讯飞或其他厂商已经提供或授权了本项目的 VRM 文件。
