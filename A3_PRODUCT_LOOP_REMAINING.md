# A3 产品闭环剩余工作交接

更新时间：2026-07-02

本文档用于后续继续推进 A3“智学引擎”的产品闭环。当前项目已经不是“补页面 demo”的阶段，P0 主链路和自动化验收证据基本闭合；后续重点是把学习软件体验、教师/知识库链路、Agent 工程化、评测和部署交付做扎实。

## 1. 当前结论

### P0 演示闭环：已闭合，后续以回归保持为主

已具备并通过过验证的主能力：

- 注册/登录、首启、隐私授权、画像采集、入学诊断、学习路径、学习计划、今日任务。
- 知识库资源管理与检索、推荐与收藏、AI 课堂/面对面辅导、引用验证与安全过滤。
- 测评判分、错题本、间隔复习提醒、报告、通知、教师工作台、能力总览和 demo flow。
- `validate_demo_flow --skip-seed --strict` 已能覆盖主链路，最近一次报告输出到 `backend/tmp/demo_validation_report.md`。
- 检索评测集已达到 53 条，`demo_retrieval_metrics.json` 已生成过，Top3、verifiedCoverage、safetyRefusalRate 均达到演示目标。

最近新增的可验收证据：

- 推荐排序已经纳入画像差异：目标、薄弱点、期望资源、基础水平、每日学习时间会影响推荐理由、排序依据和 `profileMatch` 信号。
- 知识库后端链路已有自动化证明：教师上传资源后同步索引，学生课堂上下文能引用该上传资料。
- 后端 `manage.py check` 当前通过；本文件及近期相关后端文件未发现替换字符 `U+FFFD` 残留。

## 2. 还剩什么没干

### A. P1 页面级产品体验巡检

仍需按按钮级标准逐页巡检，不只是看页面能不能打开：

- `/a3/profile-setup`：画像字段保存、隐私授权前后的处理边界、保存成功/失败反馈。
- `/a3/admission-diagnostic`：提交失败保留答案、成功后明确跳转路径/计划/今日任务。
- `/a3/today`：无计划、无任务、任务完成后的下一步动作是否足够清楚。
- `/a3/study-plan`：延期任务、漏学任务、任务过多时的降负荷解释和页面展示。
- `/a3/recommendations`：降级推荐、无证据推荐、收藏回流、刷新后的排序解释。
- `/a3/classroom` 与 `/a3/coaching`：同一问题在不同目标/路径节点下是否有可解释差异，引用是否稳定展示。
- `/a3/teacher`：学生角色权限提示、教师推送任务后的学生通知回流。
- `/a3/knowledge-base`：上传、索引任务、失败重试、空库搜索、下载、搜索到课堂引用。
- `/a3/capabilities`：指标、trace、证据链展示是否和后端实际状态一致。

验收口径：

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd test:e2e e2e/tests/a3-button-actions.spec.ts --project=chromium
pnpm.cmd test:e2e e2e/tests/a3-route-smoke.spec.ts --project=chromium
```

### B. 学习软件体验还要继续打磨

这些不是缺接口，而是成熟学习软件体验还不够完整：

- 诊断后要更明确解释“为什么生成这条路径、为什么今天学这些”。
- 今日任务需要在空状态、完成状态、延期状态下都给出清晰下一步。
- 学习计划需要更强的计划调整理由：延期、漏学、降负荷、复习节奏变化。
- 报告页可以继续强化周总结、薄弱趋势、下周建议和计划完成度解释。
- 通知提醒要继续确保能把用户带回今日任务或错题复盘，而不是只展示静态消息。

验收口径：

```powershell
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
pnpm.cmd test:e2e e2e/tests/a3-notification-action.spec.ts --project=chromium
pnpm.cmd test:e2e e2e/tests/a3-demo-flow.spec.ts --project=chromium
```

### C. 教师与知识库两条演示链路还要压测

已有后端证据，但仍需要一轮干净演示数据下的完整端到端压测：

```text
教师登录 -> 工作台 -> 推送任务 -> 学生通知收到 -> 学生执行任务
知识库 -> 上传资源 -> 索引任务 -> 搜索 -> 课堂/辅导引用 -> 来源展示
```

重点剩余项：

- 教师推送任务写入通知系统后，学生端通知、今日任务或相关页面是否稳定回流。
- 知识库上传后的索引状态、失败重试、空库搜索、下载权限和课堂引用是否都可演示。
- 非教师用户访问教师页、知识库管理能力时，权限提示和路由保护是否清楚。
- Docker 或重置演示数据后，这两条链路是否仍能复现。

已补的后端测试证据：

```powershell
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.learning.tests.test_path_planner.LearningPathTests.test_teacher_upload_api_indexes_resource_and_student_classroom_cites_it --keepdb
```

### D. Agent 工程化仍是 P2 剩余重点

目前 Agent 轨迹能力可用，但还未达到企业级工程化：

- `AgentRun` 仍主要依赖 `LearnerProfile.extra_profile`，尚未升级为独立表。
- `AgentStep`、`RecommendationLog`、`VerificationLog` 等独立日志表仍未落地。
- 每个 Agent 输出还需要统一 `schemaVersion`。
- 超时、重试、降级、熔断策略需要结构化记录，而不是只靠自然语言说明。
- `/a3/capabilities` 可继续增加 trace waterfall，展示最近 workflow 的步骤耗时、fallback、retry 和错误信息。

建议新增模型：

```text
AgentRun
AgentStep
RecommendationLog
VerificationLog
StudyPlan
StudyPlanDay
StudyPlanTask
```

### E. 评测与答辩材料还要收口

已完成 53 条演示评测集和指标文件生成，但答辩交付还没完全收口：

- 继续扩展更难样本，保持 Top1/Top3、verifiedCoverage、safetyRefusalRate 稳定。
- 把 `backend/tmp/demo_retrieval_metrics.json` 的关键指标稳定展示到 `/a3/capabilities`。
- 固定 6 分钟演示脚本需要和当前页面状态、最新指标、最新截图再核对一次。
- 录屏和最终答辩材料还未完成。

验收口径：

```powershell
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py evaluate_demo_retrieval --top-k 3
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py evaluate_demo_retrieval --top-k 3 --json --output backend\tmp\demo_retrieval_metrics.json
```

### F. 部署交付仍未最终验收

Docker 一键部署和首次启动体验仍是最后一批交付项：

- 在 Docker Desktop 环境实际跑通 `docker compose up --build`。
- 确认首次启动自动 migrate。
- 确认首次启动或演示模式能 seed demo data。
- 补齐并核对 `.env.example`。
- 补充部署说明、常见问题和最终验收清单。

验收口径：

```powershell
cd D:\Download\A3
docker compose up --build
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --strict
```

## 3. 当前最优先的下一步

1. 先做 P1 页面按钮级巡检，优先覆盖诊断、今日任务、学习计划、推荐、课堂/辅导、教师、知识库、能力页。
2. 再压测教师推送和知识库上传引用两条端到端演示链路，把后端证明补成真实页面证明。
3. 最后推进 P2：AgentRun 独立表、trace waterfall、Docker 一键部署、答辩材料和录屏。

## 4. 每批开发必须跑的基础验证

前端：

```powershell
cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
```

后端：

```powershell
cd D:\Download\A3
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py check
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

检索与安全评测：

```powershell
D:\Download\A3\backend\.venv\Scripts\python.exe backend\manage.py evaluate_demo_retrieval --top-k 3
```

中文文案或后端中文字符串修改后：

```powershell
$replacement = [char]0xfffd
rg -n $replacement OpenMAIC\app\a3 OpenMAIC\components\a3 OpenMAIC\lib\a3 OpenMAIC\lib\server backend\apps -g "*.py" -g "*.ts" -g "*.tsx"
```

## 5. 不要做的事

- 不要新增纯 mock 页面或前端本地假数据冒充闭环。
- 不要绕过已有后端接口另造平行 API。
- 不要把 OpenMAIC 原始课堂能力包装成 A3 已完成能力。
- 不要删除用户已有改动或未跟踪的 A3 文件。
- 不要降低当前基线：TypeScript pass、lint 0 error、Django check pass、`validate_demo_flow --skip-seed --strict` pass。

