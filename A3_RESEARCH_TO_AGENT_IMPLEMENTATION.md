# A3 调研结论到 Agent 落地路线

本文档把两份深度调研文档转化为 A3 项目的工程行动项：

- `面向个性化学习多智能体系统的学习软件深度调研报告.docx`
- `面向赛题A3的底层 Agent 框架论文深研报告.docx`

这两份文档应作为产品与技术路线的研究输入。由于其中部分赛题信息来自搜索摘要或二级转述，不能把所有表述直接当成官网原文。当前项目落地仍以 `AGENTS.md`、`A3_AGENT_ARCHITECTURE.md`、实际代码和可运行验证命令为准。

## 1. 总体结论

A3 不能做成“多页面 + 聊天框”的普通 AI demo。正确方向是：

```text
一个前台统一学习入口
+ 后台多 Agent 工作流
+ 本地课程知识库
+ 个性化画像记忆
+ 证据约束资源生成
+ 引导式答疑
+ 练习测评错题闭环
+ 教师端反馈干预
```

产品侧借鉴成熟学习软件，回答“用户为什么愿意持续使用”。技术侧借鉴 Agent 论文框架，回答“后台 Agent 如何可解释、可追踪、可评测地运行”。

## 2. 产品调研对 A3 的约束

### 2.1 成熟学习软件的共同能力

调研文档提炼出的成熟产品共性可以归纳为五点：

| 能力 | 对 A3 的要求 |
|---|---|
| 诊断驱动 | 先判断用户水平和薄弱点，再规划和推荐 |
| 来源绑定 | 所有学习资源尽量来自课程材料或知识库证据 |
| 高频小任务 | 每次学习任务控制在短时长、可完成、可反馈 |
| 错因闭环 | 测评错题必须回流画像、复习和推荐 |
| 教师可见 | 教师端能看到风险、进度、弱点并推送任务 |

这正好对应当前 A3 的主链路：

```text
画像 -> 诊断 -> 路径 -> 计划 -> 今日任务 -> 资源 -> 辅导 -> 测评 -> 错题 -> 复习 -> 报告 -> 教师干预
```

### 2.2 借鉴产品与工程映射

| 产品/方向 | 值得借鉴 | A3 落地点 |
|---|---|---|
| Khanmigo | 引导式答疑，不直接给答案；教师摘要 | TutorOrchestrationAgent、TeacherInterventionAgent |
| Quizlet | 笔记/材料转卡片、练习、测试 | ResourceSynthesisAgent、ResourcePack |
| NotebookLM | 来源绑定、基于用户材料生成 | RetrieverAgent、VerifierAgent、KnowledgeBase |
| Photomath | 分步骤讲解、多解法、即时支持 | AssessmentAgent、TutorOrchestrationAgent |
| Duolingo Max / Hi Echo | 低压力、短回合、情境化陪练 | 今日任务、陪练式辅导、即时反馈 |
| 科大讯飞学习机 | 诊断、规划、推荐、纠错闭环 | A3 主产品流程 |
| 学而思学习机 | 前台统一学伴，后台多场景能力 | 前台统一入口，后台 Agent Graph |
| 小猿学练机 | 知识图谱和学练测螺旋 | CurriculumGraphAgent、ReviewSchedulerAgent |

### 2.3 前台体验原则

前台不应该把所有 Agent 都显性展示给用户。成熟产品更常见的形态是：

```text
前台：一个稳定学习助手入口
后台：多个 Agent 协同完成画像、规划、生成、答疑、评测、复习、审校
```

A3 前台应重点收敛到三个高频入口：

| 入口 | 用户问题 | 后台 Agent |
|---|---|---|
| 今天学什么 | 今天该学什么、还差多少、完成后去哪 | StudyPlanAgent、ReviewSchedulerAgent |
| 不会就问 | 我卡在哪里、给我提示、再展开讲解 | SafetyAgent、RetrieverAgent、TutorOrchestrationAgent、VerifierAgent |
| 我的进步 | 我哪里进步了、哪里还弱、下一步怎么补 | AssessmentAgent、LearnerModelAgent、ReportAgent |

现有项目已经有多页面能力，但后续产品优化应把这些页面组织成上述三类入口，而不是继续堆功能页。

### 2.4 五类资源形态

调研中提到 A3 至少需要多类型资源生成。当前工程应优先把资源包收敛为五类：

| 资源类型 | 用途 | 第一阶段落地方式 |
|---|---|---|
| 课程摘要卡 | 快速复习核心概念 | `ResourcePackItem(type="summary_card")` |
| 知识点讲解页 | 系统学习一个知识点 | `ResourcePackItem(type="micro_lesson")` |
| 思维导图 | 展示知识点关系 | 先用结构化 graph JSON，后续前端可视化 |
| 针对性练习题 | 针对弱点练习 | 结合 Assessment 题库或生成题 |
| 错题复训包 | 错因复盘与再练 | 基于 WrongQuestion 和 reviewQueue |

音频讲解、短视频脚本、虚拟人视频教学属于第二阶段增强，不应优先于上述五类基础资源。

### 2.5 三道安全闸

| 安全闸 | 要求 | 当前/后续落地 |
|---|---|---|
| 学习内容闸 | 内容绑定知识库，重要断言可追溯 | RetrieverAgent + VerifierAgent |
| 教学行为闸 | 提示优先、答案后置、先问后讲 | TutorOrchestrationAgent 答疑策略 |
| 用户治理闸 | 隐私授权、最小必要信息、学生保护 | ProfileAgent + SafetyAgent + 权限控制 |

## 3. 论文调研对 Agent 技术栈的约束

### 3.1 推荐技术栈

调研报告建议的技术栈可以工程化为：

```text
DSPy: 模块化 LM 程序图与可评测框架
ReAct: Thought / Action / Observation 运行循环
Self-RAG: 检索、生成、批判和引用验证
Generative Agents: 记忆流、检索、反思，用于动态画像
Gorilla: 工具 schema、API 文档检索、参数校验
LATS: 仅用于高价值路径规划的树搜索增强
Reflexion: 失败后自我修正和二次改写
ProgPrompt: 结构化路径 DSL 的参考
MAT: 未来真正多 Agent 策略学习的研究方向
```

第一阶段不应完整复现这些论文。应提取可落地机制：

- DSPy 的“模块化、可评测、可优化”。
- ReAct 的“想、调工具、看结果、再想”。
- Self-RAG 的“检索决策、证据相关性、答案支撑度”。
- Generative Agents 的“事件记忆、重要性评分、反思摘要”。
- Gorilla 的“工具注册、参数校验、调用日志、回滚”。
- LATS 的“只在复杂规划时启用多方案搜索”。

### 3.2 技术栈到 A3 Agent 的映射

| 论文范式 | A3 模块 | 当前代码落点 | 第一阶段行动 |
|---|---|---|---|
| DSPy | Agent workflow registry 和可评测模块图 | `backend/apps/compat/agent_workflows.py` | 增加 workflow schema、评分指标、样例集 |
| ReAct | OrchestratorAgent 运行协议 | `backend/apps/compat/agent_runtime.py` | 增加 thought/action/observation metadata |
| Self-RAG | 证据约束生成与验证 | `backend/domains/knowledge_base/retriever.py`、`verification.py` | 增加 retrievalDecision、evidenceScore、claimSupport |
| Generative Agents | 动态学习画像与长期记忆 | `LearnerProfile.extra_profile`、未来 `LearningStateSnapshot` | 增加 learner events 和 memory summary |
| Gorilla | 工具调用和 API registry | 现有 service/API 分散 | 增加 ToolSpec/ToolCallLog/参数校验 |
| LATS | 复杂路径规划 | `learning/services.py` | 对路径生成增加候选方案和评分 |
| Reflexion | 失败恢复和自改进 | `AgentRun.metadata` | 失败后写入 reflection 和 retry suggestion |
| ProgPrompt | 路径 DSL | 未来 `LearningPathPlan` schema | 把计划表示成可执行任务图 |

### 3.3 当前已开始落地的部分

当前已完成第一步：

- `AgentRun` / `AgentStep` 独立表已存在。
- `agent_workflows.py` 已开始定义 workflow contract。
- `/api/demo/status/` 已返回 `agentWorkflows` readiness。

这对应 DSPy 的“模块化程序图”和 ReAct 的“可追踪运行轨迹”的最小工程基础。

## 4. A3 自研 Agent 分层设计

根据两份调研，A3 的 Agent 不应该只是角色名，而应分为四层：

```text
L0 Tool Layer
  知识库检索、画像读写、计划生成、测评判分、通知、收藏、教师推送

L1 Runtime Layer
  AgentRun、AgentStep、workflow registry、超时、重试、降级、schema version

L2 Cognitive Layer
  ReAct loop、Self-RAG 验证、画像记忆、资源生成、路径规划、评测反馈

L3 Product Layer
  今天学什么、不会就问、我的进步、教师干预、能力总览
```

当前项目已经有 L0 和部分 L1。下一步应集中补 L1 到 L2 的桥梁：

- 工作流契约不仅描述 Agent 名称，还要描述输入摘要、输出摘要、状态更新和证据质量。
- 每个工作流要记录“为什么调用这个工具”、“工具结果如何影响最终输出”。
- 推荐、辅导、测评和计划要统一产出可解释的 Agent trace。

## 5. 第一批 Agent 代码改造计划

### 5.1 Workflow Contract 完整化

已完成：

- `describe_agent_workflows()`
- `evaluate_trace_contract()`
- `summarize_workflow_readiness()`
- `/api/demo/status/ -> agentWorkflows`

下一步：

- 为每个 workflow 增加 `inputSchema`、`outputSchema`、`qualityMetrics`。
- 把 `targetSteps` 分为 `recommendedSteps` 和 `futureSteps`，避免当前 readiness 因未来能力过度扣分。
- 在能力页展示 workflow contract 与 latest trace 的差距。

### 5.2 ReAct Trace Metadata

新增 AgentStep metadata 标准：

```json
{
  "thought": "为什么进入这一步",
  "action": "调用了哪个工具或服务",
  "observation": "工具返回了什么摘要",
  "inputSummary": {},
  "outputSummary": {},
  "stateDiff": {},
  "evidence": {},
  "quality": {}
}
```

第一批只要求：

- `inputSummary`
- `outputSummary`
- `stateDiff`

不要把内部完整 prompt、用户隐私原文或长篇模型输出写进 trace。

### 5.3 ResourcePackWorkflow

推荐页和课堂页需要共用资源包，而不是各自拼数据。

资源包 schema：

```json
{
  "schemaVersion": "a3.resource-pack.v1",
  "resourcePackId": "string",
  "title": "string",
  "target": {
    "goal": "string",
    "pathNode": "string",
    "weakPoints": []
  },
  "items": [
    {
      "type": "summary_card|micro_lesson|mind_map|practice_set|wrong_question_review",
      "title": "string",
      "content": "string",
      "reason": "string",
      "score": 0.0,
      "citations": [],
      "verified": false
    }
  ],
  "nextActions": []
}
```

第一批可先不落表，先由 `/api/recommend/` 返回稳定 schema。第二批再落 `ResourcePack` 表。

### 5.4 Self-RAG Lite

完整 Self-RAG 训练成本高，A3 第一阶段应实现轻量版：

```text
Query -> Retrieve -> Generate draft -> Extract claims -> Verify with sources -> Mark verified/citations/safety
```

需要新增或强化：

- `retrievalDecision`: 是否需要检索。
- `evidenceScore`: 检索结果对问题的支撑程度。
- `claimSupport`: 每条 claim 是否被 citation 支撑。
- `missingEvidence`: 无证据时明确返回。

### 5.5 Learner Memory

借鉴 Generative Agents，但不复现 Smallville。A3 只需要教育语义记忆：

```json
{
  "eventType": "diagnostic_completed|task_completed|wrong_question|reflection|teacher_intervention",
  "importance": 0.0,
  "summary": "string",
  "signals": {
    "weakPoints": [],
    "preference": [],
    "motivation": [],
    "risk": []
  }
}
```

第一批可以继续写入 `LearnerProfile.extra_profile.learningEvents`，后续升级为独立表。

### 5.6 Tool Registry

借鉴 Gorilla，不要求使用 Gorilla 模型，而是建立工具注册和参数校验。

第一批工具：

| Tool | 作用 |
|---|---|
| `profile.read` | 读取画像 |
| `profile.update` | 更新画像弱点 |
| `kb.search` | 知识库检索 |
| `path.generate` | 生成路径 |
| `study_plan.generate` | 生成计划 |
| `assessment.grade` | 判分 |
| `notification.create` | 创建通知 |
| `verification.verify` | 验证回答 |

每个工具至少有：

```json
{
  "name": "kb.search",
  "inputSchema": {},
  "outputSchema": {},
  "timeoutMs": 3000,
  "fallback": "lexical_search"
}
```

## 6. 赛题答辩叙事

答辩时不能只说“我们用了多智能体”。应这样讲：

1. A3 借鉴成熟学习产品，不做纯聊天，而做诊断、规划、资源、练习、错题、报告闭环。
2. 前台只有统一学习助手和清晰学习入口，后台才是多 Agent 协同。
3. 底层 Agent 不是随便命名，而是参考 DSPy、ReAct、Self-RAG、Generative Agents、Gorilla、LATS 等论文范式。
4. 每个关键工作流都有 AgentRun、AgentStep、workflow contract、缺失步骤检测和 readiness。
5. 所有课程生成内容都经过知识库检索和引用验证，未验证不会标可信。
6. 测评错题会回流画像、计划、复习和推荐。
7. 教师端能查看风险并推送任务，形成学生和教师双闭环。

## 7. 当前代码优先级

### P0：让 Agent 不再只是名字

- 完成 workflow contract。
- 为现有 workflow 增加 input/output/stateDiff metadata。
- `/a3/capabilities` 展示 agentWorkflows。

### P1：让推荐升级为资源包

- `/api/recommend/` 返回 ResourcePack。
- 推荐页展示五类资源、来源、理由、验证状态。
- 课堂和错题复习复用 ResourcePack。

### P2：让辅导具备 ReAct + Self-RAG Lite

- 提问先做 Safety。
- 再读学习状态。
- 再检索知识库。
- 再生成引导式回答。
- 再验证 claims。
- trace 展示每一步。

### P3：让画像具备长期记忆

- 增加 learningEvents。
- 错题、任务完成、复盘、教师干预都转成事件。
- 定期生成 profile reflection summary。

### P4：让路径规划可解释

- 路径生成输出候选方案、评分、选择理由。
- 复杂路径再引入 LATS-like 多方案评估。
- 简单路径保持启发式，避免过度消耗。

## 8. 近期可执行任务

下一轮 Agent 开发建议按这个顺序：

1. 给 `AgentStep` metadata 增加 `inputSummary`、`outputSummary`、`stateDiff` 约定，并在 recommend/verify/assess 三个 workflow 先落地。
2. 扩展 `agent_workflows.py`，加入 `inputSchema`、`outputSchema`、`qualityMetrics`。
3. 改造 `/api/recommend/`，返回 `resourcePack`，覆盖五类资源中的前三类。
4. 增强 `verify_answer`，输出 `evidenceScore` 和 `claimSupport`。
5. 在 `/api/demo/status/` 和 `/a3/capabilities` 展示 research-backed agent stack：DSPy/ReAct/Self-RAG/Memory/Tool Registry。

## 9. 关键取舍

- 不先做虚拟人视频。它成本高，且不是赛题核心。
- 不先做完整 DSPy 自动优化。先借鉴模块化和评测思想。
- 不先做完整 Self-RAG 训练。先做 Self-RAG Lite。
- 不先做 MAT。它是研究延展，不适合第一版。
- 不把前台做成多个 Agent 聊天窗口。前台统一，后台分工。

## 10. 本文档的使用方式

后续开发 Agent 时，先读：

1. `AGENTS.md`
2. `A3_AGENT_ARCHITECTURE.md`
3. `A3_RESEARCH_TO_AGENT_IMPLEMENTATION.md`

产品闭环开发另读：

1. `A3_PRODUCT_LOOP_REMAINING.md`

两条线要汇合到同一个验收标准：

```text
页面可用
+ 接口真实
+ Agent trace 可解释
+ 知识来源可验证
+ 测评指标可复现
+ 学习闭环能持续推进用户下一步
```
