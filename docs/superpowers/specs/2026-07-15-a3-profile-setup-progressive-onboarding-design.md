# A3 对话式学习画像构建设计

日期：2026-07-15

状态：已确认，按赛题原文修订

页面：`/a3/profile-setup`

## 1. 赛题约束

本功能直接对应以下要求：

> 对话式学习画像自主构建：摒弃传统繁琐表单，支持通过自然语言对话，结合学生专业、学习目标、学习历史等自动抽取特征，构建包含不少于 6 个维度的动态学生画像，并支持画像随学随新。

因此，首次画像构建必须满足四个不可替代的验收条件：

1. 自然语言对话是默认主入口，不是隐藏在表单后的可选功能。
2. 特征由后端画像访谈工作流自动抽取，前端不能根据关键词伪造画像。
3. 页面持续展示不少于 6 个画像维度的识别进度，并允许学生确认或继续补充。
4. 入学诊断、错题和学习行为继续写回同一画像，首次设置不是一次性静态表单。

## 2. 当前问题

当前页面同时承载详细资料表单、画像访谈、动态画像、Agent 证据和规划结果，首次用户需要理解大量内部概念。此前提出的“四步选择向导为默认入口”虽然降低了填写难度，但会重新落入表单主导，也会弱化“自然语言自动抽取”这一赛题核心证据。

修订后的设计保留逐项选择能力，但只把它作为对话失败、用户不愿输入长文本时的辅助路径。

## 3. 设计目标

- 用户进入页面后能直接用自己的话描述学习情况。
- 系统按轮次自动抽取画像，并且一次只追问一个最重要的缺失信息。
- 页面用生活化语言展示 10 个已有画像维度，其中至少 6 个维度被识别后才可进入确认阶段。
- 未识别内容显示“待补充”或“交给入学诊断判断”，不得写入“未知”“待诊断”等假画像值。
- 用户确认后进入真实入学诊断；诊断再补齐基础水平和薄弱点，生成正式路径与计划。
- 后续学习行为通过现有动态画像机制持续更新，并保留来源、时间和确认记录。
- 不改变现有 Agent 名称、顺序、API 路径、Cookie、CSRF 或 Next API 代理机制。

## 4. 非目标

- 不重写 `AgentKernel`。
- 不新增前端 mock 或浏览器直连内部容器地址。
- 不新增一套与 `LearnerProfile` 并行的画像数据库模型。
- 不要求学生理解“认知风格”“动机风险”“trace”等内部术语。
- 不在诊断前生成缺少证据的正式学习路径和学习计划。
- 不在本批次重做教师工作台、报告页或画像聚合算法。

## 5. 核心交互

### 5.1 首次访问：对话优先

`profileCompleted === false` 时，页面默认显示对话模式：

```text
用几句话介绍你的学习情况                     已识别 4 / 10
可以说专业、目标、以前学过什么、哪里容易卡住。

[系统：先说说你为什么想学这门课？]
[用户：我是大二软件工程学生……]
[系统：你每天通常能安排多长时间？]

[输入框........................................]
[查看示例]                              [发送]

当前理解
专业与阶段              已识别
学习目标                已识别
学习经历                已识别
每天可用时间            待补充
当前基础                待补充
容易卡住的内容          待补充
更容易理解的讲解方式    已识别
希望获得的资料          待补充
学习节奏                待诊断
坚持学习时的困难        待补充
```

桌面端使用“对话主区域 + 当前理解窄侧栏”。移动端侧栏变成对话下方的可展开区域，不能覆盖输入框或发送按钮。

### 5.2 自动抽取与追问

每条用户消息调用现有：

```http
POST /api/profile/interview/
Content-Type: application/json

{"message": "学生输入"}
```

前端只消费服务端返回的：

- `profile`
- `profileReadiness.dimensionCount`
- `missingDimensions`
- `askFields`
- `nextQuestion`
- `interviewComplete`
- `interviewSession`
- `traceId`

`ProfileInterviewAgent` 和 `LearnerModelAgent` 负责自动抽取。追问按现有计划关键维度优先级排序，每轮只显示一个自然语言问题；内部字段名不得直接显示。

### 5.3 不少于 6 个维度

继续使用现有 `a3.profile-interview.profile.v2` 画像结构，不新增冲突 schema。用户可见映射如下：

| 服务端字段 | 用户可见名称 | 示例来源 |
|---|---|---|
| `grade` | 年级阶段 | 用户对话 |
| `majorDirection` | 专业方向 | 用户对话 |
| `learningGoals` | 学习目标 | 用户对话 |
| `learningHistory` | 学习经历 | 用户对话 |
| `foundationLevel` | 当前基础 | 用户自述或入学诊断 |
| `weakPoints` | 容易卡住的内容 | 用户自述、诊断或错题 |
| `dailyMinutes` | 每天可用时间 | 用户对话 |
| `resourcePreferences` | 希望获得的资料 | 用户对话和后续行为 |
| `cognitiveStyle` | 更容易理解的讲解方式 | 用户对话和后续行为 |
| `motivationRisk` | 坚持学习时的困难 | 用户对话和任务行为 |

服务端当前以 10 个维度计算 `dimensionCount`。首次确认必须依赖服务端 `interviewComplete`，前端不得自行把“显示了 6 张卡片”当作画像已完成。赛题的“不少于 6 个维度”通过页面、接口返回和测试共同证明；完整访谈仍按后端现有完整度规则执行。

### 5.4 画像状态

前端状态只能从服务端值推导：

- 字段有真实值且不在 `missingDimensions`：`已识别`。
- 字段位于 `missingDimensions`：`待补充`。
- 基础水平或薄弱点由用户明确选择交给诊断：`待诊断`，数据库仍保存空值。
- 服务端返回 `interviewComplete=true`：显示“可以确认”。
- 服务端确认返回 `profileCommitted=true`：才允许跳转入学诊断。

这些状态是展示状态，不写成画像字段值。

### 5.5 辅助入口：逐项确认

页面提供次级入口“我不想打字，逐项确认”。它采用四步渐进选择：

1. 年级、专业和目标。
2. 自评基础与已知薄弱点，可选择交给诊断判断。
3. 每日时间、学习方式和资源偏好。
4. 确认系统理解。

该入口的生产选项全部来自 `GET /api/profiles/options/`，并通过：

```http
POST /api/profiles/learning-profile/

{"completionMode": "diagnostic_ready", "...": "真实选择"}
```

`diagnostic_ready` 只属于辅助入口。未传该字段时，原有完整资料保存、路径生成和计划生成行为保持不变。

### 5.6 再次访问

`profileCompleted === true` 时继续展示详细资料编辑器和动态画像变化，不重复首次访谈。技术审计证据移到 `/a3/capabilities`，学生页只展示可理解的画像变化、来源和下一步动作。

## 6. Agent 与 API 契约

### 6.1 路径不变

| 用途 | 方法 | 路径 |
|---|---|---|
| 恢复对话 | GET | `/api/profile/interview/session/` |
| 发送消息 | POST | `/api/profile/interview/`，请求 `{message}` |
| 确认访谈 | POST | `/api/profile/interview/`，请求 `{action: "confirm"}` |
| 读取辅助选项 | GET | `/api/profiles/options/` |
| 保存辅助选择 | POST | `/api/profiles/learning-profile/` |
| 读取诊断 | GET | `/api/learning/admission-diagnostic/` |
| 提交诊断 | POST | `/api/learning/admission-diagnostic/` |
| 读取动态画像 | GET | `/api/profiles/dynamic-profile/` |

### 6.2 Agent 顺序不变

自然语言访谈：

```text
SafetyAgent
-> ProfileInterviewAgent
-> LearnerModelAgent
-> MemoryCommitAgent
-> PlannerAgent
```

辅助逐项确认：

```text
ProfileNormalizeAgent
-> ProfileCommitAgent
-> PlannerAgent
-> StudyPlanAgent
```

入学诊断：

```text
DiagnosticAgent
-> ProfileUpdateAgent
-> PlannerAgent
-> StudyPlanAgent
```

访谈和辅助入口在诊断前均保留 Planner step，但返回 `awaiting_admission_diagnostic` 的 deferred 证据，不生成误导性的正式路径与计划。

## 7. 数据流

### 7.1 默认对话链路

```text
GET /api/profile/interview/session/
-> 恢复真实服务端会话
-> POST /api/profile/interview/ {message}
-> Agent 自动抽取并合并画像
-> 页面更新维度数量、当前理解和下一问题
-> interviewComplete=true
-> POST /api/profile/interview/ {action: confirm}
-> profileCommitted=true
-> /a3/admission-diagnostic
```

### 7.2 逐项确认链路

```text
GET /api/profiles/options/
-> 四步选择
-> POST /api/profiles/learning-profile/ completionMode=diagnostic_ready
-> setupReadiness=ready_for_diagnostic
-> /a3/admission-diagnostic
```

### 7.3 随学随新链路

```text
入学诊断 / 错题 / 任务完成 / 学习偏好行为
-> 现有 profile signal / profile update 服务
-> LearnerProfile + extraProfile.dynamicProfile
-> 动态画像和报告重新聚合
-> 页面展示变化来源、时间与待确认项
```

本批次至少验证访谈抽取、入学诊断写回和一种后续学习信号，证明画像不是静态资料页。

## 8. 错误和降级

- 会话恢复失败：保留页面，显示“暂时无法恢复上次对话”，允许重试。
- 访谈消息失败：保留输入和历史消息，允许重试；提供“逐项确认”辅助入口。
- 模型不可用：继续使用现有规则提取降级路径，并在 trace 中记录 provider/degraded，前端不假装模型成功。
- 画像不完整：显示服务端 `nextQuestion`，不得本地强制完成。
- 确认失败：不跳转、不设置 `profileCommitted`。
- 选项加载失败：辅助入口显示重试，不提供硬编码生产选项。
- 页面刷新：从 `/api/profile/interview/session/` 恢复服务端消息和画像，不把浏览器临时状态当成已提交证据。

## 9. 文案与可访问性

首次页面避免显示“画像”“认知风格”“动机风险”“Agent”“trace”等术语，改为具体问题：

- “你以前学过哪些相关内容？”
- “做题时最容易卡在哪一步？”
- “看概念、跟着例题还是动手操作，哪种方式更容易理解？”
- “最近坚持学习时最容易遇到什么困难？”

输入框、发送按钮、模式切换和画像摘要必须支持键盘操作。消息区域有稳定高度并可滚动；使用 `aria-live` 通知新追问和保存结果；尊重 `prefers-reduced-motion`。

## 10. 响应式要求

- 桌面端最大宽度 1120 像素，主对话区与 300 像素摘要栏稳定分栏。
- 小于 960 像素切换单栏，画像摘要在对话下方折叠展示。
- 消息区、输入区和底部操作不能相互覆盖。
- 390、768、1100、1440 像素均不得出现横向滚动。
- 长专业名称、长目标和中文连续文本必须自然换行，不使用遮挡式 `line-clamp`。

## 11. 测试与验收

### 后端契约

- 多轮 `message` 请求保持并扩展前序画像，不丢失上下文。
- 一段包含专业、目标、经历、基础、时间和偏好的自然语言能抽取至少 6 个维度。
- `profileReadiness.dimensionCount`、`missingDimensions` 和 `interviewComplete` 来自服务端。
- `confirm` 只在完整时提交，返回真实 `profileCommitted`。
- 访谈和辅助入口的 Agent 顺序保持不变，诊断前规划明确 deferred。
- `diagnostic_ready` 不写入假基础、假薄弱点或假节奏。
- 入学诊断补齐画像并生成正式路径、计划。
- 后续学习信号能产生新的画像更新记录。

### 前端与端到端

- 首次访问默认聚焦自然语言输入，不默认显示四步选择表单。
- 每次服务端响应后，当前理解和维度数量同步变化。
- 页面展示至少 6 个不同画像维度，但不把空值显示为已识别。
- 只有真实 `interviewComplete/profileCommitted` 才能结束访谈。
- 用户可切换到逐项确认，生产选项来自真实接口。
- 刷新后能恢复会话。
- 移动端无横向滚动、遮挡或无法滚动的消息区域。

## 12. 完成标准

- 对话是首次画像构建的第一屏和默认主操作。
- 后端自动抽取证据可以通过 API、数据库和 Agent trace 验证。
- 画像包含 10 个既有维度，页面至少展示 6 个维度的真实识别状态。
- 未提供的信息不被自动填充，待诊断状态不作为画像值持久化。
- 逐项确认仅为辅助入口，不抢占对话主流程。
- 诊断、错题或学习行为能够更新同一画像，形成“随学随新”证据。
- 所有现有 API 路径、Agent 名称和步骤顺序保持兼容。
- 首次用户看不到内部技术术语，桌面端和移动端均可完成流程。
