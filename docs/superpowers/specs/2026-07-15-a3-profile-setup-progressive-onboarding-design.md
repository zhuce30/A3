# A3 学习设置渐进式引导设计

日期：2026-07-15

状态：待用户复核

页面：`/a3/profile-setup`

## 1. 背景与问题

真实用户反馈集中在四点：

1. 第一次进入时不知道页面要完成什么，也不理解“画像”“动机”等术语。
2. 当前入口要求用户用一句话同时说明目标、基础、薄弱点、时间和偏好，思考成本过高。
3. 用户希望通过填写示例、焦点提示和短动效理解操作，而不是阅读抽象说明。
4. 页面在宽度变化时信息被压缩，文字和卡片拥挤，主操作不突出。

当前实现把首次引导、自然语言访谈、详细资料编辑、动态画像分析和 Agent 审计证据放在同一页面。用户尚未完成第一个任务，就需要理解系统内部概念和多个并列操作。这是认知负担的主要来源，不是单纯的视觉样式问题。

## 2. 目标

将首次学习设置改为选择题为主、自然语言为辅的渐进式流程，使学生能够：

- 在约 2 分钟内完成进入诊断所需的最小学习设置。
- 不理解“画像、认知风格、动机风险、Agent、trace”等术语也能完成操作。
- 不清楚基础水平或薄弱点时，明确选择“交给诊断判断”，不被迫编造答案。
- 在提交前确认系统理解的内容，修改错误抽取或选择。
- 完成后直接进入真实的入学诊断，由诊断结果写回基础水平和薄弱点并刷新路径、计划。

## 3. 非目标

- 不重写 AgentKernel。
- 不新增前端 mock，不在前端伪造画像、诊断、路径或计划结果。
- 不更换现有认证、Cookie、CSRF 和 API base URL 机制。
- 不删除自然语言画像访谈能力。
- 不在本批次重做动态画像算法、教师工作台或学习报告。
- 不把技术审计信息继续暴露在首次引导主流程中。

## 4. 核心设计决策

### 4.1 同一路由区分两种使用状态

`/a3/profile-setup` 保持路由不变，根据用户状态展示不同界面：

- `profileCompleted === false`：首次渐进式引导。
- `profileCompleted === true`：详细资料编辑与画像变化管理。

首次引导只呈现当前问题、简要进度和当前答案摘要。动态画像、更新记录和技术证据不参与首次引导。

再次访问时展示结构化资料编辑器，可以保留动态画像摘要和画像更新确认，但 `Agent 决策证据` 移至 `/a3/capabilities`。

### 4.2 首次引导采用四步流程

#### 第 1 步：学习背景与目标

用户可见问题：

- 你现在是哪个年级？
- 你的专业方向是什么？
- 学习这门课最想解决什么？

学习目标使用具体选项，例如课程同步、期末复习、补齐基础、考研准备、完成项目。实际选项全部来自 `/api/profiles/options/`；本批次不增加绕过后端允许值的自由文本目标，“其他”也只在后端明确返回该选项时展示。

#### 第 2 步：当前学习情况

用户可见问题：

- 你目前学到什么程度？
- 哪些内容最容易卡住？

基础水平采用行为描述，不使用抽象等级：

- 刚开始接触。
- 听过课程，但独立做题困难。
- 能完成基础题。
- 能处理综合题和实践任务。
- 不确定，让入学诊断判断。

薄弱点允许选择“不确定，让入学诊断判断”。该选择只影响界面状态，不作为假的弱点字符串写入数据库。

#### 第 3 步：时间与学习方式

用户可见问题：

- 每天通常能投入多少时间？
- 哪种讲解方式更容易看懂？
- 希望系统优先推荐哪类资料？

必须区分两个后端字段：

- `learningPreferences`：图解、逐步例题、由浅入深、实操案例等学习方式。
- `expectedResources`：视频课程、课件讲义、练习题库、代码实验等资源载体。

前端只能提交 `GET /api/profiles/options/` 返回的允许值，不在组件内硬编码生产选项。

#### 第 4 步：确认系统理解

标题使用“我理解的是”，逐项展示：

- 年级与专业方向。
- 当前学习目标。
- 用户自评基础，或“待入学诊断判断”。
- 已知薄弱点，或“待入学诊断判断”。
- 每日时间。
- 学习方式和资源类型。

每一项都有“修改”入口。主按钮为“保存并开始入学诊断”。

### 4.3 自然语言访谈作为可选模式

首次引导顶部提供分段模式选择：

- `逐步选择`，默认且推荐。
- `直接描述`，调用现有画像访谈接口。

直接描述模式必须遵守以下规则：

- 用户消息调用 `POST /api/profile/interview/`，请求体为 `{ "message": "..." }`。
- 确认调用同一路径，请求体为 `{ "action": "confirm" }`。
- 会话恢复调用 `GET /api/profile/interview/session/`。
- 前端只展示后端返回的 `profile`、`missingDimensions`、`nextQuestion`、`interviewComplete` 和 `interviewSession`，不在本地伪造完成状态。
- 内部字段 `motivationRisk`、`cognitiveStyle` 等保持不变，但用户可见追问改成具体生活语言，例如“最近坚持学习时最容易遇到什么困难？”。
- 抽取结果统一进入第 4 步确认页，用户确认后才能结束首次设置。
- 如果服务端返回 `interviewComplete = true`，第四步调用 `{ "action": "confirm" }` 完成访谈确认。
- 如果访谈仍不完整，但已抽取字段与用户在第四步补充的结构化选择满足 `diagnostic_ready`，第四步改走结构化保存接口；此时不调用访谈 confirm，也不伪造 `profileCommitted`。

## 5. 页面信息架构

### 5.1 首次访问

```text
智学引擎                              退出/帮助

设置你的学习方式                     第 1 / 4 步
用约 2 分钟回答几组问题，不确定的内容可以交给诊断判断。

[逐步选择] [直接描述]

你学习这门课最想解决什么？
[跟上课程] [准备考试] [考研复习]
[补齐基础] [完成项目]

[查看填写示例]

                        [下一步：当前学习情况]
```

桌面端可在右侧显示窄版“当前答案”摘要。移动端不保留右栏，摘要在步骤标题下折叠展示。

### 5.2 再次访问

再次访问不重新播放首次引导，展示：

1. 当前学习设置摘要。
2. 编辑基础资料、目标、时间、偏好和资源类型。
3. 由诊断和学习行为形成的画像变化，允许确认或忽略。
4. 前往入学诊断、学习计划和报告的明确入口。

## 6. 文案规范

首次引导禁止出现：

- 画像与规划输入。
- 动机风险。
- 认知风格。
- 事件记忆。
- Agent 决策证据。
- trace、provider、schema version。

推荐文案：

- 页面标题：`设置你的学习方式`
- 页面说明：`用约 2 分钟回答几组问题，我们会据此安排入学诊断和后续学习。`
- 不确定选项：`不确定，让入学诊断判断`
- 最终按钮：`保存并开始入学诊断`
- 成功提示：`学习设置已保存，接下来通过几道题确认你的起点。`

## 7. 示例与动效

### 7.1 填写示例

“查看填写示例”采用页面内展开，不使用阻断式弹窗。示例展示一名真实学生从选择目标到确认摘要的短流程。

选项帮助必须同时支持：

- 鼠标 hover。
- 键盘 focus。
- 触屏 tap。

桌面端可使用不改变布局尺寸的浮层；移动端在选项下方原位展开。不能只依赖 hover。

### 7.2 动效约束

- 步骤切换：180 至 250 毫秒淡入和轻微位移。
- 选中反馈：勾选图标、边框和摘要同步变化。
- 保存状态：按钮内加载状态，避免整个页面遮罩。
- 尊重 `prefers-reduced-motion`。
- 不增加装饰性长动画，不让用户等待页面编排播放。

## 8. 响应式设计

- 页面内容最大宽度控制在 1040 至 1120 像素。
- 大屏使用 `minmax(0, 1fr) 300px` 的稳定两栏。
- 小于 1100 像素切换为单栏，不压缩右侧摘要。
- 手机端只显示“第 N / 4 步”，不展示四张并排进度卡。
- 主操作区可固定在底部，但必须预留内容和安全区高度，不能覆盖选项。
- 关键答案不使用 `line-clamp` 截断。
- 所有文本允许自然换行，选项设置稳定的最小高度。
- 焦点提示通过浮层或原位展开呈现，不能挤压相邻网格导致比例变化。

## 9. Agent 与 API 契约

### 9.1 不变的接口路径

| 用途 | 方法 | 路径 | 约束 |
|---|---|---|---|
| 读取允许选项 | GET | `/api/profiles/options/` | 前端选项唯一数据源 |
| 保存结构化设置 | POST | `/api/profiles/learning-profile/` | 继续进入 `profile_setup` Agent 工作流 |
| 发送访谈消息 | POST | `/api/profile/interview/` | `{ message }`，继续进入 `profile_interview` 工作流 |
| 确认访谈 | POST | `/api/profile/interview/` | `{ action: "confirm" }` |
| 恢复访谈 | GET | `/api/profile/interview/session/` | 恢复真实后端会话 |
| 获取诊断题 | GET | `/api/learning/admission-diagnostic/` | 读取画像后生成诊断蓝图 |
| 提交诊断 | POST | `/api/learning/admission-diagnostic/` | 运行诊断、画像写回、路径和计划生成 |
| 动态画像 | GET | `/api/profiles/dynamic-profile/` | 仅再次访问模式使用 |

所有请求继续使用 `a3GetJson`、`a3PostJson`、Cookie 和 CSRF，不新增浏览器直连内部容器地址。

### 9.2 Agent 序列不变

结构化设置：

```text
ProfileNormalizeAgent
-> ProfileCommitAgent
-> PlannerAgent
-> StudyPlanAgent
```

自然语言访谈：

```text
SafetyAgent
-> ProfileInterviewAgent
-> LearnerModelAgent
-> MemoryCommitAgent
-> PlannerAgent
```

入学诊断：

```text
DiagnosticAgent
-> ProfileUpdateAgent
-> PlannerAgent
-> StudyPlanAgent
```

### 9.3 兼容性扩展

首次分步引导对 `POST /api/profiles/learning-profile/` 增加一个可选请求字段：

```json
{
  "completionMode": "diagnostic_ready"
}
```

兼容规则：

- 未传 `completionMode` 时，继续执行现有完整字段校验和路径、计划生成，保证旧调用和再次编辑行为不变。
- `completionMode = "diagnostic_ready"` 时，允许 `foundationLevel`、`weakPoints` 和 `pace` 暂缺，但年级、专业方向、学习目标、每日时间、学习偏好和资源类型仍必须有效。
- 暂缺字段必须保存为空值，不得写入“待诊断”“不知道”等假数据。
- `User.profile_completed` 表示首次设置达到可诊断状态，不再等同于完整画像所有维度均已填写。
- `profileReadiness` 保持现有完整画像评分语义。
- 新增 `setupReadiness` 作为附加响应字段，不删除或重命名现有响应字段。

建议附加响应：

```json
{
  "success": true,
  "setupReadiness": {
    "status": "ready_for_diagnostic",
    "missingRequiredFields": [],
    "deferredDimensions": ["foundationLevel", "weakPoints", "pace"]
  },
  "profileReadiness": {
    "status": "partial"
  },
  "generated": {
    "path": false,
    "studyPlan": false
  },
  "nextAction": {
    "href": "/a3/admission-diagnostic"
  }
}
```

### 9.4 Agent 延迟生成规则

`completionMode = "diagnostic_ready"` 不绕过 Agent 序列：

- `ProfileNormalizeAgent` 校验并记录最小设置模式。
- `ProfileCommitAgent` 保存真实字段并产生 `setupReadiness`。
- `PlannerAgent` 仍执行，但返回 `planningDeferred: true`，证据原因为 `awaiting_admission_diagnostic`，不生成误导性的正式路径。
- `StudyPlanAgent` 仍执行，但返回 `studyPlanDeferred: true`，不生成诊断前的正式计划。

未传该模式时两个 Agent 保持现有行为。

入学诊断提交后仍由现有 `DiagnosticAgent` 判分并写入 `foundation_level`、`weak_points` 和 `daily_study_time`，随后由 `PlannerAgent`、`StudyPlanAgent` 生成正式路径和计划。

### 9.5 自然语言访谈兼容规则

- 保持 `PROFILE_INTERVIEW_WORKFLOW_SEQUENCE` 和会话 schema 不变。
- 保持 `message`、`action: confirm` 请求体不变。
- 保持 `traceId`、`profileReadiness`、`missingDimensions`、`askFields`、`nextQuestion`、`interviewSession` 和 `generated` 字段。
- 只调整用户可见问题文案，不把内部字段名直接展示给学生。
- 前端确认按钮必须以服务端 `interviewComplete` 为准。
- Agent 或模型失败时展示后端错误，并允许切换到逐步选择模式；不能在前端假定成功。
- `ProfileInterviewPlannerAgent` 继续执行并保留现有输出字段，但在首次设置期间不提前生成正式路径和计划；`message` 和 `confirm` 均返回兼容形状的 `generated` 字段，并在 evidence 中记录 `awaiting_admission_diagnostic`。
- 完整访谈确认仍负责写入 `profileCommitted` 和真实 session 状态；路径和计划统一由后续入学诊断刷新。

## 10. 数据流

### 10.1 逐步选择

```text
GET /api/profiles/options/
-> 用户完成四步选择
-> 第四步确认
-> POST /api/profiles/learning-profile/
   completionMode=diagnostic_ready
-> profile_setup Agent trace
-> 返回 setupReadiness + nextAction
-> /a3/admission-diagnostic
-> POST /api/learning/admission-diagnostic/
-> DiagnosticAgent 写回基础和薄弱点
-> PlannerAgent + StudyPlanAgent 生成正式路径和计划
```

### 10.2 直接描述

```text
GET /api/profile/interview/session/
-> POST /api/profile/interview/ {message}
-> 展示服务端抽取和追问
-> 用户继续补充或切回逐步选择
-> interviewComplete=true:
   POST /api/profile/interview/ {action: confirm}
   使用服务端 profileCommitted 判断结果
-> interviewComplete=false 但结构化最低设置已补齐:
   POST /api/profiles/learning-profile/ {completionMode: diagnostic_ready}
   不伪造访谈确认状态
-> /a3/admission-diagnostic
```

## 11. 错误与边界状态

- 选项加载失败：显示“暂时无法加载学习选项”，提供重试，不展示硬编码生产选项。
- 未登录：沿用后端 401 和现有认证导航。
- 保存 400：显示后端中文错误，并定位到对应步骤。
- Agent 超时或熔断：保留用户当前选择，允许重试或切换模式。
- 访谈抽取不完整：展示具体下一问，不展示内部缺失字段名。
- 页面刷新：从已保存画像和后端访谈 session 恢复；未提交的逐步选择可使用当前标签页级临时状态，但不能当作服务端已保存证据。
- 返回上一步：保留当前选择，不立即触发正式路径和计划生成。
- 不确定选项：只设置 UI 的 deferred 状态，不写入假值。

## 12. 组件边界

建议从当前大文件中拆出以下组件：

- `profile-setup-first-run.tsx`：首次流程容器和步骤状态。
- `profile-setup-mode-switch.tsx`：逐步选择/直接描述分段控制。
- `profile-setup-step.tsx`：通用问题、选项和说明。
- `profile-setup-summary.tsx`：第四步确认与桌面摘要。
- `profile-setup-example.tsx`：可访问的填写示例和短动效。
- `profile-settings-editor.tsx`：再次访问时的详细字段编辑。
- `profile-interview-panel.tsx`：封装现有真实访谈接口和会话恢复。

`a3-auth-pages.tsx` 只负责路由级数据加载和模式选择，避免继续扩大单文件职责。

## 13. 测试与验收

### 13.1 前端单元测试

- 首次空画像不自动选择任何答案。
- 四步字段映射正确，学习方式和资源类型不混用。
- “不确定”不进入提交字段。
- `completionMode` 只在首次渐进式流程中提交。
- 再次编辑保持旧请求格式。
- 访谈完成状态只读取后端 `interviewComplete`。
- 未完成访谈转结构化保存时，不调用 `action: confirm`。

### 13.2 后端契约测试

- 旧完整 payload 行为不变，仍运行完整 `PROFILE_SETUP_WORKFLOW_SEQUENCE`。
- `diagnostic_ready` 接受允许暂缺的字段，拒绝真正必填字段缺失。
- `diagnostic_ready` 不写入假弱点或假基础值。
- `diagnostic_ready` 的 Planner 和 StudyPlan step 存在于 trace，并明确标记 deferred。
- 诊断提交继续运行完整 `ADMISSION_DIAGNOSTIC_WORKFLOW_SEQUENCE`。
- 诊断后基础水平、薄弱点、路径和计划真实写回。
- 画像访谈 message、confirm、session 三个契约保持兼容。
- 画像访谈 Planner step 保留在 trace 中，诊断前只返回 deferred 证据。

### 13.3 Playwright

- 新用户逐步选择完成后进入入学诊断。
- 用户选择“不确定”仍可继续，诊断后画像被补齐。
- 直接描述模式完成多轮追问并恢复 session。
- Agent 错误时可以切换回逐步选择且答案不丢失。
- 再次访问进入详细编辑模式，不重复首次引导。
- 390、768、1100、1440 像素无横向滚动、重叠或操作区遮挡。
- hover、focus、tap 均能查看示例。

### 13.4 基础验证

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/a3-profile-setup.test.ts tests/a3-real-user-polish-regressions.test.ts
npx.cmd playwright test e2e/tests/a3-profile-interview-loop.spec.ts e2e/tests/a3-mobile-flow.spec.ts --project=chromium

cd ..
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.profiles.tests.test_profile_settings backend.apps.compat.tests.test_a3_requirements_deep_fill backend.apps.learning.tests.test_path_planner
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

## 14. 完成标准

- 首次页面没有画像、Agent、trace、动机风险等内部术语。
- 用户不需要自判薄弱点也能进入真实诊断。
- 没有任何未明确提供的年级、基础或偏好被自动填入。
- 所有生产选项来自 `/api/profiles/options/`。
- 两种输入模式均调用真实 Django 接口。
- Agent 工作流名称、顺序、trace 和关键响应字段保持可验证。
- 诊断结果真实写回画像并生成路径、计划。
- 移动端和桌面端主操作明确，无布局挤压和遮挡。

## 15. 实施顺序

1. 先增加后端 `completionMode`、`setupReadiness` 和 Agent deferred 契约测试。
2. 再实现首次/再次访问双模式和四步状态机。
3. 接入现有访谈接口，保持 message、confirm、session 契约。
4. 调整用户可见追问文案，不修改内部字段名。
5. 完成示例、焦点提示、动效和响应式。
6. 跑完整前后端契约与端到端测试后再提交部署。
