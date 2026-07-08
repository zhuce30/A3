# A3 多模态 RAG 与本地知识库建设方案

版本：v0.1  
日期：2026-07-04  
适用项目：智学引擎 A3  
状态：设计稿，待评审后拆分实施计划

## 1. 背景与结论

A3 当前知识库链路已经具备上传、索引、检索、引用展示和课堂/辅导接入能力，但技术形态仍以文本 RAG 为主。现有 PPTX 处理只抽取幻灯片中可读的文本框内容；图片型课件、扫描 PDF、公式截图、图表、手写题目和嵌入图片里的文字不能稳定进入知识库。因此，当前能力不能按“多模态本地知识库”验收。

本设计将知识库升级为多模态 RAG 基础设施。目标不是让前端“可以上传更多格式”，而是让用户上传的 PDF、PPTX、图片、XLSX、后续 DOCX 等资料能够被解析、索引、检索、引用、验证，并能在 AI 课堂/面对面辅导中作为视觉证据参与回答。

核心结论：

- 文件上传成功不等于入库成功。A3 必须记录解析质量、索引质量和检索可用性。
- PPTX 不能只用 `python-pptx` 读文本框，必须把每页幻灯片渲染为图片，并对图片、公式、图表、表格做 OCR/视觉解析。
- 图片不能只作为聊天附件临时送给模型，必须能沉淀为知识库资源，参与后续检索和引用。
- 多模态 RAG 至少需要三类索引：文本/Markdown 索引、关键词/BM25 索引、页面/幻灯片/图片视觉索引。
- 回答阶段需要把检索到的文本证据和页面图片证据一起交给多模态 LLM/VLM，生成带来源、页码/幻灯片号、证据类型和 verified 状态的答案。

## 2. 技术依据

本方案参考以下方向，实施时优先选稳定、可本地部署、可替换的组件。

| 方向 | 代表技术 | 作用 | 对 A3 的启发 |
|---|---|---|---|
| 文档结构化解析 | MinerU、Docling | 将 PDF、PPTX、图片等解析成 Markdown/JSON，保留页面、表格、公式、版面结构 | A3 需要先把资料变成结构化多模态知识单元，而不是直接丢给 embedding |
| OCR 与版面理解 | PaddleOCR、RapidOCR、MinerU OCR、Docling OCR | 识别扫描页、截图、图片里的文字和版面块 | PPTX 图片页、扫描 PDF、题目截图必须依赖 OCR |
| 视觉文档检索 | ColPali / ColQwen2 思路 | 直接对页面图片做视觉向量检索，减少 OCR 丢失布局和图表信息 | A3 的课件页、图表页、公式页需要可被视觉检索命中 |
| 混合检索 | dense vector + BM25 + rerank | 兼顾语义匹配和关键词精确匹配 | 自动控制课程中公式、术语、符号必须有关键词兜底 |
| 多模态答案生成 | OpenAI vision / Qwen-VL / InternVL 等 | 将文本证据和页面图片一起输入模型回答 | 课堂/辅导不能只看 OCR 文本，应能看原图和幻灯片 |
| 工程化 RAG 平台 | RAGFlow / DeepDoc、RAG-Anything、LightRAG | 提供文档解析、知识图谱、混合检索和可视化思路 | 可以借鉴架构，但 A3 后端仍负责用户、权限、学习闭环和审计 |

参考资料：

- MinerU: https://github.com/opendatalab/MinerU
- Docling: https://www.docling.ai/
- Docling DocumentConverter: https://docling-project.github.io/docling/reference/document_converter/
- ColPali: https://arxiv.org/abs/2407.01449
- RAGFlow / DeepDoc: https://github.com/infiniflow/ragflow
- RAG-Anything: https://github.com/HKUDS/RAG-Anything
- Qdrant multimodal search: https://qdrant.tech/documentation/tutorials-build-essentials/multimodal-search/
- Milvus multi-vector search: https://milvus.io/docs/multi-vector-search.md
- OpenAI Images and Vision: https://platform.openai.com/docs/guides/images-vision

## 3. 设计目标

### 3.1 产品目标

用户上传本地资料后，A3 应明确告诉用户：

- 文件是否已保存。
- 文件是否已完成解析。
- 解析出了多少页/幻灯片、多少文本块、多少图片块、多少表格、多少公式。
- 有多少内容进入文本索引、关键词索引和视觉索引。
- 哪些页解析质量低，是否需要 OCR、重试、人工补充说明或转换格式。
- AI 回答引用了哪个文件、哪一页/哪张幻灯片、哪个文本块或图片块。

### 3.2 工程目标

本设计要把 A3 知识库从单一路径：

```text
文件 -> 文本抽取 -> chunk -> FAISS -> 搜索 -> LLM
```

升级为多模态路径：

```text
文件
-> 原文件保存
-> 文档解析任务
-> 页面/幻灯片渲染
-> OCR / 表格 / 公式 / 图片块 / 版面解析
-> 多模态知识单元
-> 文本索引 + 关键词索引 + 视觉索引 + 元数据索引
-> 混合检索 + rerank
-> 文本证据 + 视觉证据送入多模态 LLM
-> 带引用、验证、安全状态的答案
```

### 3.3 验收目标

以下情况必须可用：

- 文本型 PDF：能抽取正文、页码、标题，能被检索和引用。
- 扫描型 PDF：能 OCR 出文字，能引用页码和页面截图。
- 文本型 PPTX：能抽取文本框，并能引用幻灯片号。
- 图片型 PPTX：能渲染幻灯片图片，OCR 图片中文字，保留原幻灯片作为视觉证据。
- 含公式 PPTX/PDF/图片：能尽量抽取 LaTeX 或公式文本；无法可靠识别时标记低置信度。
- 含表格资料：能保留表格结构，至少转成 Markdown table 或 HTML table。
- 单张图片：能作为知识库资源入库，生成 OCR 文本、视觉摘要和图片向量。
- 课堂/辅导问答：能根据检索结果把相关文本和页面截图一起传给多模态模型。

## 4. 非目标

第一阶段不追求以下内容：

- 不直接替换整个 A3 学习闭环。
- 不把 RAGFlow、LightRAG 或其他平台的 WebUI iframe 到 A3。
- 不把 API key、signed URL、本地绝对路径暴露给前端。
- 不要求所有格式一次性达到出版级 OCR 准确率，但必须有质量评分和降级说明。
- 不把“上传成功”包装成“识别成功”。

## 5. 当前基线与缺口

### 5.1 当前能力

当前后端重点链路：

```text
backend/apps/knowledge_base/
backend/domains/knowledge_base/document_loader.py
backend/domains/knowledge_base/index_manager.py
backend/domains/knowledge_base/retriever.py
backend/domains/knowledge_base/lexical_retriever.py
```

当前支持的文件扩展名包括 `.xlsx`、`.pdf`、`.pptx`。检索接口只允许搜索 `status=INDEXED` 的上传资源。

### 5.2 当前缺口

| 问题 | 当前表现 | 风险 |
|---|---|---|
| PPTX 只抽文本框 | 图片型课件无文本就没有 document/chunk | 用户上传课件但 RAG 实际不可用 |
| 图片不能入知识库 | 图片只作为临时问答附件时不会沉淀为可检索资源 | 同一资料无法复用、无法引用 |
| 没有页面/幻灯片渲染 | 无法把原始视觉证据送入 VLM | 图表、布局、公式题理解差 |
| 没有解析质量指标 | indexed 可能掩盖低质量解析 | 教师不知道资料是否真的可用 |
| 单一向量索引 | 公式、符号、短术语容易漏召回 | 自动控制课程检索不稳定 |
| 引用粒度粗 | 只展示来源文件/片段，缺少页图和坐标 | Verifier 难以判断证据是否充分 |

## 6. 总体架构

```text
OpenMAIC / A3 Frontend
  - /a3/knowledge-base 上传、质量状态、搜索、引用预览
  - /a3/classroom 和 /a3/coaching 使用多模态证据回答
  - /a3/capabilities 展示多模态 RAG 评测证据

Next API Proxy
  - /api/a3/... 继续代理 A3 业务

Django Backend
  - accounts / permissions
  - knowledge_base resources, jobs, parse runs, search
  - learning / coaching / verifier agents

Celery / 后台任务
  - 文件解析
  - PPTX/PDF 渲染
  - OCR / 表格 / 公式 / 图片摘要
  - embedding / visual embedding
  - 索引写入

Document Intelligence Layer
  - MinerU 或 Docling adapter
  - OCR adapter
  - PPTX/PDF render adapter
  - VLM caption/structure adapter

Index Layer
  - metadata store: Django DB
  - object store: 本地 media/data 或后续 MinIO
  - text vector index: 现有 FAISS 起步，后续 Qdrant/Milvus
  - lexical index: BM25/keyword
  - visual vector index: page/slide/image embeddings

Answer Layer
  - RetrieverAgent 混合检索
  - RerankerAgent 排序
  - CoachAgent / TeacherAgent 多模态回答
  - VerifierAgent 引用验证
  - SafetyAgent 安全过滤
```

## 7. 文件处理策略

### 7.1 支持级别

| 格式 | 第一阶段目标 | 第二阶段目标 | 失败处理 |
|---|---|---|---|
| PDF | 文本抽取 + 页面渲染 + OCR 兜底 | 表格/公式/版面块结构化 | 标记低覆盖率并展示失败页 |
| PPTX | 文本框抽取 + 幻灯片渲染 + OCR | 图表/公式/讲义备注解析 | 不允许只有文件上传成功无识别结果 |
| PNG/JPG/JPEG/WebP | OCR + 视觉摘要 + 图片向量 | 图题定位、手写识别增强 | 无文字也要能作为视觉证据入库 |
| XLSX | 保留当前 QA/表格解析 | 单元格范围引用、表格检索 | 表头缺失时提示人工确认 |
| DOCX | 可作为后续扩展 | 结构化标题、表格、图片 | 第一阶段不阻塞 |
| PPT | 不直接支持 | 提供转换工具和错误提示 | 要求先转换为 PPTX |

### 7.2 PPTX 必须处理的内容

每个 PPTX 入库后至少生成：

- `slidesCount`：总幻灯片数。
- `renderedSlidesCount`：成功渲染图片的幻灯片数。
- `textSlideCount`：提取到文本框内容的幻灯片数。
- `ocrSlideCount`：OCR 识别出文字的幻灯片数。
- `imageBlockCount`：检测出的图片块数量。
- `tableBlockCount`：检测出的表格数量。
- `formulaBlockCount`：检测出的公式数量，或低置信度公式数量。
- `indexedTextChunks`：进入文本索引的 chunk 数。
- `indexedVisualPages`：进入视觉索引的幻灯片图片数。
- `qualityWarnings`：空页、OCR 失败、渲染失败、低置信度公式等。

如果一个 PPTX 全部是图片页，但 OCR 和视觉索引成功，也应算知识库可用；如果只保存了文件但没有任何文本或视觉索引，则必须是 `failed` 或 `indexed_with_warnings`，不能静默显示为普通已索引。

### 7.3 图片必须处理的内容

每张图片入库后至少生成：

- 原图资产。
- OCR 文本。
- 图片摘要，例如“根轨迹图、坐标轴、闭环极点标注”。
- 视觉 embedding。
- 可引用的图片证据 ID。
- 如果是题目图片，保留题干、条件、公式和问题区域。

## 8. 解析与索引流水线

### 8.1 上传阶段

入口保持：

```text
POST /api/kb/resources/upload/
```

后端动作：

1. 校验登录和教师/管理员权限。
2. 校验文件类型、大小、MIME、扩展名。
3. 保存原文件，不暴露绝对路径。
4. 创建 `KnowledgeResource`。
5. 创建 `KnowledgeIndexJob`。
6. 返回资源和任务状态。

上传阶段只表示文件已接收，不表示可被 RAG 使用。

### 8.2 解析阶段

新增 `DocumentParseRun` 概念，用于记录一次解析执行：

```text
queued
-> rendering
-> extracting
-> ocr
-> structuring
-> completed / completed_with_warnings / failed
```

不同格式的处理：

```text
PPTX
-> python-pptx 抽文本框
-> LibreOffice/headless 或等价工具渲染 slide PNG
-> OCR / VLM 解析 slide PNG
-> 合并文本框、OCR、图片摘要、表格、公式

PDF
-> pypdf/pdfplumber 抽文本
-> 页面渲染 PNG
-> OCR 处理无文本页
-> 表格/公式/图片块解析

Image
-> OCR
-> VLM caption / structure extraction
-> visual embedding

XLSX
-> pandas/openpyxl 解析表格
-> 行/表/工作表级 chunk
```

### 8.3 知识单元生成

统一生成 `KnowledgeBlock`：

```json
{
  "resourceId": "uuid",
  "pageId": "uuid",
  "blockId": "uuid",
  "modality": "text|table|formula|image|page_image|slide_image",
  "text": "可检索文本或 OCR 文本",
  "markdown": "结构化 Markdown，可为空",
  "html": "表格 HTML，可为空",
  "assetPath": "后端内部资产路径，不直接返回前端",
  "pageNumber": 3,
  "slideNumber": 5,
  "bbox": [0.1, 0.2, 0.5, 0.3],
  "confidence": 0.87,
  "warnings": []
}
```

`KnowledgeBlock` 是后续检索、引用、验证和前端预览的基础单位。

### 8.4 索引阶段

每个 block 根据类型进入不同索引：

| block 类型 | 文本向量 | 关键词 | 视觉向量 | 元数据 |
|---|---:|---:|---:|---:|
| text | 是 | 是 | 否 | 是 |
| table | 是 | 是 | 可选 | 是 |
| formula | 是 | 是 | 可选 | 是 |
| image | 是，使用 caption/OCR | 是 | 是 | 是 |
| page_image / slide_image | 是，使用页面摘要 | 是 | 是 | 是 |

第一阶段可以继续保留 FAISS，但建议抽象索引接口：

```python
class TextIndex:
    def upsert(blocks): ...
    def search(query, top_k, filters): ...

class LexicalIndex:
    def upsert(blocks): ...
    def search(query, top_k, filters): ...

class VisualIndex:
    def upsert(assets): ...
    def search_text_to_image(query, top_k, filters): ...
    def search_image_to_image(image, top_k, filters): ...
```

第二阶段可切换 Qdrant 或 Milvus，以支持多向量、过滤、批量删除、增量更新和更稳定的服务化部署。

## 9. 检索设计

### 9.1 检索入口

保留：

```text
GET /api/kb/search/?q=&top_k=&course=
```

新增可选参数：

```text
mode=text|visual|hybrid
resource_id=
include_assets=1
min_confidence=0.5
```

课堂/辅导内部可以调用后端服务函数，不一定暴露所有参数给前端。

### 9.2 混合检索流程

```text
query
-> query rewrite，可结合当前学习目标、知识点、错题
-> text vector search
-> lexical BM25/keyword search
-> visual text-to-image search
-> merge candidates
-> rerank
-> evidence packing
-> return citations
```

候选合并时必须保留来源：

```json
{
  "resultId": "uuid",
  "score": 0.82,
  "retrievers": ["text_vector", "bm25", "visual_page"],
  "modality": "slide_image",
  "resource": {
    "id": "uuid",
    "name": "根轨迹课件.pptx",
    "type": "PPTX"
  },
  "location": {
    "page": null,
    "slide": 12,
    "bbox": [0.1, 0.2, 0.8, 0.5]
  },
  "text": "OCR/摘要/文本块",
  "asset": {
    "assetId": "uuid",
    "kind": "slide_png",
    "previewUrl": "/api/kb/assets/uuid/preview/"
  },
  "confidence": 0.76,
  "warnings": []
}
```

### 9.3 自动控制课程的检索要求

A3 面向自动控制原理学习场景，检索必须特别处理：

- 公式符号：`G(s)`、`H(s)`、`K`、`ζ`、`ω_n`、`s^2 + 2ζω_ns + ω_n^2`。
- 中文术语：根轨迹、奈奎斯特、伯德图、稳态误差、相角裕度。
- 图表页：根轨迹图、Bode 图、Nyquist 图、框图、信号流图。
- 题目图片：题干、系统结构图、参数条件、求解目标。

因此不能只依赖 dense embedding。BM25、符号归一化、视觉页检索和 rerank 都是必要能力。

## 10. 回答生成设计

### 10.1 回答输入

课堂/辅导调用 LLM 时，输入应包含：

- 用户问题。
- 当前学习画像、路径节点、薄弱点、错题上下文。
- 文本证据：top text/table/formula blocks。
- 视觉证据：top page/slide/image assets。
- 引用约束：不能编造文件名、页码、幻灯片号。
- 安全约束：隐私、作弊、危险请求仍由 SafetyAgent 拦截。

多模态模型输入示例：

```json
[
  {
    "role": "user",
    "content": [
      {"type": "input_text", "text": "请解释这页课件中的根轨迹规则，并结合我的问题回答..."},
      {"type": "input_text", "text": "证据1：根轨迹课件.pptx 第12页，OCR文本..."},
      {"type": "input_image", "image_url": "data:image/png;base64,..."}
    ]
  }
]
```

### 10.2 回答输出

统一返回：

```json
{
  "success": true,
  "answer": "中文分步解答...",
  "verified": true,
  "degraded": false,
  "retrieval": {
    "mode": "hybrid",
    "textHits": 3,
    "visualHits": 2,
    "lexicalHits": 2
  },
  "citations": [
    {
      "resourceId": "uuid",
      "resourceName": "根轨迹课件.pptx",
      "modality": "slide_image",
      "slide": 12,
      "blockId": "uuid",
      "quote": "根轨迹起始于开环极点...",
      "previewUrl": "/api/kb/assets/uuid/preview/"
    }
  ],
  "claims": [
    {
      "text": "根轨迹起始于开环极点，终止于开环零点或无穷远。",
      "supported": true,
      "citationIds": ["uuid"]
    }
  ],
  "safety": {
    "allowed": true,
    "reason": ""
  }
}
```

### 10.3 降级策略

降级必须显式，不允许伪装成功。

| 故障 | 降级 | 用户可见状态 |
|---|---|---|
| VLM 不可用 | 只用文本证据回答 | 显示“未使用视觉证据” |
| OCR 失败 | 用页面图片进入视觉索引，文本证据为空 | 显示“文字识别失败，已保留图片证据” |
| 视觉索引不可用 | text + BM25 检索 | 显示“视觉检索不可用” |
| 解析器不可用 | 当前文件 failed | 显示中文错误和重试入口 |
| 证据不足 | 拒绝 verified | 引导上传/重解析资料 |

## 11. 数据模型建议

在保留 `KnowledgeResource`、`KnowledgeIndexJob` 的基础上新增表。字段名可在实施时按 Django 规范调整。

### 11.1 KnowledgeParseRun

记录一次解析任务。

```text
id
resource_id
status: queued/running/completed/completed_with_warnings/failed
parser: mineru/docling/native
started_at
finished_at
error_message
result_json
```

`result_json` 示例：

```json
{
  "pages": 24,
  "renderedPages": 24,
  "textBlocks": 86,
  "imageBlocks": 12,
  "tableBlocks": 3,
  "formulaBlocks": 18,
  "ocrChars": 12840,
  "warnings": ["slide 7 formula low confidence"]
}
```

### 11.2 KnowledgePage

PDF 页、PPTX 幻灯片、图片资源都统一成 page。

```text
id
resource_id
page_number
slide_number
width
height
rendered_asset_id
ocr_text
summary
quality_score
warnings_json
```

### 11.3 KnowledgeAsset

保存渲染图、裁剪图、原图等。

```text
id
resource_id
page_id
kind: original/rendered_page/rendered_slide/crop/image
mime_type
storage_path
sha256
width
height
created_at
```

注意：`storage_path` 只在后端使用，前端只能拿到受权限保护的 preview/download API。

### 11.4 KnowledgeBlock

解析出的最小证据单元。

```text
id
resource_id
page_id
asset_id nullable
modality: text/table/formula/image/page_image/slide_image
text
markdown
html
bbox_json
confidence
warnings_json
metadata_json
```

### 11.5 KnowledgeIndexEntry

记录 block 是否进入各类索引。

```text
id
block_id
index_type: text_vector/lexical/visual_vector
index_backend: faiss/bm25/qdrant/milvus
external_id
status
error_message
updated_at
```

这样可以避免“资源 indexed 但某些索引失败”无法诊断。

## 12. 后端接口设计

### 12.1 资源列表

现有：

```text
GET /api/kb/resources/
```

响应增加质量字段：

```json
{
  "id": "uuid",
  "name": "根轨迹课件.pptx",
  "type": "PPTX",
  "status": "indexed_with_warnings",
  "documentCount": 24,
  "chunks": 96,
  "multimodal": {
    "parseStatus": "completed_with_warnings",
    "pages": 24,
    "renderedPages": 24,
    "textBlocks": 62,
    "ocrChars": 8400,
    "imageBlocks": 10,
    "tableBlocks": 2,
    "formulaBlocks": 15,
    "textIndexed": 96,
    "visualIndexed": 24,
    "qualityScore": 0.82,
    "warnings": ["第 7 页公式识别置信度低"]
  }
}
```

### 12.2 解析详情

新增：

```text
GET /api/kb/resources/<resource_id>/parse/
```

用途：

- 展示每页解析状态。
- 展示 OCR 文本、表格、公式和图片块统计。
- 支持教师判断资料是否真正可用。

### 12.3 资产预览

新增：

```text
GET /api/kb/assets/<asset_id>/preview/
```

要求：

- 必须校验资源 owner 或教师权限。
- 不能返回本地绝对路径。
- 可支持缩略图参数，例如 `?w=640`。

### 12.4 重解析

新增：

```text
POST /api/kb/resources/<resource_id>/reparse/
```

请求：

```json
{
  "parser": "auto|mineru|docling|native",
  "forceOcr": true,
  "forceRender": true
}
```

用途：

- 当 OCR 质量差或解析器升级后重建。
- 不要求用户重新上传。

### 12.5 多模态搜索

扩展：

```text
GET /api/kb/search/?q=根轨迹渐近线怎么求&mode=hybrid&include_assets=1
```

响应必须包含 `retrievalMode`、`fallback`、`results[].modality`、`results[].previewUrl` 和 `results[].location`。

### 12.6 图片入库

新增或扩展上传接口允许图片：

```text
POST /api/kb/resources/upload/
Content-Type: multipart/form-data
files: image.png
```

图片不应只用于聊天临时附件。只要用户选择“上传到知识库”，它就必须创建 `KnowledgeResource`、`KnowledgePage`、`KnowledgeAsset`、`KnowledgeBlock` 和索引记录。

## 13. 前端页面设计

### 13.1 `/a3/knowledge-base`

页面要从“文件列表”升级为“知识库建设工作台”：

- 上传区：支持 PDF、PPTX、图片、XLSX，并明确旧 PPT 需转换。
- 状态区：显示解析中、索引中、可用、低质量、失败。
- 质量指标：页数、OCR 字数、文本块、图片块、表格、公式、视觉索引数量。
- 资源详情：点击资源后查看每页/幻灯片解析结果。
- 搜索测试：输入问题后展示命中的文本证据和视觉证据。
- 修复动作：重试、重解析、强制 OCR、删除、下载原文件。

空状态不能只说“暂无资源”，要引导上传课件、题图或教材。

### 13.2 `/a3/classroom` 和 `/a3/coaching`

回答区域需要展示：

- 本次是否使用视觉证据。
- 引用的文件、页码/幻灯片号。
- 可点击的页面/幻灯片缩略图。
- 如果降级，只能显示降级说明，不能说“已完成视觉识别”。

### 13.3 `/a3/capabilities`

新增多模态 RAG 证据区：

- 多格式解析 smoke。
- OCR 覆盖率。
- 文本 Top-K 命中率。
- 视觉 Top-K 命中率。
- 混合检索 Top-K 命中率。
- 降级次数和原因。
- 最近一次多模态检索 trace。

## 14. Agent 改造

### 14.1 RetrieverAgent

职责从“文本检索”升级为“多模态证据检索”：

```json
{
  "retrievalMode": "hybrid",
  "queryRewrite": "...",
  "textCandidates": 5,
  "visualCandidates": 3,
  "lexicalCandidates": 5,
  "selectedEvidence": 6,
  "fallback": false
}
```

### 14.2 VerifierAgent

VerifierAgent 必须支持视觉证据：

- claims 可以由文本块支持。
- claims 可以由图片/幻灯片支持，但必须说明依据。
- 如果只有模型主观判断、没有引用来源，不能标 `verified=true`。

### 14.3 CoachAgent / TeacherAgent

回答时必须区分：

- `grounded_answer`：有证据支持的解答。
- `visual_interpretation`：模型基于图像理解的内容。
- `uncertain_parts`：OCR 或视觉识别不确定的地方。
- `next_action`：让用户补充更清晰图片、上传原文件或选择具体页。

## 15. 配置与依赖

建议新增配置：

```text
A3_MULTIMODAL_RAG_ENABLED=1
A3_DOCUMENT_PARSER=auto
A3_DOCUMENT_PARSER_TIMEOUT_SECONDS=300
A3_RENDER_PPTX_ENABLED=1
A3_RENDER_PDF_ENABLED=1
A3_OCR_ENABLED=1
A3_VISUAL_INDEX_ENABLED=1
A3_VISUAL_MODEL_PROVIDER=openai|local|none
A3_VISUAL_EMBEDDING_BACKEND=clip|siglip|colpali|none
A3_VECTOR_BACKEND=faiss|qdrant|milvus
A3_KB_ASSET_ROOT=<backend-controlled-path>
```

依赖选型建议：

| 能力 | 第一选择 | 备选 |
|---|---|---|
| 文档解析 | Docling 或 MinerU adapter | native parser |
| PPTX 渲染 | LibreOffice headless | Windows COM，仅本地开发 |
| PDF 渲染 | PyMuPDF / poppler | pypdfium2 |
| OCR | PaddleOCR / RapidOCR | VLM OCR |
| 视觉理解 | OpenAI vision | Qwen-VL / InternVL |
| 视觉向量 | ColPali/ColQwen2 思路或 CLIP/SigLIP | 先用 caption text embedding 过渡 |
| 向量库 | 现有 FAISS 起步 | Qdrant/Milvus |

实现时要用 adapter 包起来，避免业务代码直接依赖某一个开源项目。

## 16. 质量门禁

每个资源需要计算 `qualityScore`：

```text
qualityScore =
  0.25 * renderCoverage
+ 0.25 * textOrOcrCoverage
+ 0.20 * indexCoverage
+ 0.15 * citationReadiness
+ 0.15 * parserConfidence
```

建议阈值：

| 状态 | 条件 |
|---|---|
| indexed | qualityScore >= 0.75 且至少一种索引成功 |
| indexed_with_warnings | 0.4 <= qualityScore < 0.75 或部分页失败 |
| failed | qualityScore < 0.4 且无可用文本/视觉索引 |

前端显示时要用中文解释原因，例如：

- “24 页幻灯片中 24 页已渲染，21 页 OCR 成功，3 页公式置信度低。”
- “该 PPTX 只有 0 个文本块，但 18 页图片已进入视觉索引。”
- “解析失败：未安装 LibreOffice，无法渲染 PPTX 幻灯片。”

## 17. 评测设计

### 17.1 测试集

新增 `data/eval/multimodal_rag/`：

```text
text_pdf/
scanned_pdf/
pptx_text/
pptx_image_only/
pptx_formula_chart/
single_images/
xlsx_tables/
queries.jsonl
```

`queries.jsonl` 示例：

```json
{
  "id": "pptx-root-locus-001",
  "query": "根轨迹渐近线角度怎么计算？",
  "expectedResource": "根轨迹课件.pptx",
  "expectedSlide": 12,
  "expectedModalities": ["text", "slide_image"],
  "expectedAnswerPoints": ["渐近线条数", "角度公式", "实轴交点"]
}
```

### 17.2 指标

必须输出：

- `parseSuccessRate`
- `renderCoverage`
- `ocrCoverage`
- `textTop1HitRate`
- `textTop3HitRate`
- `visualTop1HitRate`
- `visualTop3HitRate`
- `hybridTop3HitRate`
- `citationAccuracy`
- `verifiedAnswerRate`
- `degradedRate`

### 17.3 命令

新增建议命令：

```powershell
backend\.venv\Scripts\python.exe backend\manage.py evaluate_multimodal_rag --top-k 3
backend\.venv\Scripts\python.exe backend\manage.py evaluate_multimodal_rag --top-k 3 --json --output backend\tmp\multimodal_rag_metrics.json
```

现有命令保留：

```powershell
backend\.venv\Scripts\python.exe backend\manage.py evaluate_demo_retrieval --top-k 3
```

`/a3/capabilities` 应读取最新多模态评测文件并展示指标。

## 18. 实施阶段

### 阶段 0：修正定义和状态，不新增大依赖

目标：先阻止“假成功”。

任务：

- 扩展资源状态，或在 `result` 中增加 `parseStatus`、`qualityScore`、`warnings`。
- 前端展示 document/chunk/quality/warnings。
- PPTX 如果没有任何可索引文本，不能普通显示为成功。
- 图片上传入口区分“临时问答附件”和“入知识库资源”。

验收：

- 图片型 PPTX 上传后不会被误判为完整 indexed。
- 用户能看到 PPTX 为什么不可用或只部分可用。

### 阶段 1：PPTX/PDF 页面渲染与 OCR

目标：让图片型 PPTX、扫描 PDF、单张图片真正进入知识库。

任务：

- 增加 render adapter。
- 增加 OCR adapter。
- 增加 `KnowledgeAsset`、`KnowledgePage`、`KnowledgeBlock`。
- 解析 PPTX 每页渲染图并 OCR。
- 图片资源作为一页文档入库。

验收：

- 图片型 PPTX 能产生 slide PNG、OCR 文本和可引用幻灯片。
- 单张题目图片能被搜索命中并在课堂中引用。

### 阶段 2：混合检索与视觉证据回答

目标：问答阶段真正使用多模态证据。

任务：

- 增加 hybrid retriever。
- 接入视觉索引，第一版可用 CLIP/SigLIP 或 caption embedding 过渡。
- 课堂/辅导回答时传入文本证据和图片证据。
- VerifierAgent 支持视觉引用。

验收：

- 对图片型 PPTX 的问题，回答引用对应幻灯片截图。
- 对题图问题，回答能使用原图证据，不只依赖用户当前上传附件。

### 阶段 3：结构化表格、公式、图表增强

目标：提升自动控制课程的专业资料理解能力。

任务：

- 表格转 Markdown/HTML。
- 公式转 LaTeX 或结构化文本。
- 图表页生成更好的 caption。
- 对根轨迹、Bode 图、Nyquist 图等建立领域 prompt 和评测项。

验收：

- 公式页、图表页能被检索命中。
- 回答能指出公式识别不确定处。

### 阶段 4：服务化与可扩展索引

目标：支撑更大规模课程资料。

任务：

- 将 FAISS 抽象替换为 Qdrant/Milvus 可选后端。
- 支持批量删除、增量更新、重建、版本化。
- 可选接入 LightRAG/RAGFlow/RAG-Anything 作为独立服务，但 A3 仍保留业务入口和审计。

验收：

- 资源删除后所有文本/视觉索引同步删除。
- 向量后端不可用时能明确降级。

## 19. 风险与控制

| 风险 | 控制 |
|---|---|
| OCR 准确率不稳定 | 显示置信度和低质量页，允许重解析 |
| 开源解析器依赖重 | adapter 隔离，native parser 兜底 |
| PPTX 渲染环境复杂 | 优先 LibreOffice headless，失败时返回明确错误 |
| 视觉模型成本高 | 后台批处理、缓存 asset summary、限制页数和并发 |
| 索引不一致 | `KnowledgeIndexEntry` 记录每个 block 的索引状态 |
| 引用伪造 | 引用必须来自 block/page/asset ID，Verifier 校验 |
| 用户隐私 | 文件只在后端受控路径，前端只走鉴权 preview API |

## 20. 最低可用验收清单

第一轮实现不能低于以下标准：

- [ ] PPTX 文本框内容可抽取。
- [ ] PPTX 每页可渲染为图片。
- [ ] 图片型 PPTX 可 OCR，并生成可检索文本。
- [ ] 单张图片可上传为知识库资源。
- [ ] 每个资源显示解析质量和索引质量。
- [ ] 检索结果能显示文件名、页码/幻灯片号、证据类型。
- [ ] 课堂/辅导能把检索到的图片证据传给多模态模型。
- [ ] 视觉模型或 OCR 不可用时，前端显示明确降级原因。
- [ ] `evaluate_multimodal_rag` 输出可复现指标。
- [ ] `/a3/capabilities` 展示多模态 RAG 证据。

## 21. 与现有 A3 规则的关系

本方案遵守当前 A3 开发协议：

- 不新增纯 mock 页面冒充能力。
- 不绕过后端接口在前端伪造知识库结果。
- 不暴露本地绝对路径、API key、signed URL。
- 需要登录和教师权限的接口继续校验权限。
- 用户可见错误使用正常中文。
- 所有关键能力必须能通过页面、接口、数据回流和验证命令证明。
- OpenMAIC 仍作为课堂/PPTX 导出/视频生成底座；A3 知识库负责资料入库、检索、引用和学习闭环。

## 22. 下一步

评审通过后，应先产出实施计划，而不是直接大规模改代码。建议第一个实施计划只覆盖阶段 0 和阶段 1：

1. 增加多模态资源状态和质量字段。
2. 增加 page/asset/block 数据模型。
3. 实现 PPTX/PDF/图片渲染与 OCR adapter。
4. 让图片型 PPTX 和单张图片能产生可检索 chunk。
5. 更新 `/a3/knowledge-base` 显示解析质量和失败原因。
6. 增加最小多模态 RAG 评测命令。

这一步完成后，A3 才能说“PPTX 和图片不是只上传，而是进入了可验证的本地知识库”。
