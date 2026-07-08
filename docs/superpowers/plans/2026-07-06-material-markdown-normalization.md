# Material Markdown Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize uploaded material evidence into audit-safe Markdown at the backend so formulas, tables, bullets, and citations render consistently in knowledge graph, knowledge base search, AI classroom, coaching, and recommendation evidence.

**Architecture:** Keep raw parser text immutable and add normalized Markdown as a derived representation. The parser creates `markdownText`/format metadata for future uploads; graph evidence and retriever citations prefer normalized Markdown while retaining raw snippets for audit. Frontend `A3Markdown` stays as a defensive renderer, not the primary normalizer.

**Tech Stack:** Django backend, existing `KnowledgeBlock` JSON metadata, PPTX/PDF/text multimodal parser, AgentKernel material graph workflow, Next.js A3 UI, existing `A3Markdown` + KaTeX renderer, Django unit tests, Vitest contract tests.

---

## File Structure

- Create: `backend/domains/knowledge_base/markdown_normalizer.py`
  - Single responsibility: convert parser block text into stable Markdown without mutating raw text.
- Modify: `backend/domains/knowledge_base/multimodal_parser.py`
  - Attach normalized Markdown and format metadata to parsed PPTX/PDF/text blocks.
- Modify: `backend/apps/knowledge_base/graph_input_adapter.py`
  - Make graph evidence expose both `snippet` and `markdownSnippet`.
- Modify: `backend/apps/knowledge_base/graph_builder.py`
  - Preserve `markdownSnippet`, `contentFormat`, and format hints in entity/relation/claim evidence.
- Modify: backend KB serialization/search response file after locating exact serializer or view with `rg -n "display_location|snippet|metadata" backend/apps/knowledge_base`
  - Prefer Markdown evidence in citations without removing raw text.
- Modify: `OpenMAIC/components/a3/features/knowledge-graph-view.tsx`
  - Prefer `markdownSnippet` when present; keep current `snippet` fallback.
- Modify: `OpenMAIC/components/a3/features/knowledge-base-view.tsx`
  - Render search snippets through `A3Markdown` when response says `contentFormat: markdown`.
- Test: `backend/apps/knowledge_base/tests/test_markdown_normalizer.py`
- Test: `backend/apps/knowledge_base/tests/test_material_knowledge_graph.py`
- Test: `OpenMAIC/tests/a3-material-knowledge-graph.test.ts`
- Test: `OpenMAIC/tests/a3-classroom-markdown.test.ts`

---

### Task 1: Add Backend Markdown Normalizer

**Files:**
- Create: `backend/domains/knowledge_base/markdown_normalizer.py`
- Test: `backend/apps/knowledge_base/tests/test_markdown_normalizer.py`

- [ ] **Step 1: Write failing tests for formulas, compact tables, and bullets**

```python
from django.test import SimpleTestCase

from backend.domains.knowledge_base.markdown_normalizer import normalize_material_markdown


class MaterialMarkdownNormalizerTests(SimpleTestCase):
    def test_normalizes_bare_equation_to_inline_latex(self):
        result = normalize_material_markdown("系统方程为：s² + 2s + Kg = 0，用于根轨迹分析。")

        self.assertIn("$s^2 + 2s + Kg = 0$", result.markdown)
        self.assertEqual(result.content_format, "markdown")
        self.assertIn("math", result.features)

    def test_repairs_compact_pipe_table(self):
        result = normalize_material_markdown("| 评价阶段 | 评价项目 | 权重 | 平时成绩 | 自主学习 | 20% | 课堂测验 | 知识掌握 | 20% |")

        self.assertIn("| 评价阶段 | 评价项目 | 权重 |", result.markdown)
        self.assertIn("| --- | --- | --- |", result.markdown)
        self.assertIn("| 平时成绩 | 自主学习 | 20% |", result.markdown)
        self.assertIn("table", result.features)

    def test_keeps_raw_plain_text_readable(self):
        result = normalize_material_markdown("根轨迹描述闭环极点随参数变化的轨迹。")

        self.assertEqual(result.markdown, "根轨迹描述闭环极点随参数变化的轨迹。")
        self.assertEqual(result.raw_text, "根轨迹描述闭环极点随参数变化的轨迹。")
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_markdown_normalizer
```

Expected: fail because `markdown_normalizer.py` does not exist.

- [ ] **Step 3: Implement the normalizer**

Create `backend/domains/knowledge_base/markdown_normalizer.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
import re


@dataclass(frozen=True)
class NormalizedMarkdown:
    raw_text: str
    markdown: str
    content_format: str
    features: list[str]


SUPERSCRIPT_MAP = str.maketrans({"²": "^2", "³": "^3", "⁴": "^4", "⁵": "^5", "⁶": "^6", "⁷": "^7", "⁸": "^8", "⁹": "^9"})


def normalize_material_markdown(text: str) -> NormalizedMarkdown:
    raw = str(text or "").strip()
    markdown = raw.translate(SUPERSCRIPT_MAP)
    features: list[str] = []
    markdown, table_found = _repair_compact_pipe_table(markdown)
    if table_found:
        features.append("table")
    markdown, math_found = _wrap_bare_equations(markdown)
    if math_found:
        features.append("math")
    markdown = _repair_bullets(markdown)
    if re.search(r"(?m)^[-*]\s+", markdown):
        features.append("list")
    return NormalizedMarkdown(raw_text=raw, markdown=markdown.strip(), content_format="markdown", features=sorted(set(features)))


def _wrap_bare_equations(text: str) -> tuple[str, bool]:
    found = False

    def replace(match: re.Match[str]) -> str:
        nonlocal found
        prefix = match.group(1)
        equation = match.group(2).strip()
        if len(equation) < 5:
            return match.group(0)
        found = True
        return f"{prefix}${equation}$"

    pattern = r"(^|[^$A-Za-z0-9_])([A-Za-z0-9_{}^()+\-*/.,\s]+=[A-Za-z0-9_{}^()+\-*/.,\s]+)"
    return re.sub(pattern, replace, text), found


def _repair_compact_pipe_table(text: str) -> tuple[str, bool]:
    if "|" not in text or "| ---" in text:
        return text, False
    cells = [cell.strip() for cell in text.strip().strip("|").split("|") if cell.strip()]
    if len(cells) < 6:
        return text, False
    column_count = next((count for count in (5, 4, 3, 2) if len(cells) % count == 0 and len(cells) // count >= 2), None)
    if not column_count:
        return text, False
    rows = [cells[index : index + column_count] for index in range(0, len(cells), column_count)]
    lines = [_format_row(rows[0]), _format_row(["---"] * column_count), *[_format_row(row) for row in rows[1:]]]
    return "\n".join(lines), True


def _format_row(cells: list[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def _repair_bullets(text: str) -> str:
    return re.sub(r"(?m)^\s*[•·]\s+", "- ", text)
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_markdown_normalizer
```

Expected: pass.

---

### Task 2: Store Derived Markdown During Multimodal Parsing

**Files:**
- Modify: `backend/domains/knowledge_base/multimodal_parser.py`
- Test: existing parser tests in `backend/apps/knowledge_base/tests/test_resources.py` or create focused parser test if needed.

- [ ] **Step 1: Locate block creation points**

Run:

```powershell
rg -n "KnowledgeBlock|metadata=|text=|block_type|display_location" backend/domains/knowledge_base/multimodal_parser.py backend/apps/knowledge_base
```

Expected: identify the helper or constructor that writes parsed text blocks.

- [ ] **Step 2: Add failing parser assertion**

Add an assertion to the existing PPTX parser test fixture:

```python
self.assertEqual(block.metadata["contentFormat"], "markdown")
self.assertIn("markdownText", block.metadata)
self.assertIn("$s^2 + 2s + Kg = 0$", block.metadata["markdownText"])
self.assertEqual(block.text, "系统方程为：s² + 2s + Kg = 0")
```

Raw `block.text` must stay unchanged.

- [ ] **Step 3: Attach derived metadata**

At each block creation point that has `text`, call:

```python
from backend.domains.knowledge_base.markdown_normalizer import normalize_material_markdown

normalized = normalize_material_markdown(text)
metadata = {
    **metadata,
    "contentFormat": normalized.content_format,
    "markdownText": normalized.markdown,
    "rawTextPreserved": True,
    "formatFeatures": normalized.features,
}
```

- [ ] **Step 4: Run parser tests**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_resources
```

Expected: pass.

---

### Task 3: Carry Markdown Evidence Into Material Graph

**Files:**
- Modify: `backend/apps/knowledge_base/graph_input_adapter.py`
- Modify: `backend/apps/knowledge_base/graph_builder.py`
- Test: `backend/apps/knowledge_base/tests/test_material_knowledge_graph.py`

- [ ] **Step 1: Write failing graph evidence test**

Add a test:

```python
def test_material_graph_evidence_exposes_markdown_snippet(self):
    resource, block = self._create_resource_with_block(
        text="系统方程为：s² + 2s + Kg = 0",
        metadata={
            "markdownText": "系统方程为：$s^2 + 2s + Kg = 0$",
            "contentFormat": "markdown",
            "formatFeatures": ["math"],
        },
    )

    rebuild_resource_graph(resource)
    entity = KnowledgeGraphEntity.objects.filter(resource=resource).first()

    evidence = entity.source_locations[0]
    self.assertEqual(evidence["contentFormat"], "markdown")
    self.assertEqual(evidence["markdownSnippet"], "系统方程为：$s^2 + 2s + Kg = 0$")
    self.assertEqual(evidence["snippet"], "系统方程为：s² + 2s + Kg = 0")
```

- [ ] **Step 2: Run test to verify failure**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_material_knowledge_graph
```

Expected: fail because evidence lacks `markdownSnippet`.

- [ ] **Step 3: Update graph evidence adapter**

In `MaterialBlock.evidence`, return:

```python
"snippet": _shorten(self.text, 220),
"markdownSnippet": _shorten(str(self.metadata.get("markdownText") or self.text), 600),
"contentFormat": str(self.metadata.get("contentFormat") or "plain"),
"formatFeatures": list(self.metadata.get("formatFeatures") or []),
```

- [ ] **Step 4: Ensure graph serialization preserves fields**

In `graph_builder.py`, do not strip unknown evidence keys. Confirm `_serialize_entity`, `_serialize_relation`, and `_serialize_claim` return evidence objects as persisted.

- [ ] **Step 5: Run graph tests**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_material_knowledge_graph
```

Expected: pass.

---

### Task 4: Expose Markdown In Knowledge Base Search And Citations

**Files:**
- Modify exact backend serializer/view found by `rg -n "snippet|display_location|metadata" backend/apps/knowledge_base`
- Modify frontend only where response is consumed:
  - `OpenMAIC/components/a3/features/knowledge-base-view.tsx`
  - existing classroom/coaching citation components if they read KB citations directly.

- [ ] **Step 1: Locate response builder**

Run:

```powershell
rg -n "snippet|display_location|KnowledgeBlock|search" backend/apps/knowledge_base backend/apps/learning
```

- [ ] **Step 2: Add backend response test**

Expected citation/search row shape:

```json
{
  "snippet": "系统方程为：s² + 2s + Kg = 0",
  "markdownSnippet": "系统方程为：$s^2 + 2s + Kg = 0$",
  "contentFormat": "markdown",
  "formatFeatures": ["math"]
}
```

- [ ] **Step 3: Implement response fields**

When serializing a block/citation, add:

```python
metadata = block.metadata or {}
row["markdownSnippet"] = metadata.get("markdownText") or row["snippet"]
row["contentFormat"] = metadata.get("contentFormat") or "plain"
row["formatFeatures"] = metadata.get("formatFeatures") or []
```

- [ ] **Step 4: Render frontend search snippet as Markdown**

In `knowledge-base-view.tsx`, use:

```tsx
{result.contentFormat === 'markdown' ? (
  <A3Markdown className="text-xs leading-6 text-[var(--a3-text-muted)]">{result.markdownSnippet || result.snippet}</A3Markdown>
) : (
  <p className="text-xs leading-6 text-[var(--a3-text-muted)]">{result.snippet}</p>
)}
```

---

### Task 5: Prefer Markdown Evidence In Knowledge Graph UI

**Files:**
- Modify: `OpenMAIC/components/a3/features/knowledge-graph-view.tsx`
- Test: `OpenMAIC/tests/a3-material-knowledge-graph.test.ts`

- [ ] **Step 1: Extend frontend type**

Add to `MaterialEvidence`:

```ts
markdownSnippet?: string;
contentFormat?: 'markdown' | 'plain' | string;
formatFeatures?: string[];
```

- [ ] **Step 2: Prefer markdown snippet**

Use:

```tsx
const evidenceText = item.markdownSnippet || item.snippet;
<A3Markdown className="mt-2 text-[var(--a3-text-muted)] [&_table]:min-w-[460px]">
  {formatMaterialMarkdown(evidenceText)}
</A3Markdown>
```

- [ ] **Step 3: Add static contract assertion**

```ts
expect(source).toContain('markdownSnippet?: string');
expect(source).toContain('item.markdownSnippet || item.snippet');
```

- [ ] **Step 4: Run Vitest**

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-material-knowledge-graph.test.ts tests/a3-classroom-markdown.test.ts
```

Expected: pass.

---

### Task 6: Demo Status And Capability Evidence

**Files:**
- Modify: `backend/apps/system` or existing demo status builder located by `rg -n "materialKnowledgeGraph|demo/status" backend`
- Modify: `OpenMAIC/components/a3/features/capabilities-view.tsx`
- Test: `backend/apps/knowledge_base/tests/test_material_knowledge_graph.py`
- Test: `OpenMAIC/tests/a3-capabilities-material-knowledge-graph.test.ts`

- [ ] **Step 1: Add demo status fields**

Expose:

```json
{
  "materialKnowledgeGraph": {
    "schemaVersion": "a3.material-knowledge-graph.v1",
    "markdownEvidence": {
      "contentFormat": "markdown",
      "mathCount": 1,
      "tableCount": 1,
      "rawTextPreserved": true
    }
  }
}
```

- [ ] **Step 2: Show capability evidence**

Add a compact status row on `/a3/capabilities`:

```tsx
<EvidenceRow label="Markdown evidence" value={`${mathCount} formulas · ${tableCount} tables · raw preserved`} />
```

- [ ] **Step 3: Run backend and frontend evidence tests**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_material_knowledge_graph
cd OpenMAIC
pnpm.cmd vitest run tests/a3-capabilities-material-knowledge-graph.test.ts
```

Expected: pass.

---

### Task 7: Backfill Existing Uploaded Materials Safely

**Files:**
- Create: `backend/apps/knowledge_base/management/commands/backfill_material_markdown.py`
- Test: `backend/apps/knowledge_base/tests/test_markdown_normalizer.py`

- [ ] **Step 1: Add dry-run command**

Command behavior:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py backfill_material_markdown --dry-run --limit 20
```

Expected output:

```text
scanned=20 updated=0 dryRun=True
```

- [ ] **Step 2: Implement command with no raw text overwrite**

For each `KnowledgeBlock`, update only metadata:

```python
block.metadata = {
    **(block.metadata or {}),
    "markdownText": normalized.markdown,
    "contentFormat": normalized.content_format,
    "formatFeatures": normalized.features,
    "rawTextPreserved": True,
}
block.save(update_fields=["metadata", "updated_at"])
```

- [ ] **Step 3: Add graph rebuild note**

Do not automatically rebuild all graphs in this command. Print:

```text
Run rebuild graph from the knowledge-base page or targeted graph rebuild command after verifying the backfill.
```

This avoids long-running unexpected graph jobs.

---

## Final Verification

Run these commands after all tasks:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py validate_demo_flow --skip-seed --strict
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.knowledge_base.tests.test_markdown_normalizer backend.apps.knowledge_base.tests.test_material_knowledge_graph
cd OpenMAIC
npx.cmd tsc --noEmit
pnpm.cmd lint
pnpm.cmd vitest run tests/a3-classroom-markdown.test.ts tests/a3-material-knowledge-graph.test.ts tests/a3-knowledge-graph-real-rendering.test.ts tests/a3-capabilities-material-knowledge-graph.test.ts
```

Expected:

- Backend checks pass.
- Demo flow remains strict-pass.
- Existing raw snippets remain available.
- New `markdownSnippet` renders formulas and tables.
- No new frontend lint errors beyond the documented historical warnings.

## Rollout Notes

- Do not mutate `KnowledgeBlock.text`.
- Do not delete existing `snippet`.
- Prefer `markdownSnippet` only when present.
- Existing uploaded files can be upgraded by dry-run backfill first, then targeted rebuild.
- Frontend `A3Markdown` remains as a display fallback for legacy data.

