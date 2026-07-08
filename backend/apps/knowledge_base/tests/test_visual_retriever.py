from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

from django.test import TestCase
from PIL import Image

from backend.apps.accounts.models import User, UserRole
from backend.apps.knowledge_base.models import (
    KnowledgeAsset,
    KnowledgeBlock,
    KnowledgePage,
    KnowledgeParseRun,
    KnowledgeResource,
    ResourceScope,
    ResourceStatus,
)
from backend.domains.knowledge_base.visual_retriever import (
    _embed_image,
    _embed_text,
    _visual_backend_name,
    remove_visual_resource_entries,
    search_visual_knowledge_base,
    upsert_visual_blocks,
)


class VisualRetrieverTests(TestCase):
    def setUp(self):
        self.teacher = User.objects.create_user(phone="13800139100", password="secure-pass-123", role=UserRole.TEACHER)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)

    @patch("backend.domains.knowledge_base.visual_retriever._embed_text", return_value=[1.0, 0.0, 0.0])
    @patch("backend.domains.knowledge_base.visual_retriever._embed_image", return_value=[1.0, 0.0, 0.0])
    def test_visual_index_retrieves_matching_image_asset(self, _embed_image, _embed_text):
        image_path = Path(self.temp_dir.name) / "slide.png"
        Image.new("RGB", (8, 6), color=(255, 255, 255)).save(image_path)
        pptx_path = Path(self.temp_dir.name) / "root-locus.pptx"
        pptx_path.write_bytes(b"pptx")
        resource = KnowledgeResource.objects.create(
            owner=self.teacher,
            original_name="root-locus.pptx",
            stored_path=str(pptx_path),
            file_type=".pptx",
            file_size=pptx_path.stat().st_size,
            resource_scope=ResourceScope.PERSONAL,
            status=ResourceStatus.INDEXED_WITH_WARNINGS,
        )
        parse_run = KnowledgeParseRun.objects.create(resource=resource, status="completed_with_warnings", parser="native")
        page = KnowledgePage.objects.create(resource=resource, parse_run=parse_run, page_number=3, slide_number=3)
        asset = KnowledgeAsset.objects.create(
            resource=resource,
            page=page,
            kind="rendered_slide",
            storage_path=str(image_path),
            mime_type="image/png",
            width=8,
            height=6,
        )
        block = KnowledgeBlock.objects.create(
            resource=resource,
            page=page,
            asset=asset,
            modality="slide_image",
            text="Root locus visual slide",
            confidence=0.8,
        )
        index_path = Path(self.temp_dir.name) / "visual-index.json"

        upsert_visual_blocks(resource, index_path=index_path)
        results = search_visual_knowledge_base(
            query="root locus",
            top_k=3,
            allowed_source_paths={str(pptx_path.resolve())},
            index_path=index_path,
        )

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].metadata["retriever"], "visual_vector")
        self.assertEqual(results[0].metadata["source_scope"], ResourceScope.PERSONAL)

    @patch("backend.domains.knowledge_base.visual_retriever._embed_text")
    def test_fast_visual_search_uses_index_text_without_loading_embedding_model(self, embed_text):
        source_path = Path(self.temp_dir.name) / "m01.pptx"
        source_path.write_bytes(b"pptx")
        index_path = Path(self.temp_dir.name) / "visual-index.json"
        index_path.write_text(
            json.dumps({
                "version": 1,
                "backend": "test",
                "items": [{
                    "block_id": "block-1",
                    "asset_id": "asset-1",
                    "resource_id": "resource-1",
                    "source_path": str(source_path),
                    "resource_name": "M01绪论.pptx",
                    "modality": "slide_image",
                    "text": "杆件的几何要素包括轴线、横截面形状和尺寸。",
                    "page": None,
                    "slide": 3,
                    "embedding": [0.1, 0.2],
                }],
            }),
            encoding="utf-8",
        )

        results = search_visual_knowledge_base("杆件的几何要素", top_k=1, index_path=index_path, use_embedding=False)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].metadata["retriever"], "visual_vector")
        embed_text.assert_not_called()

    def test_remove_visual_resource_entries_deletes_resource_from_index_file(self):
        first_source = Path(self.temp_dir.name) / "first.pptx"
        second_source = Path(self.temp_dir.name) / "second.pptx"
        index_path = Path(self.temp_dir.name) / "visual-index.json"
        index_path.write_text(
            json.dumps({
                "version": 1,
                "backend": "dashscope:qwen3-vl-embedding",
                "items": [
                    {
                        "block_id": "block-1",
                        "asset_id": "asset-1",
                        "resource_id": "resource-1",
                        "source_path": str(first_source),
                        "embedding": [0.1],
                    },
                    {
                        "block_id": "block-2",
                        "asset_id": "asset-2",
                        "resource_id": "resource-2",
                        "source_path": str(second_source),
                        "embedding": [0.2],
                    },
                ],
            }),
            encoding="utf-8",
        )

        removed = remove_visual_resource_entries("resource-1", first_source, index_path=index_path)

        self.assertEqual(removed, 1)
        payload = json.loads(index_path.read_text(encoding="utf-8"))
        self.assertEqual([item["resource_id"] for item in payload["items"]], ["resource-2"])

    @patch.dict(
        "os.environ",
        {
            "A3_VISUAL_EMBED_PROVIDER": "dashscope",
            "A3_VISUAL_EMBED_API_KEY": "test-key",
            "A3_VISUAL_EMBED_BASE_URL": "https://dashscope.aliyuncs.com",
            "A3_VISUAL_EMBED_MODEL": "qwen3-vl-embedding",
            "A3_VISUAL_EMBED_DIMENSIONS": "1024",
        },
        clear=False,
    )
    @patch("backend.domains.knowledge_base.visual_retriever.urlopen")
    def test_dashscope_text_embedding_uses_native_multimodal_endpoint(self, urlopen_mock):
        urlopen_mock.return_value.__enter__.return_value.read.return_value = json.dumps(
            {"output": {"embeddings": [{"index": 0, "type": "text", "embedding": [0.1, 0.2, 0.3]}]}}
        ).encode("utf-8")

        vector = _embed_text("杆件几何要素")

        self.assertEqual(vector, [0.1, 0.2, 0.3])
        request = urlopen_mock.call_args.args[0]
        self.assertEqual(
            request.full_url,
            "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
        )
        self.assertEqual(request.headers["Authorization"], "Bearer test-key")
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(payload["model"], "qwen3-vl-embedding")
        self.assertEqual(payload["input"]["contents"], [{"text": "杆件几何要素"}])
        self.assertEqual(payload["parameters"]["dimension"], 1024)

    @patch.dict(
        "os.environ",
        {
            "A3_VISUAL_EMBED_PROVIDER": "dashscope",
            "A3_VISUAL_EMBED_API_KEY": "test-key",
            "A3_VISUAL_EMBED_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "A3_VISUAL_EMBED_MODEL": "qwen3-vl-embedding",
        },
        clear=False,
    )
    @patch("backend.domains.knowledge_base.visual_retriever._get_visual_model")
    @patch("backend.domains.knowledge_base.visual_retriever.urlopen")
    def test_dashscope_image_embedding_sends_local_image_as_data_uri(self, urlopen_mock, get_visual_model):
        image_path = Path(self.temp_dir.name) / "slide.png"
        Image.new("RGB", (4, 4), color=(255, 255, 255)).save(image_path)
        urlopen_mock.return_value.__enter__.return_value.read.return_value = json.dumps(
            {"output": {"embeddings": [{"index": 0, "type": "vl", "embedding": [1.0, 0.0]}]}}
        ).encode("utf-8")

        vector = _embed_image(image_path)

        self.assertEqual(vector, [1.0, 0.0])
        get_visual_model.assert_not_called()
        request = urlopen_mock.call_args.args[0]
        self.assertEqual(
            request.full_url,
            "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
        )
        image_value = json.loads(request.data.decode("utf-8"))["input"]["contents"][0]["image"]
        self.assertTrue(image_value.startswith("data:image/png;base64,"))

    @patch.dict(
        "os.environ",
        {
            "A3_VISUAL_EMBED_PROVIDER": "dashscope",
            "A3_VISUAL_EMBED_API_KEY": "test-key",
            "A3_VISUAL_EMBED_MODEL": "qwen3-vl-embedding",
        },
        clear=False,
    )
    def test_dashscope_visual_backend_name_includes_provider_and_model(self):
        self.assertEqual(_visual_backend_name(), "dashscope:qwen3-vl-embedding")

    @patch.dict(
        "os.environ",
        {
            "A3_VISUAL_EMBED_PROVIDER": "dashscope",
            "A3_VISUAL_EMBED_API_KEY": "test-key",
            "A3_VISUAL_EMBED_MODEL": "qwen3-vl-embedding",
        },
        clear=False,
    )
    @patch("backend.domains.knowledge_base.visual_retriever.urlopen")
    def test_dashscope_embedding_http_error_has_readable_message(self, urlopen_mock):
        urlopen_mock.side_effect = HTTPError(
            "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
            401,
            "Unauthorized",
            {},
            None,
        )

        with self.assertRaisesRegex(RuntimeError, "DashScope visual embedding request failed"):
            _embed_text("test")
