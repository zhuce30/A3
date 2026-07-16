# A3 专业资源工作台与生成质量设计

## 1. 目标

改造以下三类资源详情页及其生成链路：

- `practice_set`：专项练习
- `case_study`：案例拆解
- `code_lab`：代码实验

本次改造解决两个问题：

1. 页面长期使用单列卡片向下堆叠，桌面宽度利用率低，右侧留白明显，缺少成熟学习软件的任务感。
2. 三类资源共用较薄的通用生成要求，内容容易模板化，题目、案例和实验缺少专业结构与质量门槛。

现有资源包、生成任务、学习事件、引用验证和代码 runner 接口保持兼容，不新增前端假数据。

## 2. 已确认设计方向

### 2.1 整体布局

三类页面统一采用“专业学习工作台”骨架：

```text
页面标题、资源状态、预计时长
-> 主工作区（核心学习任务）
-> 右侧固定学习栏（进度、步骤、检查点、证据、下一步）
```

桌面端使用平衡的双区布局，主工作区占据主要宽度，右侧学习栏保持稳定宽度并在滚动时可见。移动端取消固定定位，按“任务、操作、反馈、证据”的顺序纵向排列。

右侧学习栏不是装饰栏，必须承载当前页面需要反复查看的信息。不得继续出现左侧内容无限增长、右侧只有少量文字的布局。

### 2.2 专项练习

专项练习采用逐题作答模式，不再直接展示整组答案。

页面结构：

```text
题号导航 + 当前题目
-> 用户选择选项或填写回答
-> 提交当前题
-> 展示当前题答案、解析、常见错因、其他选项错误原因和引用来源
-> 进入下一题
```

右侧学习栏展示：

- 整组完成进度
- 当前题型、难度和知识点
- 当前题学习目标
- 引用来源和验证状态

选择题支持本地判定；开放题在提交后提供参考答案和评价量规，由学生自查。本次不把资源练习伪装成正式测评，不绕过 `/a3/assessment` 的测评闭环。

### 2.3 案例拆解

案例拆解采用“先判断，再看专家分析”的主动学习方式。

页面结构：

```text
案例场景、角色和约束
-> 材料包与关键证据
-> 学生写下自己的判断和依据
-> 提交判断
-> 展开专家拆解、决策点、推荐路径和评价量规
-> 完成复盘
```

学生提交前不展示完整专家结论。页面会明确说明提交后才能查看参考拆解，避免用户误以为内容缺失。

右侧学习栏展示：

- 案例分析路径
- 完成标准
- 材料来源
- 复盘动作

本次学生判断保存在当前页面会话中，并写入资源学习事件所需的完成信息；不新增未经设计的正式作业表。

### 2.4 代码实验

代码实验采用编辑器与运行结果并排的工作区。

主工作区：

```text
左侧：代码编辑器
右侧：stdout、stderr、测试用例和判题结果
```

右侧学习栏展示：

- 实验步骤
- 当前检查点和完成度
- 常见失败与调试提示
- 扩展挑战
- 资料证据

页面继续调用真实接口：

```text
POST /api/resources/packs/<pack_id>/code-lab/run/
```

当前 runner 以 Python 为可靠基线。生成器不得宣称支持生产环境中无法真实执行和判题的语言。

## 3. 前端组件设计

当前 `resource-standalone-view.tsx` 同时承担资源加载、页面框架和多类资源渲染，三类专业工作台不应继续扩充在同一大文件中。

建议新增目录：

```text
OpenMAIC/components/a3/features/resource-workbench/
|-- resource-workbench-shell.tsx
|-- resource-learning-rail.tsx
|-- practice-set-workbench.tsx
|-- case-study-workbench.tsx
|-- code-lab-workbench.tsx
|-- resource-workbench-utils.ts
```

职责：

- `resource-workbench-shell.tsx`：桌面双区和移动端顺序布局。
- `resource-learning-rail.tsx`：进度、步骤、证据和完成状态的共享外壳。
- `practice-set-workbench.tsx`：逐题状态、提交和解析揭示。
- `case-study-workbench.tsx`：学生判断、专家分析解锁和评价量规。
- `code-lab-workbench.tsx`：代码编辑、运行、判题和检查点。
- `resource-workbench-utils.ts`：安全读取旧资源字段和兼容降级数据。

`resource-standalone-view.tsx` 继续负责资源加载、路由配置、反馈和通用资源类型，并把三类资源交给对应工作台。

## 4. 资源内容契约

### 4.1 专项练习契约

每道题至少包含：

```json
{
  "id": "q1",
  "type": "choice",
  "knowledgePoint": "进程调度",
  "difficulty": "中等",
  "stem": "题干",
  "options": ["A ...", "B ..."],
  "answer": "B",
  "explanation": "分步解析",
  "distractorAnalysis": ["A 为什么错误"],
  "commonMistake": "常见错因",
  "evaluationRubric": ["开放题评价标准"],
  "sourceIds": ["S1"]
}
```

整组题必须：

- 至少 8 题。
- 覆盖基础理解、条件判断、应用、分析、纠错和迁移。
- 形成由基础到提高的难度梯度。
- 选择题选项必须互斥、可判定，不能只有措辞差异。
- 解析必须说明推理过程，不只重复答案。
- 关键题目必须对应检索证据。

### 4.2 案例拆解契约

案例至少包含：

```json
{
  "scenario": "真实课程或工程场景",
  "role": "学生扮演的角色",
  "constraints": ["时间、资源或规则约束"],
  "background": "必要背景",
  "task": "需要完成的判断",
  "materials": [{"title": "材料", "snippet": "内容", "sourceId": "S1"}],
  "decisionPoints": ["关键决策点"],
  "analysisSteps": ["专家拆解步骤"],
  "expertAnalysis": "完整参考分析",
  "rubric": ["评价标准"],
  "reflection": "复盘问题",
  "sourceIds": ["S1"]
}
```

案例必须存在真实的信息差和决策点，不能把知识点定义改写成一段故事。材料中必须提供足够信息，让学生在查看专家分析前形成自己的判断。

### 4.3 代码实验契约

代码实验至少包含：

```json
{
  "language": "Python",
  "objective": "可验证的实验目标",
  "environment": "Python 版本和依赖",
  "concepts": ["实验涉及的知识点"],
  "starterCode": "可运行代码",
  "steps": ["实验步骤"],
  "expectedOutput": "输出说明",
  "testCases": [{"name": "用例", "stdin": "", "expectedStdout": ""}],
  "hints": ["按层次提供的调试提示"],
  "commonFailures": ["常见错误及修复方法"],
  "checkpoints": ["可观察的验收标准"],
  "extension": "扩展挑战",
  "sourceIds": ["S1"]
}
```

starter code 和测试用例必须与真实 runner 契约一致。测试用例不得依赖网络、文件系统越权、第三方包或不可控随机值。

## 5. Agent 与 Prompt 架构

保留现有 `ResourceSynthesisAgent` 和 `resource_generate` 工作流，不新增三个顶层 Agent。`ResourceSynthesisAgent` 根据资源类型加载专业生成契约：

```text
ResourceSynthesisAgent
-> PracticeSetSpecialistContract
-> CaseStudySpecialistContract
-> CodeLabSpecialistContract
```

专业契约是后端内部 prompt、schema、修复和质量检查组合，不改变 Agent 对外接口，也不增加重复检索。

每次生成仍使用一次模型调用，输入必须包含：

- 学习目标
- 学生画像和薄弱点
- 本地知识库证据
- 当前资源类型的专业 schema
- 质量检查清单
- 禁止编造页码、来源和运行能力的约束

模型输出必须为 JSON object，不接受 Markdown 代码围栏。

## 6. 修复、校验与降级

三类资源分别实现结构修复和质量评估，不再只依赖字段数量判断。

处理顺序：

```text
模型 JSON
-> 类型专用结构修复
-> 类型专用质量评分
-> 合格：写入资源包
-> 不合格：使用增强规则模板降级
```

质量检查重点：

- 练习：题型覆盖、难度梯度、答案可判定、解析质量、错因和引用。
- 案例：场景完整、材料充分、决策点明确、学生任务与专家分析分离。
- 代码：Python 可运行结构、测试用例完整、步骤与代码一致、检查点可观察。

降级内容仍必须满足前端工作台需要的完整字段。不能因为模型输出不合格而退化为长字符串或空卡片。

`synthesis` 元数据继续记录：

- `mode`
- `provider`
- `model`
- `degraded`
- `degradationReason`
- 类型专用质量检查结果

## 7. 状态与错误处理

前端必须处理：

- 旧资源缺少新增字段：通过兼容工具生成可读默认结构。
- 练习没有选项：使用开放题输入和自查模式。
- 案例缺少专家拆解：显示可读降级说明，不提前伪造结论。
- 代码缺少测试用例：允许运行，禁用判题并说明原因。
- runner 失败或超时：保留用户代码，展示 stdout、stderr 和错误状态。
- 移动端：不得出现横向溢出、固定栏遮挡和按钮文本截断。

## 8. 接口边界

本次保持以下接口不变：

```text
POST /api/a3/resources/jobs
GET  /api/a3/resources/jobs?jobId=<job_id>
GET  /api/resources/packs/<pack_id>/
POST /api/resources/packs/<pack_id>/feedback/
POST /api/resources/packs/<pack_id>/code-lab/run/
```

资源内容 JSON 增加向后兼容字段，不删除现有字段。已有资源包仍可打开。

## 9. 验证标准

后端测试：

- 三类专业 prompt 包含完整 schema 和禁止项。
- 模型输出缺字段时能修复。
- 不合格输出进入增强规则降级。
- 练习至少 8 题且包含难度、错因和解析。
- 案例包含材料、决策点、学生任务、专家分析和量规。
- code lab starter code 和测试用例满足 runner 输入结构。

前端测试：

- 专项练习提交前不显示答案，提交后只显示当前题解析。
- 案例提交判断前不显示专家分析。
- 代码编辑器和结果区在桌面并排，移动端纵向排列。
- 右侧学习栏包含真实步骤、检查点和证据。
- 旧资源数据可以兼容展示。

基础验证：

```powershell
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run <resource-workbench-tests>

cd ..
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test <resource-generation-tests> --keepdb
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_code_lab_runner --keepdb
```

## 10. 非目标

- 不把资源练习替代正式测评模块。
- 不新增三个重复检索的顶层 Agent。
- 不新增无法被 runner 执行的语言承诺。
- 不重构无关资源类型。
- 不改变 OpenMAIC 课堂、PPTX、视频 artifact 接入边界。
