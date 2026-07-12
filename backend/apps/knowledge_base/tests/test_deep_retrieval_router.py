from __future__ import annotations

import tempfile
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from django.core.management import call_command
from django.test import Client, TestCase

from backend.apps.accounts.models import User, UserRole
from backend.apps.knowledge_base.models import (
    KnowledgeBlock,
    KnowledgeConcept,
    KnowledgeDefinition,
    KnowledgeGraphEntity,
    KnowledgeGraphRelation,
    KnowledgePage,
    KnowledgeResource,
    ResourceScope,
    ResourceStatus,
)
from backend.apps.knowledge_base.graph_builder import rebuild_resource_graph
from backend.apps.knowledge_base.wiki_builder import rebuild_resource_wiki
from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult


class DeepRetrievalRouterTests(TestCase):
    def setUp(self):
        self.teacher = User.objects.create_user(
            phone="13800139300",
            password="secure-pass-123",
            role=UserRole.TEACHER,
        )
        self.client = Client()
        self.client.force_login(self.teacher)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)

    @patch("backend.apps.knowledge_base.views.search_knowledge_base")
    def test_definition_query_routes_to_wiki_evidence(self, search_knowledge_base):
        resource, block = self._resource_with_block(
            "root-locus.pdf",
            "Root Locus is a graphical method for analyzing closed-loop pole movement.",
        )
        concept = KnowledgeConcept.objects.create(
            owner=self.teacher,
            resource=resource,
            preferred_label="Root Locus",
            normalized_label="root locus",
            summary="A graphical method for analyzing closed-loop pole movement.",
            source_count=1,
            evidence=[self._evidence(resource, block)],
        )
        KnowledgeDefinition.objects.create(
            owner=self.teacher,
            concept=concept,
            resource=resource,
            definition="Root Locus is a graphical method for analyzing closed-loop pole movement.",
            source_block=block,
            evidence=[self._evidence(resource, block)],
        )
        search_knowledge_base.return_value = [
            KnowledgeBaseSearchResult(
                score=0.75,
                text=block.text,
                metadata={"source_path": resource.stored_path, "block_id": str(block.id), "retriever": "vector"},
            )
        ]

        response = self.client.get("/api/kb/search/?q=Root%20Locus%20是什么&top_k=3")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["retrieval"]["route"], "wiki")
        self.assertEqual(payload["retrieval"]["intent"], "definition")
        self.assertFalse(payload["retrieval"]["fallback"])
        self.assertEqual(payload["wikiEvidence"][0]["preferredLabel"], "Root Locus")
        self.assertEqual(payload["wikiEvidence"][0]["definitions"][0]["blockId"], str(block.id))
        self.assertEqual(payload["results"][0]["metadata"]["retriever"], "wiki")

    @patch("backend.apps.knowledge_base.views.search_knowledge_base")
    def test_multihop_query_routes_to_graph_path_and_backfills_vector_evidence(self, search_knowledge_base):
        resource, block = self._resource_with_block(
            "control.pdf",
            "Root Locus explains gain changes. Gain Margin affects Closed Loop Pole stability.",
        )
        source = KnowledgeGraphEntity.objects.create(
            owner=self.teacher,
            resource=resource,
            label="Root Locus",
            normalized_label="root locus",
            summary="Analyzes closed-loop pole movement.",
            source_locations=[self._evidence(resource, block)],
            source_count=1,
            confidence=0.9,
        )
        bridge = KnowledgeGraphEntity.objects.create(
            owner=self.teacher,
            resource=resource,
            label="Gain Margin",
            normalized_label="gain margin",
            summary="Measures stability margin under gain changes.",
            source_locations=[self._evidence(resource, block)],
            source_count=1,
            confidence=0.86,
        )
        target = KnowledgeGraphEntity.objects.create(
            owner=self.teacher,
            resource=resource,
            label="Closed Loop Pole",
            normalized_label="closed loop pole",
            summary="Pole of the closed-loop system.",
            source_locations=[self._evidence(resource, block)],
            source_count=1,
            confidence=0.88,
        )
        KnowledgeGraphRelation.objects.create(
            owner=self.teacher,
            resource=resource,
            source_entity=source,
            target_entity=bridge,
            relation_type="explains",
            label="explains",
            weight=0.83,
            evidence=[self._evidence(resource, block)],
            degraded=False,
        )
        KnowledgeGraphRelation.objects.create(
            owner=self.teacher,
            resource=resource,
            source_entity=bridge,
            target_entity=target,
            relation_type="influences",
            label="affects",
            weight=0.87,
            evidence=[self._evidence(resource, block)],
            degraded=False,
        )
        search_knowledge_base.return_value = [
            KnowledgeBaseSearchResult(
                score=0.81,
                text=block.text,
                metadata={"source_path": resource.stored_path, "block_id": str(block.id), "retriever": "vector"},
            )
        ]

        response = self.client.get("/api/kb/search/?q=Root%20Locus%20如何影响%20Closed%20Loop%20Pole&top_k=3")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["retrieval"]["route"], "graph")
        self.assertEqual(payload["retrieval"]["intent"], "multi_hop")
        self.assertGreaterEqual(len(payload["retrieval"]["subQuestions"]), 2)
        self.assertEqual(payload["graphEvidence"][0]["sourceLabel"], "Root Locus")
        self.assertEqual(payload["graphEvidence"][0]["targetLabel"], "Closed Loop Pole")
        self.assertEqual(payload["graphEvidence"][0]["hops"], 2)
        self.assertEqual(payload["graphEvidence"][0]["pathLabels"], ["Root Locus", "Gain Margin", "Closed Loop Pole"])
        self.assertEqual(len(payload["graphEvidence"][0]["relations"]), 2)
        self.assertGreater(payload["graphEvidence"][0]["evidenceCoverage"], 0.9)
        retrievers = {item["metadata"]["retriever"] for item in payload["results"]}
        self.assertIn("graph", retrievers)
        self.assertIn("vector", retrievers)

    @patch("backend.apps.knowledge_base.views.search_knowledge_base")
    def test_plain_query_uses_vector_route(self, search_knowledge_base):
        resource, block = self._resource_with_block("lesson.pdf", "Root Locus has asymptote rules.")
        search_knowledge_base.return_value = [
            KnowledgeBaseSearchResult(
                score=0.92,
                text=block.text,
                metadata={"source_path": resource.stored_path, "block_id": str(block.id), "retriever": "vector"},
            )
        ]

        response = self.client.get("/api/kb/search/?q=Root%20Locus%20asymptote&top_k=3")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["retrieval"]["route"], "vector")
        self.assertEqual(payload["retrieval"]["intent"], "fact")
        self.assertEqual(payload["wikiEvidence"], [])
        self.assertEqual(payload["graphEvidence"], [])

    @patch("backend.apps.knowledge_base.views.search_knowledge_base")
    def test_graph_route_falls_back_when_no_graph_evidence_exists(self, search_knowledge_base):
        resource, block = self._resource_with_block("empty-graph.pdf", "Only vector evidence exists.")
        search_knowledge_base.return_value = [
            KnowledgeBaseSearchResult(
                score=0.64,
                text=block.text,
                metadata={"source_path": resource.stored_path, "block_id": str(block.id), "retriever": "bm25"},
            )
        ]

        response = self.client.get("/api/kb/search/?q=A%20和%20B%20之间有什么关系&top_k=3")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["retrieval"]["route"], "vector")
        self.assertTrue(payload["retrieval"]["fallback"])
        self.assertEqual(payload["retrieval"]["fallbackReason"], "没有可用的资料知识图谱证据，已降级到向量/关键词检索")

    def test_rebuild_resource_graph_creates_wiki_concept_definition(self):
        resource, _block = self._resource_with_block(
            "wiki-source.pdf",
            "Root Locus is a graphical method for analyzing Closed Loop Pole movement. "
            "Closed Loop Pole is part of a closed-loop control system.",
        )

        result = rebuild_resource_graph(resource)

        self.assertEqual(result.status, "ready")
        concept = KnowledgeConcept.objects.get(resource=resource, normalized_label="root locus")
        self.assertEqual(concept.preferred_label, "Root Locus")
        self.assertGreaterEqual(concept.source_count, 1)
        definition = KnowledgeDefinition.objects.get(concept=concept)
        self.assertIn("graphical method", definition.definition)
        self.assertEqual(definition.source_block.resource_id, resource.id)

    @patch.dict(
        "os.environ",
        {
            "A3_WIKI_LLM_API_KEY": "test-key",
            "A3_WIKI_LLM_PROVIDER": "dashscope",
        },
    )
    @patch("backend.apps.knowledge_base.wiki_builder.chat_completion")
    def test_rebuild_resource_wiki_uses_llm_extraction_when_key_is_available(self, chat_completion):
        chat_completion.return_value = {
            "content": """
            {
              "concepts": [
                {
                  "label": "Root Locus",
                  "type": "concept",
                  "definition": "Root Locus is a graphical method for analyzing closed-loop pole movement.",
                  "summary": "A source-grounded concept used in control-system stability analysis.",
                  "aliases": ["RL"],
                  "confidence": 0.94,
                  "evidenceBlockIds": []
                }
              ]
            }
            """,
            "provider": "dashscope",
            "model": "qwen-plus",
        }
        resource, block = self._resource_with_block(
            "llm-wiki.pdf",
            "Root Locus is used to analyze Closed Loop Pole movement.",
        )

        result = rebuild_resource_wiki(resource)

        self.assertEqual(result.status, "ready")
        self.assertIn("LLM", result.reason)
        concept = KnowledgeConcept.objects.get(resource=resource, normalized_label="root locus")
        self.assertEqual(concept.summary, "A source-grounded concept used in control-system stability analysis.")
        definition = KnowledgeDefinition.objects.get(concept=concept)
        self.assertIn("closed-loop pole movement", definition.definition)
        self.assertEqual(definition.source_block_id, block.id)
        self.assertEqual(concept.aliases.get().alias, "RL")

    def test_backfill_knowledge_wiki_command_rebuilds_indexed_history(self):
        resource, _block = self._resource_with_block(
            "history-wiki.pdf",
            "Root Locus is a graphical method for analyzing closed-loop pole movement.",
        )
        draft_resource, _draft_block = self._resource_with_block(
            "draft-wiki.pdf",
            "Draft Term is not ready for Wiki extraction.",
        )
        draft_resource.status = ResourceStatus.UPLOADED
        draft_resource.save(update_fields=["status", "updated_at"])
        output = StringIO()

        call_command("backfill_knowledge_wiki", "--limit", "10", stdout=output)

        self.assertTrue(KnowledgeConcept.objects.filter(resource=resource, normalized_label="root locus").exists())
        self.assertFalse(KnowledgeConcept.objects.filter(resource=draft_resource).exists())
        text = output.getvalue()
        self.assertIn("rebuiltResources: 1", text)
        self.assertIn("skippedResources: 1", text)
        self.assertIn("failedResources: 0", text)

    def _resource_with_block(self, name: str, text: str) -> tuple[KnowledgeResource, KnowledgeBlock]:
        path = Path(self.temp_dir.name) / name
        path.write_text(text, encoding="utf-8")
        resource = KnowledgeResource.objects.create(
            owner=self.teacher,
            original_name=name,
            stored_path=str(path.resolve()),
            file_type=path.suffix,
            file_size=path.stat().st_size,
            resource_scope=ResourceScope.TEACHER,
            status=ResourceStatus.INDEXED,
        )
        page = KnowledgePage.objects.create(resource=resource, page_number=1)
        block = KnowledgeBlock.objects.create(resource=resource, page=page, modality="text", text=text, confidence=0.9)
        return resource, block

    def _evidence(self, resource: KnowledgeResource, block: KnowledgeBlock) -> dict:
        return {
            "resourceId": str(resource.id),
            "resourceTitle": resource.original_name,
            "blockId": str(block.id),
            "location": "第 1 页",
            "snippet": block.text,
            "confidence": block.confidence,
        }
