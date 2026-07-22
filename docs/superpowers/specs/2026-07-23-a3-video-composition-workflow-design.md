# A3 视频旁白与最终成片工作流设计

## 目标

在现有持久化 Seedance 分段视频任务之上，补齐结构化分镜校验、云端旁白、WebVTT 字幕和服务器端最终 MP4 合成。整个流程必须异步、可恢复、可单步重试，不占用 Web 后端 worker，也不依赖浏览器 `ffmpeg.wasm`。

## 已有基线

- `VideoGenerationJob` 和 `VideoGenerationSegment` 已保存 MySQL 状态、Seedance `taskId` 和本地视频路径。
- Celery 已负责提交、轮询、下载和失败片段重试。
- 片段视频通过登录态鉴权和 HTTP Range 接口播放。
- 资源脚本已有 `scene`、`visual`、`narration`、`durationSeconds`、`sourceIds`，但视频任务目前没有完整保存这些字段。

## 架构

```text
VideoDirectorAgent
  -> 规范化 visual / narration / duration / sourceIds
  -> 估算旁白时长并标记是否适配片段
  -> VideoGenerationSegment 持久化

用户编辑旁白、选择音色与语速
  -> POST generate-narration
  -> video-worker 调用 Qwen/DashScope TTS
  -> 每段 WAV 持久化并用 ffprobe 校验真实时长
  -> 生成 narration.txt 与 subtitles.vtt

用户点击合并最终视频
  -> POST compose
  -> video-worker 用 FFmpeg 统一分辨率、帧率和编码
  -> 每段视频混入对应旁白
  -> concat 输出 final.mp4
  -> 登录态 Range 播放和文件下载
```

## 数据模型

`VideoGenerationSegment` 新增：

- `visual`、`narration`、`source_ids`
- `narration_estimated_ms`、`narration_fits`
- `audio_status`、`audio_path`、`audio_content_type`
- `audio_file_size`、`audio_sha256`、`audio_duration_ms`
- `audio_playback_id`

新增 `VideoComposition`，与视频总任务一对一：

- 状态：`draft`、`narration_queued`、`narrating`、`ready`、`compose_queued`、`composing`、`succeeded`、`failed`
- TTS 配置：provider、model、voice、speed
- 输出：旁白全文、WebVTT、最终 MP4 相对路径与文件元数据
- 恢复字段：Celery task id、旁白/合成尝试次数、错误码和错误信息
- 最终播放使用独立 UUID，不暴露服务器路径

## 旁白校验

- 中文按约每秒 4 个可读字符估算，英文按每秒 2.5 个单词估算，并按用户语速修正。
- 分镜创建和旁白编辑时都返回 `estimatedNarrationMs`、`narrationFits` 和可读提示。
- 生成旁白前必须全部通过估算校验，避免付费生成明显超时音频。
- TTS 完成后再用 `ffprobe` 校验真实时长；超出片段时长时只将该段标为失败，允许编辑后单独重新生成旁白。

## TTS 与合成

- 默认使用 Qwen3 TTS Flash，密钥优先级为 `A3_VIDEO_TTS_API_KEY`、`TTS_QWEN_API_KEY`、`DASHSCOPE_API_KEY`、`QWEN_API_KEY`、`A3_LLM_API_KEY`。
- 服务端不接受前端传入 API key 或任意 TTS base URL。
- `video-worker` 单并发，只监听 `video-compose` 队列。
- FFmpeg 统一输出 H.264/AAC、`yuv420p`、30fps；各片段先标准化并混入旁白，再无损 concat。
- 中间文件使用任务目录并在成功或失败后清理，最终文件、音频、字幕和旁白稿保留在 `a3-video-data`。

## API

- `GET/PATCH /api/resources/video-jobs/<job_id>/composition/`
- `POST /api/resources/video-jobs/<job_id>/composition/generate-narration/`
- `POST /api/resources/video-jobs/<job_id>/composition/compose/`
- `POST /api/resources/video-jobs/<job_id>/composition/retry/`
- `GET /api/resources/video-compositions/<playback_id>/playback/`
- `GET /api/resources/video-compositions/<playback_id>/download/<asset>/`
- `GET /api/resources/video-audio/<audio_playback_id>/`

所有接口校验登录用户和任务归属；错误返回正常中文，不返回路径、密钥或 traceback。

## 前端

新增 `/a3/resources/[packId]/video/compose`：

- 顶部显示最终成片状态和预览。
- 四阶段进度：分镜、片段、旁白、合并。
- 分镜列表支持编辑旁白、显示估算时长和超时提示、试听已生成音频。
- 音色使用下拉菜单，语速使用滑块。
- “生成旁白”和“合并最终视频”是两个独立命令。
- 失败时只显示对应步骤的重试按钮。
- 成功后下载 MP4、旁白 TXT 和字幕 VTT。
- 原 `/video` 页面继续展示单片段并新增进入成片工作台的入口。

## 失败与恢复

- TTS 某一段失败不会删除其他成功音频。
- 重新编辑旁白只使对应段音频失效。
- FFmpeg 失败保留旁白和字幕，用户只重试合并。
- worker 重启后，数据库仍保留状态；重复提交通过事务锁和状态判断防止并发执行。
- 缺少 TTS key、FFmpeg、源片段或文件损坏均返回明确中文错误。

## 验证

- 后端模型、估算、VTT、TTS、FFmpeg 命令、API 权限和任务幂等测试。
- Next API 代理与 compose 页面契约测试。
- `manage.py check`、迁移一致性、TypeScript、定向 ESLint、Compose 合并检查。
- 生产环境验证 `video-worker` 单并发、共享卷、迁移、页面访问和任务状态。
