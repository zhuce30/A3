# A3 Material Knowledge Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/a3/knowledge-graph` display a real knowledge graph built from uploaded knowledge-base materials, with course prerequisite graph available only as a secondary "课程路径图" view.

**Architecture:** Follow the LightRAG / GraphRAG pattern, but do it as a downstream layer of the existing A3 multimodal knowledge-base pipeline. Uploaded materials are already parsed into `KnowledgePage`, `KnowledgeAsset`, and `KnowledgeBlock` by `backend/domains/knowledge_base/multimodal_parser.py` and persisted by `persist_multimodal_parse(resource)`. The material knowledge graph must consume those existing blocks, extract entities, relationships, claims, and source evidence, persist graph tables, expose a graph API, and render it with React Flow. Text/PDF/doc resources enter from existing text blocks/chunks. PPT/PPTX resources enter from existing slide-scoped parsed pages, assets, OCR/caption blocks, and optional finer-grained PPTX blocks added inside the current parser. If no LLM/provider is available, extract a degraded graph from existing parsed text and rule-based slide blocks, then mark evidence as degraded instead of pretending it is fully generated.

**Tech Stack:** Django models and migrations, existing knowledge-base parser/index jobs, deterministic fallback extraction, optional LLM extraction hook, Next.js, TypeScript, React Flow, Vitest, Django TestCase.

---

## Integration With Existing Multimodal Parsing

This plan must not replace the existing upload/reparse multimodal pipeline. The intended lifecycle is:

```text
upload resource
-> persist_multimodal_parse(resource)
-> KnowledgePage / KnowledgeAsset / KnowledgeBlock
-> graph_input_adapter reads persisted blocks
-> graph_builder extracts entities / relations / claims
-> /api/kb/graph/ exposes material graph with source evidence
```

Forced reparse should use the same chain:

```text
force reparse
-> delete old parse rows and old graph rows for the resource
-> persist_multimodal_parse(resource)
-> graph_builder rebuilds graph from the new KnowledgeBlock evidence
```

PPT/PPTX compatibility rule:

- Existing PPTX multimodal extraction remains the source of truth.
- If PPTX evidence is too coarse, enhance `_parse_pptx(source_path)` inside `backend/domains/knowledge_base/multimodal_parser.py`.
- Do not introduce a second PPTX parser, duplicate block table, or frontend-only graph data.
- The knowledge graph layer only adds entity/relation/claim semantics and evidence pointers on top of existing parsed blocks.

---

## Source References

- LightRAG: document chunks are used to extract entities and relationships, then graph retrieval is combined with vector retrieval.
- Microsoft GraphRAG: text units flow into extracted entities, relationships, and claims, then later summaries and communities.
- Unstructured / LlamaIndex PPTX readers: PPT files should be partitioned by slide and element type before entering RAG or graph extraction.
- RAG-Anything style multimodal graph: non-text elements should be converted into captions or structured descriptions, then linked back to their original slide and block.
- React Flow + ELK style layout: useful when entity graphs grow beyond a few hand-positioned nodes.

---

## File Structure

- Modify: `backend/apps/knowledge_base/models.py`
  - Add persisted graph schema: `KnowledgeGraphEntity`, `KnowledgeGraphRelation`, `KnowledgeGraphClaim`.
- Create migration: `backend/apps/knowledge_base/migrations/00xx_material_knowledge_graph.py`
  - Create graph tables and indexes.
- Modify: `backend/apps/knowledge_base/personal_agent.py`
  - Return structured graph candidates from parsed text: entities, relations, claims, degraded flag.
- Create: `backend/apps/knowledge_base/graph_input_adapter.py`
  - Normalize existing `KnowledgeBlock` / `KnowledgePage` / `KnowledgeAsset` rows into one in-memory `MaterialBlock` payload for graph extraction. This is an adapter, not a duplicate storage table.
- Modify: `backend/domains/knowledge_base/multimodal_parser.py`
  - Enhance the existing `_parse_pptx(source_path)` only if the current PPTX blocks are too coarse. Do not add a separate PPTX parser that bypasses `persist_multimodal_parse`.
- Create: `backend/apps/knowledge_base/graph_builder.py`
  - Normalize extracted graph candidates, deduplicate nodes, map evidence to resources/chunks, save graph tables.
- Modify: `backend/apps/knowledge_base/views.py`
  - Add `GET /api/kb/graph/`.
- Modify: `backend/apps/knowledge_base/urls.py`
  - Register graph endpoint.
- Add tests:
  - `backend/apps/knowledge_base/tests/test_material_knowledge_graph.py`
  - Verify upload/reparse builds entities, relations, source evidence, degraded fallback.
- Modify: `OpenMAIC/lib/a3/learning-types.ts` or create `OpenMAIC/lib/a3/kb-graph-types.ts`
  - Add frontend types for material graph.
- Modify: `OpenMAIC/components/a3/features/knowledge-graph-view.tsx`
  - Default to material graph. Move course prerequisite graph into a secondary tab.
- Add frontend tests:
  - `OpenMAIC/tests/a3-material-knowledge-graph.test.ts`
  - Ensure default graph is `/api/kb/graph/`, empty state points to `/a3/knowledge-base`, and course graph is not the default.

---

## Data Contract

### Entity

```json
{
  "id": "entity_uuid",
  "label": "传递函数",
  "type": "concept",
  "aliases": ["Transfer Function"],
  "summary": "描述线性定常系统输入输出关系的数学模型。",
  "confidence": 0.82,
  "resourceIds": ["resource_uuid"],
  "sourceCount": 3,
  "degraded": false
}
```

### Relation

```json
{
  "id": "relation_uuid",
  "source": "entity_uuid_a",
  "target": "entity_uuid_b",
  "type": "describes",
  "label": "描述",
  "weight": 0.76,
  "evidence": [
    {
      "resourceId": "resource_uuid",
      "resourceTitle": "自动控制原理第3章.pdf",
      "location": "第 3 页 / chunk 12",
      "snippet": "传递函数用于描述线性定常系统的输入输出关系...",
      "confidence": 0.76
    }
  ],
  "degraded": false
}
```

### Claim

```json
{
  "id": "claim_uuid",
  "text": "根轨迹法用于分析闭环极点随参数变化的轨迹。",
  "entityIds": ["entity_uuid"],
  "verified": true,
  "evidence": [],
  "degraded": false
}
```

### Material Block

Uploaded resources are already converted into persisted multimodal parse rows before graph extraction. The graph builder reads existing `KnowledgeBlock` rows, joins `KnowledgePage` and `KnowledgeAsset` for page/slide and visual evidence, then maps them into in-memory `MaterialBlock` payloads. Text/PDF/doc resources usually produce `chunk` or `text` blocks. PPT/PPTX resources produce slide-scoped blocks from the current multimodal parser.

```json
{
  "resourceId": "resource_uuid",
  "resourceTitle": "自动控制原理第3章课件.pptx",
  "resourceType": "pptx",
  "blockId": "slide-5-bullet-2",
  "blockType": "bullet",
  "slideIndex": 5,
  "location": "PPT 第 5 页 · 项目符号 2",
  "text": "闭环极点随开环增益变化形成根轨迹。",
  "caption": "",
  "bbox": [72, 160, 620, 210],
  "confidence": 0.86,
  "degraded": false
}
```

PPT/PPTX block types:

```text
slide_title
text_box
bullet
table
chart
image
formula
speaker_note
ocr_text
image_caption
```

Graph evidence for PPT/PPTX must point back to the slide and block:

```json
{
  "resourceId": "resource_uuid",
  "resourceTitle": "自动控制原理第3章课件.pptx",
  "location": "PPT 第 5 页 · 图片说明",
  "blockId": "slide-5-image-1-caption",
  "blockType": "image_caption",
  "snippet": "根轨迹示意图显示极点从开环极点出发并趋向零点或无穷远。",
  "confidence": 0.74,
  "degraded": true
}
```

### API Response

```json
{
  "success": true,
  "graph": {
    "schemaVersion": "a3.material-knowledge-graph.v1",
    "source": "knowledge_base_materials",
    "mode": "material_graph",
    "filters": {
      "resourceId": null,
      "entityType": null,
      "relationType": null
    },
    "nodes": [],
    "edges": [],
    "claims": [],
    "summary": {
      "resourceCount": 2,
      "entityCount": 18,
      "relationCount": 26,
      "claimCount": 9,
      "degradedCount": 4
    },
    "build": {
      "status": "ready",
      "lastBuiltAt": "2026-07-06T00:00:00Z",
      "degraded": false,
      "reason": ""
    }
  }
}
```

---

## Task 1: Backend Graph Models

- [ ] Add `KnowledgeGraphEntity`.
- [ ] Add `KnowledgeGraphRelation`.
- [ ] Add `KnowledgeGraphClaim`.
- [ ] Link every graph row to `KnowledgeResource`.
- [ ] Store `source_locations` as JSON evidence, not local file paths.
- [ ] Add indexes on user, resource, normalized label, entity type, relation type.
- [ ] Migration must be additive and not alter existing knowledge-base resources.

Acceptance:

- Existing upload/index APIs still work.
- `manage.py check` passes.
- Graph rows can be deleted when a resource is deleted or reparsed.

---

## Task 2: Extraction Pipeline

- [ ] Extend `personal_agent.py` so material parsing returns graph candidates:
  - entities
  - relations
  - claims
  - degraded flag
  - extraction method: `llm` or `rule_fallback`
- [ ] Create deterministic fallback extractor:
  - entity candidates from headings, repeated technical terms, formulas, and `knowledgePoints`.
  - relation candidates from sentence patterns such as `A 是 B`, `A 用于 B`, `A 依赖 B`, `A 包含 B`.
  - claim candidates from definition-like sentences.
- [ ] Mark fallback output as `degraded: true`.
- [ ] Keep snippets short and source-bound.
- [ ] Add `graph_input_adapter.py` so graph extraction does not care whether the source is text, PDF, doc, or PPTX.
- [ ] Convert existing `KnowledgeBlock` rows into in-memory `MaterialBlock` payloads with stable `blockId`, `blockType`, `location`, `snippet`, and `degraded` metadata.

Acceptance:

- Upload with only parsed text still produces a visible but degraded material graph.
- No graph item is shown without a resource/chunk evidence pointer.
- PPT/PPTX graph evidence points to slide and block location, not just the file name.

---

## Task 2A: PPT/PPTX Multimodal Parser Compatibility

- [ ] Keep the current PPT/PPTX entry point in `backend/domains/knowledge_base/multimodal_parser.py`.
- [ ] Do not create a second parser that bypasses `KnowledgePage`, `KnowledgeAsset`, `KnowledgeBlock`, or `persist_multimodal_parse(resource)`.
- [ ] Enhance `_parse_pptx(source_path)` only where the existing output is too coarse, using a structured parser approach similar to Unstructured/LlamaIndex:
  - iterate slides
  - extract slide title
  - extract text boxes and bullet lists
  - extract tables as markdown or JSON text
  - extract speaker notes
  - extract chart titles, axes, labels, and series names when available
  - extract image placeholders and alt text when available
  - record slide index and best-effort bounding boxes
- [ ] Add image/chart/formula caption strategy:
  - if vision provider is configured, call caption agent for images, charts, formula screenshots
  - if no provider, use OCR/alt text/nearby slide title and mark `degraded: true`
  - never invent page numbers, chart values, or formulas not present in evidence
- [ ] Persist parsed output as existing `ParsedPage`, `ParsedAsset`, and `ParsedBlock` records that later become `KnowledgePage`, `KnowledgeAsset`, and `KnowledgeBlock`; the graph adapter then maps them to `MaterialBlock[]`:
  - `slide_title`
  - `text_box`
  - `bullet`
  - `table`
  - `chart`
  - `image`
  - `formula`
  - `speaker_note`
  - `ocr_text`
  - `image_caption`
- [ ] Persist parser diagnostics in resource metadata:
  - slide count
  - text block count
  - image block count
  - table block count
  - caption degraded count
  - parser status

Acceptance:

- A PPT with only text boxes builds graph entities and relationships.
- A PPT with tables exposes table evidence.
- A PPT with images still produces image evidence as degraded captions when no vision provider exists.
- The frontend can show `PPT 第 N 页 · block type` for every PPT-derived graph item.

---

## Task 3: Graph Builder and Reparse Integration

- [ ] Create `graph_builder.py`.
- [ ] Normalize entity labels:
  - trim whitespace
  - case-fold English
  - merge aliases within the same user/resource scope
- [ ] Deduplicate relations by `(source, target, type, resource)`.
- [ ] Save claims with linked entity ids and evidence.
- [ ] Call graph builder after successful `persist_multimodal_parse(resource)`.
- [ ] Call graph builder after forced reparse completes successfully.
- [ ] On forced reparse, remove old graph rows for affected resources before writing new rows.
- [ ] For PPT/PPTX, feed adapter-produced slide-level `MaterialBlock[]` from existing `KnowledgeBlock` evidence into graph extraction instead of flattening the entire deck into one text blob.
- [ ] Keep relation evidence attached to the strongest slide/block snippets.

Acceptance:

- Upload new material updates `/api/kb/graph/`.
- Forced reparse changes graph build timestamp and does not duplicate nodes.
- Reparse of a PPT updates slide evidence and removes stale slide/block graph rows.

---

## Task 4: Material Graph API

- [ ] Add `GET /api/kb/graph/`.
- [ ] Query params:
  - `resourceId`
  - `resourceType`
  - `entityType`
  - `relationType`
  - `blockType`
  - `q`
  - `limit`
- [ ] Return graph contract `a3.material-knowledge-graph.v1`.
- [ ] Return empty state when no uploaded material graph exists:
  - `status: empty`
  - `nextAction: { label: "上传资料", href: "/a3/knowledge-base" }`
- [ ] Include degraded evidence:
  - fallback extraction
  - no LLM/provider
  - missing chunk text
  - OCR/caption fallback for PPT image/chart/formula blocks

Acceptance:

- Authenticated user only sees their resources.
- No local paths or signed URLs are returned.
- API returns normal Chinese errors.

---

## Task 5: Frontend Knowledge Graph View

- [ ] Change default tab to `资料知识图谱`.
- [ ] Add secondary tab `课程路径图`.
- [ ] `资料知识图谱` calls `/api/kb/graph/`.
- [ ] `课程路径图` keeps current `/api/learning/graph/` rendering.
- [ ] Node detail panel shows:
  - entity label and type
  - summary
  - source resources
  - evidence snippets
  - PPT slide/block location when evidence is from PPT/PPTX
  - related claims
  - degraded badge when applicable
- [ ] Edge detail shows:
  - relation label/type
  - evidence snippets
  - confidence/weight
- [ ] Empty state:
  - if no material graph, explain that uploaded资料 has not produced a graph yet
  - button to `/a3/knowledge-base`
- [ ] Add filter controls:
  - resource
  - resource type: `pptx`, `pdf`, `doc`, `text`
  - entity type
  - relation type
  - block type for PPT-derived evidence
  - search keyword
- [ ] Evidence panel should render PPT evidence as:
  - `PPT 第 5 页 · 项目符号`
  - `PPT 第 5 页 · 表格`
  - `PPT 第 5 页 · 图片说明`
  - `PPT 第 5 页 · 演讲者备注`

Acceptance:

- User can distinguish uploaded-material graph from course prerequisite graph.
- Page title and copy must not imply a material graph exists when it does not.
- No static demo nodes.
- PPT nodes and edges show slide-level evidence, not only resource-level evidence.

---

## Task 6: Layout Quality

- [ ] Keep React Flow, but replace hand positions with deterministic layered layout.
- [ ] If adding dependency is acceptable, use `elkjs` for graph layout.
- [ ] If no new dependency, implement stable radial/layer layout:
  - concepts near center
  - formulas/methods around related concepts
  - resources as optional outer evidence nodes only when enabled
- [ ] Prevent overlap on desktop and mobile.
- [ ] Add MiniMap, Controls, fitView, selected-node highlighting.

Acceptance:

- 10 to 80 nodes remain readable.
- Long labels truncate gracefully.
- Clicking nodes and edges updates detail panel.

---

## Task 7: Tests

- [ ] Backend test: upload or create parsed resource, build graph, `GET /api/kb/graph/` returns entities, relations, evidence.
- [ ] Backend test: PPT/PPTX parser returns slide-scoped material blocks with title, bullet, table, note, and image caption fallback.
- [ ] Backend test: PPT graph evidence includes `slideIndex`, `blockType`, `blockId`, and readable `location`.
- [ ] Backend test: forced reparse removes stale graph rows and writes new rows.
- [ ] Backend test: no provider fallback is marked `degraded: true`.
- [ ] Backend test: user A cannot see user B's graph rows.
- [ ] Frontend static test: default graph API is `/api/kb/graph/`.
- [ ] Frontend static test: course graph is behind `课程路径图`, not default.
- [ ] Frontend static test: empty state links to `/a3/knowledge-base`.
- [ ] Frontend static test: PPT evidence labels are supported in node detail copy.
- [ ] Type check and lint.

Acceptance:

- `backend\.venv\Scripts\python.exe backend\manage.py check`
- targeted backend graph tests pass
- `cd OpenMAIC && npx.cmd tsc --noEmit`
- `cd OpenMAIC && pnpm.cmd vitest run tests/a3-material-knowledge-graph.test.ts`
- `cd OpenMAIC && pnpm.cmd lint`

---

## Task 8: Demo Flow Evidence

- [ ] Add material graph readiness to demo status or capabilities page.
- [ ] Show:
  - schema version
  - entity count
  - relation count
  - degraded count
  - latest resource used
  - latest PPT slide/block evidence when a PPT resource exists
- [ ] Update demo validation so it fails if material graph endpoint only returns course graph.

Acceptance:

- Demo can prove uploaded資料 generated graph data.
- Demo can prove PPT/PPTX resources are parsed by slide and block, not flattened into a fake text-only graph.
- Course prerequisite graph and material graph are separately named and separately verified.

---

## Risks and Decisions

- LLM extraction may be unavailable. Fallback graph must be explicit and degraded.
- Existing parsed text quality may be uneven for images/PDFs. Evidence should expose source snippets so weak extraction is visible.
- PPT/PPTX contains visual semantics that may not appear in text boxes. Image/chart/formula blocks must be captioned or explicitly marked degraded.
- Adding `elkjs` improves layout but adds dependency. If dependency risk is not acceptable, use deterministic custom layout first.
- Do not block upload on graph extraction failure. Upload/index success should remain usable, with graph build status showing failed/degraded.

---

## Recommended Implementation Order

1. Backend graph models and API contract.
2. Fallback graph extraction from existing parsed text.
3. Upload/reparse graph builder integration.
4. Frontend default material graph tab and empty state.
5. React Flow layout and detail panels.
6. Tests and demo/capabilities evidence.
