from __future__ import annotations

import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from backend.domains.knowledge_base.lexical_retriever import search_lexical_knowledge_base
from backend.domains.knowledge_base.retriever import search_knowledge_base
from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult
from backend.domains.knowledge_base.text_vector_retriever import search_text_vector_knowledge_base


class RetrieverFilterTests(SimpleTestCase):
    def test_text_vector_search_filters_disallowed_sources_before_returning_results(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            allowed = root / "allowed.pdf"
            denied = root / "denied.pdf"
            index_path = root / "text-index.json"
            index_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "items": [
                            {
                                "block_id": "denied",
                                "source_path": str(denied),
                                "text": "denied evidence",
                                "embedding": [1.0, 0.0],
                            },
                            {
                                "block_id": "allowed",
                                "source_path": str(allowed),
                                "text": "allowed evidence",
                                "embedding": [0.8, 0.2],
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )

            with patch(
                "backend.domains.knowledge_base.text_vector_retriever._embed_text",
                return_value=[1.0, 0.0],
            ):
                results = search_text_vector_knowledge_base(
                    "deadlock",
                    top_k=2,
                    allowed_source_paths={str(allowed)},
                    index_path=index_path,
                )

        self.assertEqual([item.text for item in results], ["allowed evidence"])

    def test_search_filters_by_allowed_path_and_course(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            allowed = Path(temp_dir) / "allowed.pdf"
            other = Path(temp_dir) / "other.pdf"
            allowed.write_text("allowed", encoding="utf-8")
            other.write_text("other", encoding="utf-8")

            nodes = [
                _node("keep", allowed, "自动控制原理", 0.9),
                _node("wrong course", allowed, "材料力学", 0.8),
                _node("wrong owner", other, "自动控制原理", 0.7),
            ]
            index = SimpleNamespace(as_retriever=lambda similarity_top_k: SimpleNamespace(retrieve=lambda query: nodes))

            self.addCleanup(lambda: __import__("os").environ.pop("A3_ALLOW_ONLINE_EMBEDDING", None))
            __import__("os").environ["A3_ALLOW_ONLINE_EMBEDDING"] = "1"
            with patch("backend.domains.knowledge_base.retriever._load_knowledge_base_index", return_value=index):
                results = search_knowledge_base(
                    query="root locus",
                    top_k=5,
                    allowed_source_paths={str(allowed)},
                    course="自动控制原理",
                )

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].text, "keep")

    def test_text_vector_index_is_preferred_over_lexical_when_available(self):
        """本地 HF 模型不可用时，应优先用 DashScope 文本语义索引而不是 BM25。

        BM25 分数无上界（实测可达 9.79），与 0~1 的余弦分数混排会让弱相关的
        关键词命中压住更相关的语义结果，所以语义索引可用时它就是文本检索主力。
        """
        semantic = KnowledgeBaseSearchResult(
            score=0.72,
            text="死锁的四个必要条件",
            metadata={"retriever": "text_vector", "source_path": "os.pptx", "block_id": "b1"},
        )
        with patch("backend.domains.knowledge_base.retriever._embedding_model_available_locally", return_value=False):
            with patch("backend.domains.knowledge_base.retriever.text_vector_index_available", return_value=True):
                with patch("backend.domains.knowledge_base.retriever.search_text_vector_knowledge_base", return_value=[semantic]) as semantic_search:
                    with patch("backend.domains.knowledge_base.retriever.search_lexical_knowledge_base") as lexical:
                        with patch("backend.domains.knowledge_base.retriever.search_visual_knowledge_base", return_value=[]):
                            results = search_knowledge_base(query="死锁", top_k=3)

        semantic_search.assert_called_once()
        lexical.assert_not_called()
        self.assertEqual([item.metadata["retriever"] for item in results], ["text_vector"])

    def test_lexical_is_used_when_text_vector_index_is_empty(self):
        """语义索引为空时仍必须能退回 BM25，不能把检索整条打死。"""
        fallback = KnowledgeBaseSearchResult(
            score=0.5,
            text="bm25 evidence",
            metadata={"retriever": "bm25", "source_path": "os.pdf"},
        )
        with patch("backend.domains.knowledge_base.retriever._embedding_model_available_locally", return_value=False):
            with patch("backend.domains.knowledge_base.retriever.text_vector_index_available", return_value=True):
                with patch("backend.domains.knowledge_base.retriever.search_text_vector_knowledge_base", return_value=[]):
                    with patch("backend.domains.knowledge_base.retriever.search_lexical_knowledge_base", return_value=[fallback]) as lexical:
                        with patch("backend.domains.knowledge_base.retriever.search_visual_knowledge_base", return_value=[]):
                            results = search_knowledge_base(query="死锁", top_k=3)

        lexical.assert_called_once()
        self.assertEqual([item.metadata["retriever"] for item in results], ["bm25"])

    def test_visual_retrieval_uses_lexical_mode_after_semantic_query_timeout(self):
        fallback = KnowledgeBaseSearchResult(
            score=0.5,
            text="bm25 evidence",
            metadata={"retriever": "bm25", "source_path": "os.pdf"},
        )
        with patch("backend.domains.knowledge_base.retriever._embedding_model_available_locally", return_value=False):
            with patch("backend.domains.knowledge_base.retriever.text_vector_index_available", return_value=True):
                with patch(
                    "backend.domains.knowledge_base.retriever.search_text_vector_knowledge_base",
                    side_effect=TimeoutError("embedding timed out"),
                ):
                    with patch(
                        "backend.domains.knowledge_base.retriever.search_lexical_knowledge_base",
                        return_value=[fallback],
                    ):
                        with patch(
                            "backend.domains.knowledge_base.retriever.search_visual_knowledge_base",
                            return_value=[],
                        ) as visual:
                            search_knowledge_base(query="死锁", top_k=3)

        self.assertFalse(visual.call_args.kwargs["use_embedding"])

    def test_search_uses_lexical_fallback_when_embedding_model_is_not_cached(self):
        fallback = [
            KnowledgeBaseSearchResult(
                score=1.0,
                text="根轨迹是闭环特征根在复平面上的变化轨迹",
                metadata={"retriever": "bm25"},
            )
        ]

        # 文本语义索引不可用时才会退到 BM25，这里显式关掉以隔离生产索引文件。
        with patch("backend.domains.knowledge_base.retriever.text_vector_index_available", return_value=False):
            with patch("backend.domains.knowledge_base.retriever._embedding_model_available_locally", return_value=False):
                with patch("backend.domains.knowledge_base.retriever.search_lexical_knowledge_base", return_value=fallback) as lexical:
                    results = search_knowledge_base(query="根轨迹", top_k=1)

        self.assertEqual(results, fallback)
        lexical.assert_called_once()

    def test_search_merges_visual_vector_results(self):
        text_result = KnowledgeBaseSearchResult(
            score=0.8,
            text="Root locus text evidence",
            metadata={"retriever": "bm25", "source_path": "text.pdf"},
        )
        visual_result = KnowledgeBaseSearchResult(
            score=0.95,
            text="Root locus slide image",
            metadata={"retriever": "visual_vector", "source_path": "slide.pptx", "block_id": "block-1"},
        )

        with patch("backend.domains.knowledge_base.retriever.text_vector_index_available", return_value=False):
            with patch("backend.domains.knowledge_base.retriever._embedding_model_available_locally", return_value=False):
                with patch("backend.domains.knowledge_base.retriever.search_lexical_knowledge_base", return_value=[text_result]):
                    with patch("backend.domains.knowledge_base.retriever.search_visual_knowledge_base", return_value=[visual_result]) as visual:
                        results = search_knowledge_base(query="root locus", top_k=3)

        self.assertEqual([item.metadata["retriever"] for item in results], ["visual_vector", "bm25"])
        visual.assert_called_once()

    def test_search_boosts_personal_scope_and_preserves_original_score(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            personal = Path(temp_dir) / "personal.pdf"
            teacher = Path(temp_dir) / "teacher.pdf"
            personal.write_text("personal root locus note", encoding="utf-8")
            teacher.write_text("teacher root locus courseware", encoding="utf-8")
            personal_result = KnowledgeBaseSearchResult(
                score=0.8,
                text="student personal evidence",
                metadata={"retriever": "bm25", "source_path": str(personal)},
            )
            teacher_result = KnowledgeBaseSearchResult(
                score=0.85,
                text="teacher evidence",
                metadata={"retriever": "bm25", "source_path": str(teacher)},
            )

            with patch("backend.domains.knowledge_base.retriever.search_lexical_knowledge_base", return_value=[teacher_result, personal_result]):
                with patch("backend.domains.knowledge_base.retriever.search_visual_knowledge_base", return_value=[]):
                    results = search_knowledge_base(
                        query="root locus",
                        top_k=2,
                        allowed_source_paths={str(personal), str(teacher)},
                        source_scope_by_path={
                            str(personal): "personal",
                            str(teacher): "teacher",
                        },
                        force_lexical=True,
                    )

        self.assertEqual(results[0].text, "student personal evidence")
        self.assertEqual(results[0].metadata["source_scope"], "personal")
        self.assertEqual(results[0].metadata["original_score"], 0.8)
        self.assertEqual(results[1].metadata["source_scope"], "teacher")

    def test_search_allows_interactive_callers_to_limit_vector_candidates(self):
        captured = {}

        def as_retriever(similarity_top_k):
            captured["similarity_top_k"] = similarity_top_k
            return SimpleNamespace(retrieve=lambda query: [])

        index = SimpleNamespace(as_retriever=as_retriever)

        self.addCleanup(lambda: __import__("os").environ.pop("A3_ALLOW_ONLINE_EMBEDDING", None))
        __import__("os").environ["A3_ALLOW_ONLINE_EMBEDDING"] = "1"
        with patch("backend.domains.knowledge_base.retriever._load_knowledge_base_index", return_value=index):
            search_knowledge_base(query="root locus", top_k=5, candidate_multiplier=2)

        self.assertEqual(captured["similarity_top_k"], 10)

    def test_hybrid_mode_applies_bm25_candidates_weights_and_threshold(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            vector_path = Path(temp_dir) / "vector.pdf"
            bm25_path = Path(temp_dir) / "bm25.pdf"
            vector_path.write_text("vector", encoding="utf-8")
            bm25_path.write_text("bm25", encoding="utf-8")
            vector_node = _node("vector evidence", vector_path, "", 0.9)
            index = SimpleNamespace(as_retriever=lambda similarity_top_k: SimpleNamespace(retrieve=lambda query: [vector_node]))
            bm25_result = KnowledgeBaseSearchResult(
                score=0.8,
                text="bm25 evidence",
                metadata={"retriever": "bm25", "source_path": str(bm25_path)},
            )

            self.addCleanup(lambda: __import__("os").environ.pop("A3_ALLOW_ONLINE_EMBEDDING", None))
            __import__("os").environ["A3_ALLOW_ONLINE_EMBEDDING"] = "1"
            with patch("backend.domains.knowledge_base.retriever._load_knowledge_base_index", return_value=index):
                with patch("backend.domains.knowledge_base.retriever.search_lexical_knowledge_base", return_value=[bm25_result]) as lexical:
                    with patch("backend.domains.knowledge_base.retriever.search_visual_knowledge_base", return_value=[]):
                        results = search_knowledge_base(
                            query="root locus",
                            top_k=3,
                            allowed_source_paths={str(vector_path), str(bm25_path)},
                            retrieval_mode="hybrid",
                            bm25_candidate_count=7,
                            similarity_threshold=0.2,
                            vector_weight=0.1,
                            bm25_weight=1.0,
                        )

        lexical.assert_called_once()
        self.assertEqual(lexical.call_args.kwargs["top_k"], 7)
        self.assertEqual([item.text for item in results], ["bm25 evidence"])
        self.assertEqual(results[0].score, 0.8)
        self.assertEqual(results[0].metadata["pre_weight_score"], 0.8)
        self.assertEqual(results[0].metadata["retrieval_weight"], 1.0)
        self.assertEqual(results[0].metadata["weighted_score"], 0.8)

    def test_lexical_fallback_scans_all_files_when_allowed_paths_are_provided(self):
        allowed_path = str((Path.cwd() / "uploaded.xlsx").resolve())
        doc = {
            "text": "标准问题：根轨迹如何绘制？\n答案：根据闭环特征根随增益变化绘制。",
            "metadata": {"source_path": allowed_path, "course": "教学问答数据集", "original_name": "uploaded.xlsx"},
            "tokens": ["根轨迹", "绘制", "闭环"],
        }

        with patch("backend.domains.knowledge_base.lexical_retriever._load_lexical_documents_for_paths", return_value=(doc,)) as load_docs:
            results = search_lexical_knowledge_base(
                query="根轨迹",
                top_k=1,
                allowed_source_paths={allowed_path},
                data_root=Path.cwd(),
            )

        self.assertEqual(results[0].metadata["original_name"], "uploaded.xlsx")
        load_docs.assert_called_once_with((allowed_path,))


def _node(text: str, source_path: Path, course: str, score: float):
    node = SimpleNamespace(
        metadata={"source_path": str(source_path), "course": course},
        get_content=lambda: text,
    )
    return SimpleNamespace(node=node, score=score)
