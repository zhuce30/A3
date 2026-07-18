# A3 持久化视频生成任务设计

## 1. 背景与问题

当前 `/api/a3/resources/openmaic-video` 在 Next.js 进程内使用 `Map<string, VideoJob>` 保存任务，并在一个请求链路中顺序生成六个视频片段。frontend 重启后任务立即丢失。Seedance adapter 最长轮询 300 秒，Next 视频接口 `maxDuration` 也是 300 秒，边界竞争会把真实超时压缩成无法诊断的 `fetch failed`。

生产已经出现 1,419 秒的部分成功任务：前两段请求断开，后四段成功。任务没有保存 Seedance taskId，无法继续轮询原任务，也无法只重试失败片段。

## 2. 目标

- Django/MySQL 持久化总任务、六个分段和每个 Seedance taskId。
- frontend、backend、Celery 或浏览器重启后任务仍可查询和继续。
- 每个分段只提交一次；排队或轮询超过 5 分钟时继续轮询原 taskId，不重新提交。
- 网络错误自动重试一次，重试的是查询请求，不清空 provider taskId。
- Seedance 明确返回 failed 时允许自动重新提交一次；第二次仍失败后标记该段失败。
- 页面支持“仅重试失败片段”，成功片段不重新生成、不重复计费。
- 保持现有 Next API 响应和 `openmaic_video` artifact 展示兼容。
- 单并发 Celery worker不能被长时间 sleep 占用。

## 3. 不在本批范围

- 不并行提交六段视频，避免触发 provider 限流和不可控费用。
- 不拼接六段为单个服务器端 MP4，仍由页面连续播放。
- 不迁移其他视频 provider；本批持久化状态机先覆盖 Seedance，保留 provider 扩展字段。
- 不把 API key、provider taskId 或 signed URL 输出到日志和公开页面。

## 4. 方案选择

采用“Django 数据库状态机 + Celery 短任务自调度 + Next 内部 Seedance submit/poll bridge”。

不采用 Redis-only 状态，因为 Redis 清理后审计记录会丢失；不采用 Celery 单任务内循环 sleep，因为生产 worker 固定单并发，会阻塞知识库和资源生成；不把 Seedance SDK 重写到 Python，以避免维护两套 provider 适配器。

## 5. 数据模型

### `VideoGenerationJob`

- `job_id`：公开稳定 ID，唯一。
- `user`：任务所有者。
- `resource_pack_id`、`resource_type`。
- `provider`、`status`、`stage`、`progress`、`message`。
- `requested_duration`、`aspect_ratio`、`resolution`。
- `celery_task_id`、`trace_id`。
- `error_message`、`created_at`、`started_at`、`finished_at`、`updated_at`。

状态：`queued`、`running`、`partial`、`succeeded`、`failed`。

### `VideoGenerationSegment`

- `job` + `index` 唯一。
- `title`、`prompt`、`duration`、`aspect_ratio`、`resolution`。
- `status`：`pending`、`submitting`、`polling`、`succeeded`、`failed`。
- `provider_task_id`：Seedance taskId，仅后端可见。
- `submission_attempts`：最多 2 次。
- `poll_attempts`、`network_retry_count`、`last_polled_at`。
- `video_url`、`width`、`height`。
- `error_code`、`error_message`、时间字段。

公开序列化不返回 `prompt`、`provider_task_id`、Celery ID 和完整 provider 错误体。

## 6. Provider 内部桥接

Next 新增只供 Docker 内网调用的 provider API，支持：

```json
{"action":"submit","provider":"seedance","prompt":"...","duration":10,"aspectRatio":"16:9","resolution":"1080p"}
```

返回：

```json
{"success":true,"providerTaskId":"...","status":"queued"}
```

轮询请求：

```json
{"action":"poll","provider":"seedance","providerTaskId":"..."}
```

返回 `queued/running/succeeded/failed` 及成功视频信息。接口使用独立 `A3_VIDEO_WORKER_TOKEN` 验证，生产 Caddy 不暴露该能力；即使路径可达，没有 token 也必须返回 403。

## 7. Celery 状态机

```text
创建任务与六个 pending segment
-> enqueue advance_video_job(job_id)
-> 选择最小 index 的未完成 segment
-> 无 provider_task_id：短请求 submit，立即保存 taskId
-> enqueue poll_video_segment(job_id, index), countdown=5
-> worker 释放
-> poll 返回 queued/running：保存状态，再次 countdown=5
-> 网络错误：同一 taskId 自动重试一次，再次调度
-> succeeded：保存 URL，推进下一段
-> provider failed：submission_attempts < 2 时清除旧 taskId并重新提交一次
-> 第二次 provider failed：标记该段 failed，推进下一段
-> 所有段终态：生成 succeeded/partial/failed artifact并写回资源包
```

Celery task 使用 `acks_late`，每一步必须幂等。提交前使用数据库行锁；如果 segment 已有 `provider_task_id`，绝不重复 submit。轮询任务重复投递只能增加一次有效状态更新，不能创建新 provider 任务。

任务允许持续轮询最多 2 小时。超过 2 小时后标记 provider timeout，但保留 taskId 供人工诊断；不以 5 分钟作为失败阈值。

## 8. API 与兼容

Django 新增：

- `POST /api/resources/packs/<pack_id>/video-jobs/`：创建持久化任务。
- `GET /api/resources/video-jobs/<job_id>/`：获取任务和分段状态。
- `GET /api/resources/video-jobs/`：列出当前用户近期任务。
- `POST /api/resources/video-jobs/<job_id>/retry-failed/`：仅重置 failed 分段。

Next `/api/a3/resources/openmaic-video` 保留原有 POST/GET 入口，但改为 Django 代理，不再维护内存 Map。其响应继续包含 `jobId`、`status`、`progress`、`stage`、`message`、`pollUrl`、`artifact`、`resourcePack` 和 `error`。

任务完成后调用现有 `record_openmaic_video_artifact`，继续生成 `a3.openmaic-video-artifact.v1`；新增 `jobId` 并保留所有 segment 状态，资源记录页无需更换数据源。

## 9. 前端体验

- 生成页轮询持久化 job，刷新或重新登录后从近期任务列表恢复。
- 进度显示当前分段、provider 排队/生成状态和已成功数量。
- 超过 5 分钟显示“仍在云端生成，可离开页面”，不显示失败。
- `partial/failed` 时显示“重试失败片段”，按钮旁说明已成功片段不会重复生成。
- 点击重试后只重置 failed segment；成功片段继续可播放。
- retry 进行中禁止重复点击。

## 10. 错误与安全

- 401/403：保持现有登录和资源所有权校验。
- provider 明确失败：保存可读错误代码，页面展示简化中文原因。
- 网络失败：保留 provider taskId，继续轮询，不重新提交。
- Celery broker 暂时不可用：任务保留 queued，可由恢复命令或下一次请求重新派发。
- frontend provider bridge 不记录 token、API key、完整 prompt 和 signed video URL。
- API 不返回其他用户任务，手动重试必须校验任务所有者。

## 11. 可观测性

- 记录 job/segment 状态转换、耗时、submissionAttempts、pollAttempts 和 errorCode。
- 日志只包含内部 job_id、segment index 和脱敏 provider task hash。
- 能力总览可统计成功、部分成功、失败和重试次数，但不展示 provider taskId。
- 提供管理命令扫描长时间未调度的 queued/polling 任务并重新派发。

## 12. 验收标准

- frontend 容器重启后任务仍可查询并继续。
- backend/Celery worker 重启后已有 taskId 的片段不会重复提交。
- 模拟 6 分钟 provider running 后，任务仍为 polling 而不是 failed。
- 模拟一次网络错误后继续轮询同一 taskId。
- 模拟第一、二段失败且后四段成功，手动重试只操作第一、二段。
- 重试后 artifact 合并为 6/6，不覆盖已成功 URL。
- Django API 权限、幂等、迁移、Celery状态机和 Next 代理测试通过。
- TypeScript、lint、Django check、相关 Vitest 和生产 Compose 合并验证通过。

## 13. 部署与回滚

部署顺序：先执行数据库 migration并更新 backend/Celery，再更新 frontend；旧 frontend 在滚动窗口仍可读取已有 artifact，但新任务只在新 API 就绪后创建。上线前在 `.env.production` 写入随机 `A3_VIDEO_WORKER_TOKEN`，backend/Celery/frontend 使用同一值。

回滚时保留新表，不删除任务数据；Next 可以临时切回旧入口，但回滚窗口内禁止创建新内存任务。已持久化任务可在再次部署新版本后继续。
