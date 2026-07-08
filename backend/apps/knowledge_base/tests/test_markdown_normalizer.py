from io import StringIO
from pathlib import Path
import tempfile

from django.core.management import call_command
from django.test import SimpleTestCase, TestCase

from backend.apps.accounts.models import User
from backend.apps.knowledge_base.models import KnowledgeBlock, KnowledgePage, KnowledgeResource, ResourceStatus
from backend.domains.knowledge_base.markdown_normalizer import normalize_material_markdown


class MaterialMarkdownNormalizerTests(SimpleTestCase):
    def test_normalizes_bare_equation_to_inline_latex(self):
        result = normalize_material_markdown("系统方程为：s² + 2s + Kg = 0，用于根轨迹分析。")

        self.assertIn("$s^2 + 2s + Kg = 0$", result.markdown)
        self.assertEqual(result.content_format, "markdown")
        self.assertIn("math", result.features)
        self.assertEqual(result.raw_text, "系统方程为：s² + 2s + Kg = 0，用于根轨迹分析。")

    def test_repairs_compact_pipe_table(self):
        result = normalize_material_markdown("| 评价阶段 | 评价项目 | 权重 | 平时成绩 | 自主学习 | 20% | 课堂测验 | 知识掌握 | 20% |")

        self.assertIn("| 评价阶段 | 评价项目 | 权重 |", result.markdown)
        self.assertIn("| --- | --- | --- |", result.markdown)
        self.assertIn("| 平时成绩 | 自主学习 | 20% |", result.markdown)
        self.assertIn("table", result.features)

    def test_repairs_heading_and_table_compacted_by_llm_answer(self):
        result = normalize_material_markdown(
            "--- ### 二、绘制根轨迹的四条基本法则 根据资料整理如下： "
            "| 法则 | 内容 | 应用示例 | |-----|------|------|\n"
            "| 起点与终点 | 起于开环极点 | 开环极点：s=0, s=-2 |"
        )

        self.assertIn("### 二、绘制根轨迹的四条基本法则 根据资料整理如下：", result.markdown)
        self.assertIn("| 法则 | 内容 | 应用示例 |", result.markdown)
        self.assertIn("| ----- | ------ | ------ |", result.markdown)
        self.assertIn("| 起点与终点 | 起于开环极点 | 开环极点：s=0, s=-2 |", result.markdown)
        self.assertNotIn("--- ###", result.markdown)
        self.assertIn("table", result.features)

    def test_keeps_raw_plain_text_readable(self):
        result = normalize_material_markdown("根轨迹描述闭环极点随参数变化的轨迹。")

        self.assertEqual(result.markdown, "根轨迹描述闭环极点随参数变化的轨迹。")
        self.assertEqual(result.raw_text, "根轨迹描述闭环极点随参数变化的轨迹。")

    def test_repairs_common_bullet_markers(self):
        result = normalize_material_markdown("• 根轨迹\n· 闭环极点")

        self.assertIn("- 根轨迹", result.markdown)
        self.assertIn("- 闭环极点", result.markdown)
        self.assertIn("list", result.features)

    def test_repairs_ppt_symbol_font_private_use_characters(self):
        result = normalize_material_markdown(
            "0\uf0ae\uf0a5；s2 = \uf02d2；Kg\uf0ad \uf0aes1\uf0af；用\uf0b4表示；"
            "\uf0e5\uf06aj - \uf0e5\uf071i = (2k+1)\uf070；n \uf02d m \uf0b3 2；60\uf0b0"
        )

        self.assertNotRegex(result.markdown, r"[\ue000-\uf8ff]")
        self.assertIn("0→∞", result.markdown)
        self.assertIn("s2 = -2", result.markdown)
        self.assertIn("Kg↑ →s1↓", result.markdown)
        self.assertIn("×", result.markdown)
        self.assertIn("Σφj - Σθi", result.markdown)
        self.assertIn("(2k+1)π", result.markdown)
        self.assertIn("n - m ≥ 2", result.markdown)
        self.assertIn("60°", result.markdown)
        self.assertIn("symbol_repair", result.features)

    def test_does_not_split_multiple_assignment_equations(self):
        result = normalize_material_markdown(
            "求得闭环特征根为： 系统的闭环特征方程为： s2 + 2s + Kg = 0 "
            "求得闭环特征根为： (1) Kg= 0：s1 = 0,s2 = \uf02d2,是根迹的起点(开环极点),用“\uf0b4”表示。"
        )

        self.assertIn("$s^2 + 2s + Kg = 0$", result.markdown)
        self.assertIn("s1 = 0,s2 = -2", result.markdown)
        self.assertNotIn("$s1 = 0,s2$= -2", result.markdown)
        self.assertNotIn("$(1) Kg= 0$", result.markdown)
        self.assertNotRegex(result.markdown, r"[\ue000-\uf8ff]")


class BackfillMaterialMarkdownCommandTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800139901", password="secure-pass-123")
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)

    def test_backfill_dry_run_does_not_update_blocks(self):
        block = self._block()
        output = StringIO()

        call_command("backfill_material_markdown", "--dry-run", "--limit=20", stdout=output)

        block.refresh_from_db()
        self.assertNotIn("markdownText", block.metadata)
        self.assertIn("scanned=1 updated=0 dryRun=True", output.getvalue())

    def test_backfill_updates_metadata_without_changing_raw_text(self):
        block = self._block()
        output = StringIO()

        call_command("backfill_material_markdown", "--limit=20", stdout=output)

        block.refresh_from_db()
        self.assertEqual(block.text, "系统方程为：s² + 2s + Kg = 0")
        self.assertEqual(block.metadata["markdownText"], "系统方程为：$s^2 + 2s + Kg = 0$")
        self.assertEqual(block.metadata["contentFormat"], "markdown")
        self.assertEqual(block.metadata["formatFeatures"], ["math"])
        self.assertTrue(block.metadata["rawTextPreserved"])
        self.assertIn("scanned=1 updated=1 dryRun=False", output.getvalue())
        self.assertIn("Run rebuild graph", output.getvalue())

    def _block(self) -> KnowledgeBlock:
        path = Path(self.temp_dir.name) / "formula.pdf"
        path.write_text("demo", encoding="utf-8")
        resource = KnowledgeResource.objects.create(
            owner=self.user,
            original_name="formula.pdf",
            stored_path=str(path.resolve()),
            file_type=".pdf",
            file_size=path.stat().st_size,
            status=ResourceStatus.INDEXED,
        )
        page = KnowledgePage.objects.create(resource=resource, page_number=1)
        return KnowledgeBlock.objects.create(
            resource=resource,
            page=page,
            modality="text",
            text="系统方程为：s² + 2s + Kg = 0",
            metadata={},
            confidence=0.8,
        )
