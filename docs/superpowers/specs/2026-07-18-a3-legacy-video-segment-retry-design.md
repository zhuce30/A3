# A3 旧视频失败片段通用迁移设计

## 1. 背景

持久化视频任务上线前，OpenMAIC 视频生成任务只存在于 Next.js 进程内存。旧任务完成后，资源包仅保留 `openmaic_video` artifact，没有 Django `VideoGenerationJob`、`VideoGenerationSegment`、Seedance `taskId` 或可恢复的 `jobId`。

生产环境现有一个典型旧 artifact：第 1、2 段失败，第 3-6 段成功且仍有可播放地址。直接重新生成会重复生成四个成功片段，增加费用并破坏用户对既有产物的预期。

本功能提供通用兼容迁移：保留旧 artifact 的成功片段，只为失败片段创建新的持久化任务。后续其他符合条件的旧视频也使用相同入口，不依赖服务器人工修复。

## 2. 目标与非目标

### 2.1 目标

- 识别“无 `jobId`、部分成功、部分失败”的旧 `openmaic_video` artifact。
- 在产生 Seedance 费用前显示确认对话框。
- 将成功片段导入现有持久化任务模型，保持原视频地址、尺寸和时长。
- 只将失败片段设为待生成并派发 Celery。
- 重复点击、刷新和响应丢失时复用同一迁移任务，避免重复付费。
- 新任务完成后写回带 `jobId` 的完整 artifact。
- 不改变现有新任务的失败片段重试接口和行为。

### 2.2 非目标

- 不恢复旧 Next.js 进程中已经丢失的 Seedance `taskId`。
- 不修改或重新上传成功片段的视频文件。
- 不允许浏览器指定成功片段视频地址。
- 不新增视频任务数据表。
- 不自动迁移所有历史 artifact；只有用户确认后才创建付费任务。

## 3. 资格判定

旧 artifact 必须同时满足以下条件：

1. `type` 为 `openmaic_video`。
2. `jobId` 为空。
3. 至少一个 segment 的状态为 `succeeded` 且 `videoUrl` 非空。
4. 至少一个 segment 的状态为 `failed`。
5. segment 编号唯一，范围为 1-6。
6. artifact 属于当前登录用户可访问的资源包。

不满足资格时不显示迁移按钮，后端即使收到直接请求也返回可读的 400 错误。

## 4. 用户交互

资源视频页检测到合格旧 artifact 时，显示“补生成失败片段”操作。点击后先打开确认对话框，不立即调用 provider。

确认框展示：

- 失败片段编号和标题，例如“第 1 段 导入、第 2 段 概念”。
- 即将调用 Seedance 的片段数量。
- 将保留的成功片段数量。
- “保留成功片段，不会重复生成”的明确说明。

用户取消时不调用任何 API。用户确认后按钮进入加载状态，禁止重复提交，并显示持久化任务进度。页面刷新后通过资源包 ID 查找近期任务并恢复轮询。

如果补生成后仍有失败片段，页面进入现有“只重试失败片段”流程。已导入和新生成的成功片段继续可播放。

## 5. 接口设计

### 5.1 Django 接口

```text
POST /api/resources/packs/<pack_id>/video-jobs/import-legacy/
```

请求字段：

```json
{
  "provider": "seedance",
  "resourceType": "micro_video_script",
  "duration": 60,
  "aspectRatio": "16:9",
  "resolution": "1080p",
  "segments": [
    {
      "index": 1,
      "title": "导入",
      "prompt": "标准化后的第一段提示词",
      "duration": 10
    }
  ]
}
```

`segments` 包含完整 1-6 段提示词定义，使导入后的任务具有完整可审计结构。成功片段的视频证据必须由 Django 从旧 artifact 读取，不能从请求体读取。

响应沿用现有持久化任务格式：

```json
{
  "success": true,
  "created": true,
  "importedSucceeded": 4,
  "queuedFailed": 2,
  "job": {
    "jobId": "a3_legacy_video_...",
    "status": "queued",
    "segments": []
  }
}
```

### 5.2 Next API

现有 `/api/a3/resources/openmaic-video` 增加 PATCH action：

```json
{
  "action": "import-legacy-failures",
  "resourcePackId": "...",
  "prompt": "..."
}
```

Next 继续使用现有 `buildSegmentedVideoRequests` 生成六个标准 10 秒提示词，再代理至 Django。浏览器不提交成功视频地址、provider taskId 或内部 worker token。

## 6. 后端数据流

1. 校验登录状态和资源包所有权。
2. 从服务端资源包记录中选择最新的合格旧 `openmaic_video` artifact。
3. 对 artifact 规范化后计算稳定指纹，输入至少包括用户 ID、资源包 ID、artifact 创建时间、segment 编号、状态和成功视频地址摘要。
4. 从指纹生成确定性 `jobId`，前缀为 `a3_legacy_video_`。
5. 在 `transaction.atomic()` 和唯一 `job_id` 约束下执行 `get_or_create`。
6. 新建任务时创建 1-6 个 `VideoGenerationSegment`：
   - 旧成功片段写为 `succeeded`，复制服务端 artifact 中的视频地址、尺寸、时长，并设置完成时间。
   - 旧失败片段写为 `pending`，不设置 provider taskId 和视频地址。
7. 事务提交后只派发一次 `advance_video_generation_job`。
8. 状态机跳过成功片段，从最小编号的 pending 片段开始提交。
9. 全部待生成片段终止后，现有 finalization 逻辑生成带 `jobId` 的完整新 artifact 并写回资源包。

重复请求命中相同 `jobId` 时返回已有任务，不创建 segment，也不再次派发 Celery。

## 7. 一致性与安全

- 成功视频 URL、尺寸和时长只接受 Django 读取到的旧 artifact 数据。
- 请求中的 segment 只提供提示词和生成参数；编号必须与旧 artifact 完整对应。
- 每个请求重新校验资源包所有权。
- 确定性 `jobId` 防止双击、刷新和响应丢失造成重复计费。
- 旧 artifact 在新任务最终写回前保持不变，迁移中断不会丢失既有视频。
- provider token、Seedance taskId、完整 signed URL 不进入前端日志或错误信息。
- 导入任务继续受现有两小时安全截止、网络重试、provider 自动重试一次和失败片段手动重试规则约束。

## 8. 错误处理

- 没有合格旧 artifact：返回 400，“当前视频不需要旧任务迁移”。
- segment 定义不完整或编号不匹配：返回 400，不创建任务。
- 资源包不存在或不属于当前用户：返回 404。
- Celery 暂时不可用：任务保留为 queued，由恢复命令重新派发。
- 重复请求：返回 200 和既有 job，`created=false`。
- 新任务再次部分失败：写回 partial artifact，页面继续提供现有失败片段重试按钮。

## 9. 前端状态

页面需要覆盖：

- 合格旧 artifact 的迁移提示。
- 确认对话框。
- 用户取消状态。
- 提交 loading 状态。
- 后台轮询和刷新恢复状态。
- 成功片段保留展示。
- 迁移 API 错误和 provider 失败提示。
- 迁移完成后的完整或 partial 结果。

确认框使用现有 Dialog 组件，不新增嵌套卡片。主按钮使用 RefreshCw 图标和“补生成失败片段”文案。

## 10. 测试方案

### 10.1 后端

- 只有部分成功、部分失败且无 `jobId` 的 artifact 可以迁移。
- 成功片段 URL、尺寸和时长由服务端 artifact 导入。
- 失败片段保持 pending，且只派发一个 advance task。
- 重复请求返回同一 job，不重复派发。
- 不同用户不能迁移他人的资源包。
- 请求体伪造视频 URL 不会进入数据库。
- segment 缺失、重复或编号不匹配时拒绝创建。
- finalization 保留导入成功片段并补齐失败片段。

### 10.2 前端

- 合格旧 artifact 显示迁移按钮和正确数量。
- 点击先显示确认框，取消不请求 API。
- 确认后发送 `import-legacy-failures`，不发送成功视频 URL。
- 返回 job 后复用现有轮询逻辑。
- 新任务 artifact 继续显示原有“只重试失败片段”。

### 10.3 生产验收

1. 对当前旧死锁视频执行迁移。
2. 记录第 3-6 段迁移前后的 URL 摘要，确认保持不变。
3. 确认数据库只创建一个 job，只有第 1、2 段进入 provider 提交。
4. 确认页面刷新后仍恢复同一 job。
5. 完成后检查新 artifact 含 `jobId` 和六段状态。

## 11. 部署与回滚

部署需要同时更新 backend、celery、celery-beat 和 frontend，不新增 migration。上线后旧 artifact 不会自动改变，只有用户确认时才迁移。

回滚时保留已经创建的 `VideoGenerationJob` 和 `VideoGenerationSegment`。旧页面仍可播放成功片段；再次部署新版本后可继续轮询或重试。不得删除已导入的成功片段记录。
