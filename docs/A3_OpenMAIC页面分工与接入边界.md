# A3 OpenMAIC 页面分工与接入边界

本文档用于固定后续开发边界：A3 是学习软件主产品，OpenMAIC 是多模态课堂、PPTX 导出、视频生成等能力底座。用户学习闭环必须留在 A3 页面内完成，不能把 OpenMAIC 原始流程当作 A3 产品完成度。

## 接入原则

- A3 页面负责画像、诊断、推荐、课堂、测评、错题、报告、教师干预等学习软件主流程。
- OpenMAIC 能力必须通过 A3 bridge API 调用，并把 job、artifact、trace 写回 A3。
- Django 后端不直接生成 PPTX；PPTX 导出由 OpenMAIC 课堂前端 hook 完成。
- PPTX 导出完成后必须调用 `POST /api/a3/resources/openmaic-pptx-export` 写回 A3，形成 `openmaic_pptx_export` artifact。
- 视频生成调用真实 provider；没有 key 时必须展示 provider 未配置，并把 degraded artifact 写回资源包。
- OpenMAIC artifact 的权威审计数据存入 `OpenMAICArtifact` 表，同时兼容写回 `resourcePack.multimodalArtifacts` 和 `ResourcePackLog.payload`。

## 页面分工

| A3 页面 | 职责 | OpenMAIC 能力 | 主要接口 | 验证证据 |
|---|---|---|---|---|
| `/a3/recommendations` | 生成 A3 七类资源包，触发课堂、PPTX、视频任务 | `generate-classroom`、`/api/generate/video` | `POST /api/resources/generate/`、`POST /api/a3/resources/openmaic-classroom`、`POST /api/a3/resources/openmaic-pptx-export`、`POST /api/a3/resources/openmaic-video` | `resourcePack.multimodalArtifacts`、`a3-openmaic-classroom-card`、`a3-openmaic-video-card` |
| `/a3/resources/[packId]` | 查看资源包详情和 artifact 历史 | 课堂、PPTX、视频 artifact 审计 | `GET /api/resources/packs/<id>/` | `a3-resource-pack-artifact-history`、`a3-resource-pack-artifact-summary` |
| `/a3/classroom` | 学生打开来自资源包的 OpenMAIC 课堂 | OpenMAIC classroom URL、PPTX 导出提示 | `GET /api/resources/packs/`、`GET /api/learning/classroom/` | `a3-classroom-openmaic-entry`、`a3-classroom-openmaic-pptx-hint` |
| `/a3/teacher` | 教师查看资源包和多模态产物效果 | 聚合课堂、PPTX、视频 artifact 的资源效果 | `GET /api/learning/teacher/workbench/`、`POST /api/learning/teacher/tasks/execute/` | `a3-teacher-openmaic-artifacts`、`a3-teacher-resource-pack-filter` |
| `/a3/capabilities` | 展示答辩证据、页面分工和真实 smoke 状态 | RAG、trace、artifact 审计、视频 smoke | `GET /api/demo/status/`、`GET /api/a3/system/runtime`、`POST /api/a3/resources/openmaic-pptx-export`、`POST /api/a3/resources/openmaic-video-smoke-writeback` | `a3-openmaic-readable-ownership`、`a3-openmaic-artifact-audit`、`a3-openmaic-smoke-report` |
| `/a3/knowledge-base` | 上传和索引本地课程资料 | 为 RAG、课堂生成和资源包引用提供证据来源 | `GET /api/kb/resources/`、`POST /api/kb/resources/upload/`、`GET /api/kb/search/` | `a3-knowledge-base-resources`、`a3-kb-search-results` |

## Artifact 类型

`OpenMAICArtifact.artifact_type` 当前支持：

- `openmaic_classroom`：OpenMAIC 课堂 job 写回，包含 `classroomId`、`classroomUrl`、`scenesCount`、`pptxExportable`。
- `openmaic_pptx_export`：OpenMAIC 课堂前端 PPTX 导出完成写回，包含 `fileName`、`slidesCount`、`classroomId`、`classroomUrl`。
- `openmaic_video`：短视频/动画脚本提交到 `/api/generate/video` 后的成功或降级写回，包含 `provider`、`videoUrl`、`duration`、`degradedReason`。

## PPTX 写回链路

```text
资源包生成
-> POST /api/a3/resources/openmaic-classroom
-> artifact.classroomUrl 带 a3PackId / a3ClassroomJobId
-> 用户打开 OpenMAIC 课堂
-> useExportPPTX 导出 PPTX
-> POST /api/a3/resources/openmaic-pptx-export
-> Django POST /api/resources/packs/<pack_id>/openmaic-pptx-export/
-> OpenMAICArtifact + resourcePack.multimodalArtifacts + ResourcePackLog.payload
-> /a3/resources/<packId>、/a3/teacher、/a3/capabilities 展示
```

## 验证命令

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-openmaic-page-ownership.test.ts tests/a3-openmaic-handoff-sync.test.ts tests/a3-openmaic-classroom-bridge.test.ts
pnpm.cmd test:e2e:a3-classroom
npx.cmd tsc --noEmit
pnpm.cmd lint

cd ..
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
```

## 后续规则

1. 新增 OpenMAIC 能力前，必须先确定归属的 A3 页面。
2. 会产生课堂、PPTX、视频、文件、评分或报告产物的能力，必须写入 `OpenMAICArtifact` 或对应业务审计表。
3. A3 能力页只展示可验证证据，不把 OpenMAIC 原始页面当作产品完成度。
4. 每个新增按钮必须对应真实 API、真实路由，或明确显示不可用原因。
5. 不得在前端本地 mock OpenMAIC 成功结果冒充真实接入。
