from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from backend.domains.knowledge_base.index_manager import append_source_file
from backend.domains.knowledge_base.retriever import _load_knowledge_base_index


class IncrementalIndexInitializationTests(SimpleTestCase):
    def test_loader_treats_visual_only_directory_as_missing_text_index(self):
        with TemporaryDirectory() as temp_dir:
            persist_dir = Path(temp_dir) / "faiss_index"
            persist_dir.mkdir()
            (persist_dir / "a3_visual_index.json").write_text("{}", encoding="utf-8")

            with self.assertRaisesRegex(FileNotFoundError, "Knowledge base index not found"):
                _load_knowledge_base_index(persist_dir=persist_dir)

    def test_append_initializes_text_index_when_visual_index_created_directory_first(self):
        document = MagicMock()
        document.metadata = {}
        index = MagicMock()
        index.docstore.docs = {"node-1": object()}

        with TemporaryDirectory() as temp_dir:
            source_path = Path(temp_dir) / "lesson.pdf"
            source_path.write_bytes(b"pdf")
            persist_dir = Path(temp_dir) / "faiss_index"
            persist_dir.mkdir()
            (persist_dir / "a3_visual_index.json").write_text("{}", encoding="utf-8")

            with (
                patch(
                    "backend.domains.knowledge_base.index_manager.load_documents",
                    return_value=([document], []),
                ),
                patch(
                    "backend.domains.knowledge_base.index_manager._load_knowledge_base_index",
                    side_effect=FileNotFoundError(f"Knowledge base index not found: {persist_dir}"),
                ),
                patch(
                    "backend.domains.knowledge_base.index_manager._build_new_index",
                    return_value=index,
                ) as build_new_index,
            ):
                document_count, chunk_count, skipped = append_source_file(
                    source_path,
                    persist_dir=persist_dir,
                    metadata={"resource_id": "resource-1"},
                )

        self.assertEqual(document_count, 1)
        self.assertEqual(chunk_count, 1)
        self.assertEqual(skipped, [])
        self.assertEqual(document.metadata["resource_id"], "resource-1")
        build_new_index.assert_called_once()
        index.storage_context.persist.assert_called_once()
