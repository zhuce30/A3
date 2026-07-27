"""重建文本块语义索引（text_vector）。

用于补上被跳过的文本向量检索：默认的本地 HuggingFace 嵌入模型不可用时，
本命令用 DashScope embedding 为所有文本/表格/公式块建立语义索引。
"""

from __future__ import annotations

from pathlib import Path

from django.core.management.base import BaseCommand

from backend.domains.knowledge_base.text_vector_retriever import (
    DEFAULT_TEXT_INDEX_PATH,
    build_text_vector_index,
)


class Command(BaseCommand):
    help = "为知识库文本块重建语义向量索引（text_vector）"

    def add_arguments(self, parser):
        parser.add_argument("--index-path", type=Path, default=DEFAULT_TEXT_INDEX_PATH)
        parser.add_argument("--batch-size", type=int, default=10)
        parser.add_argument("--limit", type=int, default=None, help="仅索引前 N 个块，便于小样本验证")

    def handle(self, *args, **options):
        def report(detail: dict) -> None:
            done = detail.get("done")
            total = detail.get("total")
            failed = detail.get("failed") or 0
            suffix = f"，失败 {failed}" if failed else ""
            error = detail.get("error")
            if error:
                suffix += f"，最近错误：{error}"
            self.stdout.write(f"  进度 {done}/{total}{suffix}")

        stats = build_text_vector_index(
            index_path=options["index_path"],
            batch_size=options["batch_size"],
            limit=options["limit"],
            progress=report,
        )
        self.stdout.write(
            self.style.SUCCESS(
                f"文本语义索引完成：已索引 {stats['indexed']}/{stats['candidates']} 块"
                f"，失败 {stats['failed']}，写入 {stats['indexPath']}"
            )
        )
