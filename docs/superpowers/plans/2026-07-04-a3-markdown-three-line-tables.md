# A3 Markdown Three-Line Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render AI classroom structured Markdown tables as readable three-line tables and prompt future answers to emit valid table syntax.

**Architecture:** Keep `A3Markdown` as the single renderer for A3 assistant replies. Add a small table parser inside the existing handwritten renderer, then add prompt text that asks LLM tutoring answers to use standard table syntax for structured comparison content.

**Tech Stack:** React 19, Vitest, KaTeX, Django/Python prompt tests.

---

### Task 1: Table Rendering

**Files:**
- Modify: `OpenMAIC/tests/a3-classroom-markdown.test.ts`
- Modify: `OpenMAIC/components/a3/ui/a3-markdown.tsx`

- [ ] Add a failing Vitest case that renders a standard Markdown table and expects a `<table>` with three-line styling.
- [ ] Run `pnpm.cmd vitest run tests/a3-classroom-markdown.test.ts` and verify the new test fails because no table is rendered.
- [ ] Implement pipe-table detection with a header row, separator row, and one or more body rows.
- [ ] Render the table in an overflow wrapper with `<thead>`, `<tbody>`, `<th>`, and `<td>`.
- [ ] Run the same Vitest file and verify it passes.

### Task 2: Prompt Guardrails

**Files:**
- Modify: `backend/apps/compat/tests/test_llm_prompt.py`
- Modify: `backend/apps/compat/llm.py`
- Modify: `OpenMAIC/lib/server/a3-coaching-context.ts`

- [ ] Add a failing backend test that expects the tutoring prompt to mention standard Markdown tables.
- [ ] Run `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_llm_prompt` and verify the new assertion fails.
- [ ] Add prompt instructions for structured comparison/checklist output to use standard Markdown pipe tables and not pseudo tables.
- [ ] Add the same rule to the Next.js coaching system prompt used by classroom and vision routes.
- [ ] Run the backend prompt test again and verify it passes.

### Task 3: Verification

**Files:**
- No additional files.

- [ ] Run `pnpm.cmd vitest run tests/a3-classroom-markdown.test.ts tests/a3-coaching-markdown-rendering.test.ts`.
- [ ] Run `npx.cmd tsc --noEmit` for frontend type safety.
- [ ] Run `backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.compat.tests.test_llm_prompt`.
- [ ] Report exact commands and outcomes.
