# A3 LightRAG 独立服务接入方案

本文记录后续升级方向：A3 不在 Django 进程内直接嵌入 LightRAG SDK，而是连接独立运行的 LightRAG Server REST API。该方案先作为设计备忘保留，后续实现时再拆分任务。

## 1. 目标

将当前 A3 本地知识库从“文档切块 + embedding + FAISS 检索”升级为 LightRAG 风格的双索引知识库：

```text
原始资料
-> 文档解析与切块
-> LLM 抽取实体、关系、摘要、关键词，构建图谱知识库
-> embedding 生成文本块、实体、关系向量，构建向量知识库
-> 查询时结合图谱检索、向量检索和混合检索
-> A3 课堂、推荐、辅导、测评引用知识库证据
```

升级后 `/a3/knowledge-base` 的主视图应是“知识库可视化”，而不是普通文件列表。

## 2. 为什么选择独立 LightRAG Server

推荐方式：A3 后端通过 REST API 调用独立 LightRAG Server。

原因：

- LightRAG 的 LLM、embedding、图存储、向量存储依赖较重，独立服务更容易部署、重启和排错。
- A3 Django 后端继续负责用户、权限、学习闭环、资源状态和审计，不被知识库引擎细节耦合。
- 后续可以单独替换 LightRAG 的模型、存储后端或启动参数，不影响 A3 主业务。
- 没有 LLM key 或 LightRAG 服务不可用时，A3 可以明确降级到现有 FAISS / 关键词检索。

不推荐方式：直接在 Django 里嵌入 LightRAG SDK。这样会让 Web 请求、Celery 任务、模型运行时、图谱存储耦合在一个 Python 环境里，后续运维风险更高。

## 3. 组件边界

```text
A3 Frontend /a3/knowledge-base
  |
  | GET /api/kb/resources/
  | GET /api/kb/jobs/
  | GET /api/kb/search/
  | GET /api/kb/graph/
  | POST /api/kb/resources/upload/
  | POST /api/kb/rebuild/
  v
A3 Django Backend
  - 权限校验
  - 文件保存
  - 资源状态
  - 索引任务编排
  - Agent trace / demo evidence
  - LightRAG API adapter
  |
  | REST API
  v
LightRAG Server
  - LLM 实体关系抽取
  - embedding 向量化
  - graph retrieval
  - vector retrieval
  - hybrid / mix query
  - graph 数据导出
```

## 4. 后端改造建议

### 4.1 配置项

新增环境变量：

```text
A3_LIGHTRAG_ENABLED=1
A3_LIGHTRAG_BASE_URL=http://localhost:9621
A3_LIGHTRAG_API_KEY=
A3_LIGHTRAG_DEFAULT_MODE=mix
A3_LIGHTRAG_TIMEOUT_SECONDS=120
```

要求：

- 未启用或服务不可达时，不影响现有知识库页面和检索。
- API key 只保存在后端环境变量，不写入前端页面、日志或文档样例。

### 4.2 Adapter 层

建议新增：

```text
backend/domains/knowledge_base/lightrag_client.py
```

职责：

- 封装 LightRAG Server REST API。
- 统一超时、错误、重试和降级。
- 将 LightRAG 返回格式转换成 A3 内部格式。

建议方法：

```python
class LightRAGClient:
    def health(self) -> dict: ...
    def insert_text(self, text: str, metadata: dict) -> dict: ...
    def insert_file(self, file_path: str, metadata: dict) -> dict: ...
    def query(self, query: str, mode: str = "mix", top_k: int = 5) -> dict: ...
    def graph(self, limit: int = 200, query: str | None = None) -> dict: ...
```

### 4.3 索引任务

现有上传链路保留：

```text
POST /api/kb/resources/upload/
-> 保存到 D:\Download\A3\data\uploads
-> 创建 KnowledgeResource
-> 创建 KnowledgeIndexJob
```

后续索引任务增加双阶段状态：

```text
uploaded
-> graph_indexing       # LLM 构建实体关系
-> vector_indexing      # embedding 构建向量索引
-> indexed
```

为了兼容现有枚举，也可以先不改数据库枚举，在 `KnowledgeIndexJob.result` 中增加：

```json
{
  "lightrag": {
    "enabled": true,
    "graphIndexed": true,
    "vectorIndexed": true,
    "mode": "mix",
    "nodeCount": 128,
    "edgeCount": 214
  }
}
```

### 4.4 检索优先级

`/api/kb/search/` 建议按以下顺序：

```text
LightRAG mix / hybrid
-> 当前 FAISS 向量检索
-> 当前 lexical 关键词检索
```

响应中必须带检索来源：

```json
{
  "success": true,
  "mode": "mix",
  "engine": "lightrag",
  "fallback": false,
  "results": []
}
```

如果降级：

```json
{
  "success": true,
  "engine": "faiss",
  "fallback": true,
  "fallbackReason": "LightRAG server unavailable",
  "results": []
}
```

### 4.5 图谱 API

新增 A3 后端接口：

```text
GET /api/kb/graph/?q=&limit=200
```

返回给前端的稳定格式：

```json
{
  "success": true,
  "engine": "lightrag",
  "nodes": [
    {
      "id": "复习反馈控制",
      "label": "复习反馈控制",
      "type": "concept",
      "weight": 0.86,
      "sourceCount": 5
    }
  ],
  "edges": [
    {
      "id": "edge-1",
      "source": "反馈控制",
      "target": "稳定性",
      "label": "影响",
      "weight": 0.74
    }
  ],
  "stats": {
    "nodeCount": 128,
    "edgeCount": 214,
    "documentCount": 16,
    "updatedAt": "2026-07-03T00:00:00Z"
  }
}
```

## 5. `/a3/knowledge-base` 页面改造

页面主任务：让用户看到“资料已经形成了哪些知识结构，以及检索会引用哪些证据”。

建议布局：

```text
顶部：知识库状态栏
  - 图谱索引状态
  - 向量索引状态
  - 文档数量
  - 节点 / 边数量
  - 最近构建时间

中部主区域：知识图谱可视化
  - 节点：概念、章节、公式、案例、资料
  - 边：包含、先修、解释、应用、关联
  - 支持搜索、聚焦、过滤类型

右侧：选中节点详情
  - 摘要
  - 相关资料
  - 引用片段
  - 关联知识点

底部或侧栏：资料管理
  - 上传文件
  - 重建索引
  - 最近任务
  - 失败原因
```

UI 要求：

- 不把 LightRAG 原始 WebUI iframe 到 A3。
- A3 自己展示学习软件语境下的图谱和证据。
- 服务未启用时展示“图谱索引未启用”，不能伪造节点和边。
- 检索结果必须显示来源、模式和是否降级。

## 6. 数据安全

- 不在前端暴露 LightRAG Server 地址、API key、本地文件路径。
- 前端只访问 A3 Django API。
- 后端返回文件名和安全化来源名，不返回 `D:\...` 绝对路径。
- LightRAG 错误信息需要转换为用户可读中文，不能直接暴露 traceback。

## 7. 验证计划

基础验证：

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py check

cd D:\Download\A3\OpenMAIC
npx.cmd tsc --noEmit
```

后端专项测试建议：

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base
```

新增测试点：

- LightRAG 未启用时，`/api/kb/search/` 仍回退现有 FAISS / lexical。
- LightRAG 服务不可达时，响应包含 `fallback=true` 和中文原因。
- `/api/kb/graph/` 返回稳定 `nodes/edges/stats` 格式。
- 前端知识库页面能展示空图谱、构建中、构建失败和构建成功状态。

## 8. 后续实施顺序

建议分三批：

1. 后端接入层
   - 增加配置项。
   - 增加 `LightRAGClient`。
   - 增加 `/api/kb/graph/`。
   - `/api/kb/search/` 支持 LightRAG 优先和降级。

2. 索引任务
   - 上传后调用 LightRAG Server 入库。
   - 重建索引时批量提交 `D:\Download\A3\data` 资料。
   - 在 `KnowledgeIndexJob.result` 记录图谱和向量索引状态。

3. 前端可视化
   - `/a3/knowledge-base` 主区域改为知识图谱。
   - 保留文件管理和任务列表。
   - 增加检索模式、节点详情、降级提示和证据引用。

