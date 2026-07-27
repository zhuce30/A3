# AI 课堂：通用意图识别层 + 对话内资源生成（A+B）

> **实现状态（2026-07-27 更新）：功能已实现，代码 tsc + 后端单测通过，前端未做浏览器实测。**
>
> | 步骤 | 状态 | 说明 |
> |---|---|---|
> | 1 抽资源生成 hook | ⚠️ 变体 | 新建独立 hook，recommendations 页**未重构**（降风险），两页各有一套生成逻辑 |
> | 2 导出资源渲染组件 | ✅ | 新增精简版 `ResourceInlineBody`（而非直接导出 `ResourceBody`）|
> | 3 后端意图端点 | ✅ | 路径实际为 `/api/intent/classify/`（非 plan 写的 `/api/a3/...`）；13 单测全绿 |
> | 4 前端意图路由 | ✅ | intent-router.ts 齐全 |
> | 5 课堂 A（chips）| ✅ | `ClassroomResourceChips` |
> | 6 ChatMessage 扩展 | ✅ | 加 `kind`/`resourcePack`/`resourceType` |
> | 7 askQuestion 过意图 | ✅ | generate/navigate 分支 + 其余兜底问答 |
> | 8 ChatBubble 渲染资源 | ✅ | 内联 `ResourceInlineBody` |
> | 9 生成进度/失败兜底 | ✅ | `asking` 态 + 失败 push 文字消息 |
> | 验证-回归测试 | ➖ | 因未重构 recommendations，无此需要，也未跑 |
> | 验证-浏览器实测 | ❌ | **未做**：课堂端到端（chips/对话触发/资源渲染/跳转）需手动确认 |
>
> 变动清单另见 `docs/A3_资源推荐系统改进清单.md` 末节。

## 目标

打通 AI 课堂与资源生成，消除"跳转到另一个页面重新输入"的割裂。做两件事：
1. **通用意图识别层**（可复用，不只服务资源生成）——课堂输入先过这层，判断用户想干什么再分发。
2. **课堂 A+B 闭环**——A：课堂内显式入口（资源类型 chips，用当前课堂目标直接生成）；B：对话触发（"生成一个讲解视频"→识别→生成→结果作为消息渲染在对话流里）。

范围：**先做课堂 A+B 闭环**（语音/首页等其他界面复用留作后续）。

## 已确认的决策

- 意图识别架构：**混合**（显式操作直接分发 0 延迟；自由文字先前端轻量规则、命中不了再调后端 LLM；任何不确定兜底到问答）
- B 生成结果展示：**作为新消息插进对话流**（复用已有资源渲染组件）
- 范围：**先做课堂 A+B 闭环**

## 现状（已核实）

- 课堂对话：`askQuestion`（classroom-view-redesign.tsx:648）→ `POST /api/a3/coaching/respond` → Django `/api/v1/qa/interact/`（compat/views.py:1090）
- 资源生成：`POST /api/a3/resources/jobs`（通用接口，`{goal, resourceType, topK}` → 轮询 job）
- 资源生成前端逻辑（`generateSingleResourceV2` / 轮询 / sanitize）耦合在 recommendations-view.tsx（1600+ 行）
- 资源渲染组件（`ResourceBody`/`LectureDocument`/`KnowledgeCards`/`MindMap`/三个 Workbench）目前是 resource-standalone-view.tsx **文件内私有**，未导出
- 后端已有 agent kernel + `chat_completion`（compat/llm.py）可复用做意图分类
- 实时语音已有 `realtime/tool` 路由做工具分发（意图→工具模式已有先例）
- `ChatMessage` 类型（classroom-view-redesign.tsx:73）：目前只有 user/assistant 文本消息

## 实施步骤

### 阶段 1 — 抽可复用基础件（为 A/B 铺路，纯重构，低风险）

1. **抽资源生成 hook** `lib/a3/use-resource-generation.ts`
   - 从 recommendations-view.tsx 抽出 `generateSingleResourceV2` + 轮询 + sanitize 逻辑
   - 签名约 `useResourceGeneration()` → `{ generate(resourceType, goal), generating, progress, error }`
   - recommendations-view.tsx 改为消费此 hook（保持原行为，回归测试锁定）
   - **【实际】** 改为新建自包含 hook（复用同一后端 job 接口 + 自带轮询/sanitize），
     **recommendations 页未重构**。原因：重构 1600 行工作组件风险高且无法可视化验证。
     代价：课堂与推荐页各有一套生成逻辑，去重留作后续（方案 C）。

2. **导出资源渲染组件**
   - 在 resource-standalone-view.tsx 把 `ResourceBody`（或新增精简版 `ResourceInlineBody`）`export`
   - 精简版去掉左右分栏/EvidencePanel，适配对话气泡内的窄容器展示
   - 复用已改好的 FlipCard / CodeEditor / 溯源链接 / GenericContent 友好渲染

### 阶段 2 — 通用意图识别层

3. **后端意图端点** `POST /api/a3/intent/classify`（compat）
   - 输入 `{ text, context: {surface, goal, ...} }`
   - 用 `chat_completion` 做分类，输出 `{ intent, confidence, params }`
   - 意图 taxonomy 初版：`ask_question`（默认兜底）/ `generate_resource{resourceType, goal}` / `start_practice{topic}` / `explain_concept{concept}` / `navigate{route}` / `review_wrong`
   - LLM 不可用或低置信 → 返回 `ask_question` 兜底
   - 加单元测试：各意图的识别 + 兜底
   - **【实际】** 端点路径为 `/api/intent/classify/`（compat 挂在 `/api/`，前端直连 Django，
     无需 a3 前缀）。分类逻辑落在独立模块 `intent_router.py`；13 个单测全绿。

4. **前端意图路由** `lib/a3/intent-router.ts`（通用，任何 surface 可 import）
   - `classifyIntent(text, context)`：先跑前端轻量规则（高频意图关键词），命中直接返回；否则调 `/api/a3/intent/classify`
   - `dispatchIntent(intent, params, handlers)`：把意图映射到调用方注入的 handler（ask/generate/practice/navigate…）
   - 设计成 surface 无关，课堂注入课堂的 handlers，将来语音/首页注入各自的

### 阶段 3 — 课堂 A（显式入口）

5. 课堂对话框上方加一排资源类型 chips（复用 recommendations 的 `resourceEntries` 定义/图标）
   - 点击 = 确定意图，用当前 `target.title` 作 goal，调阶段 1 的 hook 直接生成
   - 视频/PPT 走 OpenMAIC 外部课堂（保持现有跳转，不强行内联）

### 阶段 4 — 课堂 B（对话触发）

6. 扩展 `ChatMessage` 类型：加 `kind?: 'text' | 'resource'` 和 `resourcePack?` 字段
7. `askQuestion` 改造：发送前先过 `classifyIntent`
   - `generate_resource` → 调生成 hook，完成后 push 一条 `kind:'resource'` 消息
   - 其他意图 → 现有 `/coaching/respond`（默认路径不变）
8. `ChatBubble` 支持渲染 `kind:'resource'` 消息（内联 `ResourceInlineBody`）
9. 生成中显示进度气泡；失败兜底成普通文字回复

### 验证

- 后端：意图分类端点单元测试；资源生成回归测试（阶段 1 抽 hook 后 recommendations 行为不变）
- 前端：`tsc --noEmit`；意图路由的规则命中/兜底单测（若有前端测试框架）
- 手动：课堂输入"生成讲解文档""出几道练习""什么是死锁"分别走对分支

## 风险与取舍

- **抽 hook/导出组件**是重构，风险在于不破坏 recommendations 页现有行为——用现有回归测试兜底
- **意图分类的 LLM 延迟**：混合方案让显式操作和高频文字走规则、0 延迟；只有模糊自由文字才多一次 LLM 调用，且有兜底
- **对话内资源渲染的宽度**：气泡容器窄，需要精简版渲染（去分栏），思维导图/代码可能需要"展开/打开完整页"选项
- 意图 taxonomy 先落 6 类，后续可扩展；分类端点通用，为语音/首页复用留口

## 不在本次范围

- 语音辅导、首页搜索接入意图层（复用留后续）
- 视频/PPT 的对话内内联播放（仍走 OpenMAIC 跳转）
- 方案 C（把整个工作台抽成共享 context 的架构级重构）
