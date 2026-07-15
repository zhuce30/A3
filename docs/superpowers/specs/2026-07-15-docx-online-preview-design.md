# A3 系统资料 DOCX 在线预览设计

日期：2026-07-15

## 1. 目标

让 `/a3/library/[resourceCode]` 中的讲解文档和实操案例可以在站内直接预览 Word 内容，同时保留原始 DOCX 下载能力。

成功标准：

- 学生点击“在线预览”后，不离开 A3 即可阅读转换后的 PDF。
- “下载原文档”始终返回原始 DOCX，不与预览接口混用。
- 预览接口必须校验登录和平台资料状态，不能暴露服务器存储路径。
- 同一版本 DOCX 只转换一次；后续请求复用缓存。
- 转换失败时页面显示正常中文错误，并继续提供原文下载和 Markdown 内容预览。

## 2. 方案选择

采用“LibreOffice Writer 将 DOCX 转换为 PDF，再由浏览器站内预览”的方案。

不采用 Microsoft Office 在线查看器，因为它依赖外部服务和可公开访问的文档 URL，不适合平台受保护资料。Markdown 内容预览继续保留，作为检索结果展示和转换失败时的降级能力，但不承担还原 Word 排版的职责。

## 3. 后端设计

### 3.1 转换服务

新增独立转换模块，职责仅包括：

1. 校验源文件存在且扩展名为 `.docx`。
2. 根据资源编号和 `content_hash` 生成稳定缓存文件名。
3. 使用 `soffice --headless --convert-to pdf` 在临时目录转换。
4. 使用原子移动写入持久化缓存目录。
5. 返回 PDF 路径；转换异常统一转为可读错误，不暴露命令行和本地路径。

缓存目录位于已挂载的 `KNOWLEDGE_UPLOAD_ROOT/previews/curated/`，因此容器重建后仍可复用。源文件内容变化后 `content_hash` 变化，会生成新缓存，不复用旧版本。

为避免并发首次访问重复转换，转换过程使用基于目标文件的进程内锁。首版生产 backend 为单容器多 worker；即使两个 worker 同时转换，原子写入仍保证最终文件完整。后续如扩展多实例，再升级为 Redis 分布式锁。

### 3.2 API

新增：

```text
GET /api/kb/library/<resourceCode>/preview/
```

行为：

- 未登录：`401`。
- 资源不存在、未核验或已停用：`404`。
- 非站内 DOCX：`400`。
- 原文件缺失：`404`，返回“资料原文件暂时不可用”。
- LibreOffice 不可用或转换失败：`503`，返回“Word 在线预览暂时不可用，可下载原文档”。
- 成功：`200 application/pdf`，`Content-Disposition: inline`。

现有内容接口继续作为下载源，但默认改为附件下载语义：

```text
GET /api/kb/library/<resourceCode>/content/
```

详情响应中的 `action` 拆为：

```json
{
  "preview": {
    "available": true,
    "href": "/api/kb/library/OS-DOC-001/preview/",
    "label": "在线预览"
  },
  "download": {
    "href": "/api/kb/library/OS-DOC-001/content/",
    "label": "下载原文档"
  }
}
```

外部视频不返回文档预览字段。

### 3.3 运行环境

后端 Docker 镜像增加 `libreoffice-writer`，保留现有 `libreoffice-impress`。构建后通过运行时测试确认 `soffice` 可发现，且 DOCX 转 PDF 能生成非空 PDF。

## 4. 前端设计

系统资料详情页对站内文档展示：

- 主按钮：“在线预览”。
- 次按钮：“下载原文档”。
- 当前“资料内容预览”区域优先显示内嵌 PDF。
- PDF 加载期间显示稳定高度的加载状态，避免页面跳动。
- PDF 加载失败时展示错误和“重新加载”，并在下方保留解析后的 Markdown 内容。
- 移动端不强制嵌入宽 PDF；提供全宽“打开 PDF 预览”按钮，并继续显示 Markdown 摘要。

PDF 使用受登录保护的后端 URL，不接入第三方查看器。打开预览与下载分别写入 `resource_opened` 事件，`metadata.action` 分别为 `preview` 和 `download`。

## 5. 安全与资源限制

- 转换命令只接收数据库关联的受管文件，不接受用户传入路径。
- 不把 `stored_path`、转换目录或 subprocess 输出返回前端。
- 限制源文件大小；沿用知识库上传上限，超过上限不触发同步转换。
- 转换设置超时，超时后终止子进程并清理临时目录。
- PDF 响应增加 `X-Content-Type-Options: nosniff` 和私有缓存策略。
- 不删除原 DOCX，不修改知识库索引内容。

## 6. 测试与验收

后端测试：

- 已登录用户可获得 `application/pdf`。
- 未登录、外部视频、停用资源和原文件缺失返回正确状态。
- 第二次请求命中缓存，不重复调用 LibreOffice。
- 详情响应不包含 `stored_path`，并同时提供预览与下载动作。
- 转换失败返回可读中文错误。

前端测试：

- 文档详情同时显示“在线预览”和“下载原文档”。
- PDF iframe 使用 `resolveA3Endpoint` 解析受保护 URL。
- 加载、错误、Markdown 降级和移动端入口均存在。
- 视频详情不渲染 Word 预览控件。

端到端验收：

```text
登录学生账号
-> 打开 /a3/library/OS-LAB-003
-> 点击在线预览
-> 页面内出现非空 PDF
-> 下载原文档得到 DOCX
-> 服务器日志不包含本地路径泄露
```

## 7. 部署与回滚

部署需要重新构建后端和前端镜像。服务器更新镜像后重建 `backend`、`celery`、`celery-beat`、`frontend` 和 `caddy`；预览转换由 backend 执行，不需要新增服务。

回滚只需恢复上一版前后端镜像。新生成的 PDF 缓存是派生文件，不参与数据库迁移，也不会阻塞旧版本运行。
