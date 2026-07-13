from .common import *


from backend.apps.knowledge_base.models import KnowledgeAsset, KnowledgeBlock, KnowledgeGraphClaim, KnowledgeGraphEntity, KnowledgeGraphRelation, KnowledgeIndexEntry, KnowledgePage, ResourceScope, ResourceStatus


class CompatApiTests(CompatApiTestCase):
    @patch("backend.apps.compat.agent_kernel.search_knowledge_base", return_value=[])
    @patch("backend.apps.compat.agent_kernel.classroom_context")
    def test_open_api_qa_refuses_unverified_answer_without_sources(self, classroom_context, _search):
        classroom_context.return_value = {
            "target": {"title": "根轨迹"},
            "sources": [
                {
                    "id": "course-point",
                    "title": "根轨迹基本规则",
                    "location": "第 4 章",
                    "type": "课程知识点",
                    "score": None,
                    "snippet": "根轨迹基本规则",
                }
            ],
        }

        response = self.client.get("/api/v1/qa/interact/?q=什么是根轨迹")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertFalse(payload["verified"])
        self.assertEqual(payload["citations"], [])


    @patch("backend.apps.compat.agent_kernel.generate_tutoring_answer")
    @patch("backend.apps.compat.agent_kernel.search_knowledge_base", return_value=[])
    @patch("backend.apps.compat.agent_kernel.classroom_context")
    def test_open_api_qa_uses_index_origin_classroom_sources(self, classroom_context, _search, generate_tutoring_answer):
        classroom_context.return_value = {
            "target": {"title": "传递函数"},
            "sources": [
                {
                    "id": "source-1",
                    "title": "教学问答数据集.xlsx",
                    "location": "教学问答数据集.xlsx",
                    "type": "问答题库",
                    "sourceTypeLabel": "问答题库",
                    "sourceOrigin": "教师上传索引",
                    "score": None,
                    "snippet": "传递函数是在零初始条件下输出量与输入量的拉氏变换之比。",
                }
            ],
        }
        generate_tutoring_answer.return_value = {
            "answer": "传递函数描述零初始条件下输出与输入的拉氏变换之比。",
            "provider": "rules",
            "model": "",
            "fallback": True,
        }

        response = self.client.get("/api/v1/qa/interact/?q=传递函数是什么")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["verified"])
        self.assertEqual(payload["refusalReason"], "")
        self.assertEqual(payload["citations"][0]["sourceOrigin"], "教师上传索引")


    @patch("backend.apps.compat.agent_kernel.classroom_context")
    def test_open_api_qa_uses_kernel_trace_agents(self, classroom_context):
        classroom_context.return_value = {
            "target": {"title": "Root locus"},
            "sources": [
                {
                    "id": "rag-source",
                    "title": "Root locus note",
                    "location": "chapter 4",
                    "type": "RAG",
                    "score": 0.91,
                    "snippet": "Root locus describes closed-loop pole movement.",
                }
            ],
        }

        with patch(
            "backend.apps.compat.agent_kernel.search_knowledge_base",
            side_effect=AssertionError("qa realtime rag should be gated for interactive classroom answers"),
        ):
            response = self.client.get("/api/v1/qa/interact/?q=what%20is%20root%20locus")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        run = AgentRun.objects.get(trace_id=payload["traceId"])
        step_names = list(run.steps.order_by("order").values_list("name", flat=True))
        self.assertEqual(step_names, ["SafetyAgent", "RetrieverAgent", "TeacherAgent", "VerifierAgent", "FollowUpAgent"])
        retriever_step = run.steps.get(name="RetrieverAgent")
        verifier_step = run.steps.get(name="VerifierAgent")
        self.assertGreater(retriever_step.metadata["runtimePolicy"]["maxRetries"], 0)
        self.assertGreater(verifier_step.metadata["runtimePolicy"]["maxRetries"], 0)
        self.assertEqual(retriever_step.metadata["evidence"]["retrievalMode"], "classroom_context_fast")
        self.assertFalse(retriever_step.metadata["evidence"]["realtimeRagEnabled"])
        self.assertIn("verified", verifier_step.metadata["quality"])

    @patch("backend.apps.compat.agent_kernel.generate_tutoring_answer")
    @patch("backend.apps.compat.agent_kernel.classroom_context")
    def test_teacher_agent_uses_rag_llm_draft_before_verification(self, classroom_context, generate_tutoring_answer):
        classroom_context.return_value = {
            "target": {"title": "Root locus"},
            "sources": [
                {
                    "id": "rag-source",
                    "title": "Root locus note",
                    "location": "chapter 4",
                    "type": "RAG",
                    "score": 0.91,
                    "snippet": "Root locus describes closed-loop pole movement.",
                }
            ],
        }
        generate_tutoring_answer.return_value = {
            "answer": "Root locus describes closed-loop pole movement based on the cited note.",
            "provider": "dashscope",
            "model": "qwen-plus",
            "fallback": False,
        }

        response = self.client.get("/api/v1/qa/interact/?q=what%20is%20root%20locus")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertIn("closed-loop pole movement", payload["answer"])
        self.assertEqual(payload["modelRuntime"]["provider"], "dashscope")
        self.assertEqual(payload["modelRuntime"]["model"], "qwen-plus")
        self.assertFalse(payload["modelRuntime"]["fallback"])
        generate_tutoring_answer.assert_called_once()
        run = AgentRun.objects.get(trace_id=payload["traceId"])
        teacher_step = run.steps.get(name="TeacherAgent")
        verifier_step = run.steps.get(name="VerifierAgent")
        self.assertEqual(teacher_step.metadata["evidence"]["llmProvider"], "dashscope")
        self.assertEqual(teacher_step.metadata["evidence"]["llmModel"], "qwen-plus")
        self.assertFalse(teacher_step.metadata["evidence"]["llmFallback"])
        self.assertTrue(verifier_step.metadata["quality"]["verified"])


    @patch("backend.apps.compat.agent_kernel.generate_tutoring_answer")
    @patch("backend.apps.compat.agent_kernel.classroom_context")
    def test_open_api_qa_retrieves_student_pptx_indexed_blocks(self, classroom_context, generate_tutoring_answer):
        pptx_path = Path(tempfile.gettempdir()) / "a3-classroom-root-locus.pptx"
        pptx_path.write_bytes(b"pptx")
        resource = KnowledgeResource.objects.create(
            owner=self.user,
            original_name="root-locus-upload.pptx",
            stored_path=str(pptx_path),
            file_type=".pptx",
            file_size=pptx_path.stat().st_size,
            resource_scope=ResourceScope.PERSONAL,
            visibility="owner",
            status=ResourceStatus.INDEXED,
        )
        page = KnowledgePage.objects.create(resource=resource, page_number=14, slide_number=14)
        KnowledgeBlock.objects.create(
            resource=resource,
            page=page,
            modality="text",
            text="根轨迹法是一种图解分析方法，用于研究闭环系统特征方程的根随开环增益变化的轨迹。",
            markdown="根轨迹法是一种图解分析方法，用于研究闭环系统特征方程的根随开环增益变化的轨迹。",
            confidence=0.95,
        )
        classroom_context.return_value = {
            "target": {"title": "根轨迹"},
            "sources": [
                {
                    "id": "course-point",
                    "title": "根轨迹",
                    "location": "第 4 章",
                    "type": "课程知识点",
                    "score": None,
                    "snippet": "课程知识点摘要",
                }
            ],
        }
        generate_tutoring_answer.return_value = {
            "answer": "根轨迹法用于分析闭环极点随开环增益变化的轨迹。",
            "provider": "dashscope",
            "model": "qwen-plus",
            "fallback": False,
        }

        response = self.client.get("/api/v1/qa/interact/?q=根轨迹法是什么")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        run = AgentRun.objects.get(trace_id=payload["traceId"])
        retriever_step = run.steps.get(name="RetrieverAgent")
        self.assertEqual(retriever_step.metadata["evidence"]["retrievalMode"], "graph_vector_fusion")
        self.assertIn("block", retriever_step.metadata["evidence"]["fusionComponents"])
        source_titles = [item["title"] for item in generate_tutoring_answer.call_args.kwargs["sources"]]
        self.assertIn("root-locus-upload.pptx", source_titles)

    @patch("backend.apps.compat.agent_kernel.generate_tutoring_answer")
    @patch("backend.apps.compat.agent_kernel.classroom_context")
    def test_open_api_qa_prefers_body_evidence_over_table_of_contents(self, classroom_context, generate_tutoring_answer):
        pdf_path = Path(tempfile.gettempdir()) / "a3-classroom-os-overview.pdf"
        pdf_path.write_bytes(b"pdf")
        resource = KnowledgeResource.objects.create(
            owner=self.user,
            original_name="第1章 操作系统概述.pdf",
            stored_path=str(pdf_path),
            file_type=".pdf",
            file_size=pdf_path.stat().st_size,
            resource_scope=ResourceScope.PERSONAL,
            visibility="owner",
            status=ResourceStatus.INDEXED,
        )
        toc_page = KnowledgePage.objects.create(resource=resource, page_number=5)
        body_page = KnowledgePage.objects.create(resource=resource, page_number=6)
        KnowledgeBlock.objects.create(
            resource=resource,
            page=toc_page,
            modality="text",
            text="第1章 操作系统概述 > 计算机系统概观 > 操作系统的概念 > 操作系统的功能 > 操作系统的发展 > 操作系统的运行环境 > 操作系统的结构",
            markdown="第1章 操作系统概述\n> 计算机系统概观\n> 操作系统的概念\n> 操作系统的功能\n> 操作系统的发展\n> 操作系统的运行环境\n> 操作系统的结构",
            confidence=0.92,
        )
        KnowledgeBlock.objects.create(
            resource=resource,
            page=body_page,
            modality="text",
            text="什么是操作系统？操作系统是控制和管理计算机硬件与软件资源、组织程序运行并为用户和应用程序提供接口的系统软件。它包括处理器管理、存储管理、设备管理和文件管理等功能。",
            markdown="什么是操作系统？操作系统是控制和管理计算机硬件与软件资源、组织程序运行并为用户和应用程序提供接口的系统软件。它包括处理器管理、存储管理、设备管理和文件管理等功能。",
            confidence=0.96,
        )
        classroom_context.return_value = {"target": {"title": "操作系统功能与结构"}, "sources": []}
        generate_tutoring_answer.return_value = {
            "answer": "操作系统是控制和管理计算机资源的系统软件。",
            "provider": "dashscope",
            "model": "qwen-plus",
            "fallback": False,
        }

        response = self.client.get("/api/v1/qa/interact/?q=什么是操作系统&mode=deep&scope=personal")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        sources = generate_tutoring_answer.call_args.kwargs["sources"]
        self.assertGreaterEqual(len(sources), 1)
        self.assertIn("控制和管理计算机硬件与软件资源", sources[0]["snippet"])
        self.assertIn("page 6", sources[0]["location"])
        self.assertNotIn("操作系统的发展 > 操作系统的运行环境", sources[0]["snippet"])

    @patch("backend.apps.compat.agent_kernel.generate_tutoring_answer")
    @patch("backend.apps.compat.agent_kernel.classroom_context")
    def test_open_api_qa_uses_graph_and_index_fusion_sources(self, classroom_context, generate_tutoring_answer):
        pdf_path = Path(tempfile.gettempdir()) / "a3-classroom-os-graph-fusion.pdf"
        pdf_path.write_bytes(b"pdf")
        resource = KnowledgeResource.objects.create(
            owner=self.user,
            original_name="操作系统图谱融合.pdf",
            stored_path=str(pdf_path),
            file_type=".pdf",
            file_size=pdf_path.stat().st_size,
            resource_scope=ResourceScope.PERSONAL,
            visibility="owner",
            status=ResourceStatus.INDEXED,
        )
        page = KnowledgePage.objects.create(resource=resource, page_number=8)
        block = KnowledgeBlock.objects.create(
            resource=resource,
            page=page,
            modality="text",
            text="进程管理负责进程创建、调度、同步、通信和终止，是操作系统资源管理的核心内容。",
            markdown="进程管理负责进程创建、调度、同步、通信和终止，是操作系统资源管理的核心内容。",
            confidence=0.97,
        )
        KnowledgeIndexEntry.objects.create(block=block, index_type="text_vector", index_backend="faiss", status="indexed")
        KnowledgeIndexEntry.objects.create(block=block, index_type="lexical", index_backend="bm25", status="indexed")
        process = KnowledgeGraphEntity.objects.create(
            owner=self.user,
            resource=resource,
            label="进程管理",
            normalized_label="进程管理",
            entity_type="concept",
            summary="管理进程的创建、调度、同步、通信和终止。",
            confidence=0.91,
            source_count=1,
            source_locations=[{"page": 8}],
            degraded=False,
        )
        scheduling = KnowledgeGraphEntity.objects.create(
            owner=self.user,
            resource=resource,
            label="进程调度",
            normalized_label="进程调度",
            entity_type="concept",
            summary="决定就绪进程获得处理机的次序。",
            confidence=0.9,
            source_count=1,
            source_locations=[{"page": 8}],
            degraded=False,
        )
        KnowledgeGraphRelation.objects.create(
            owner=self.user,
            resource=resource,
            source_entity=process,
            target_entity=scheduling,
            relation_type="includes",
            label="包含",
            weight=0.8,
            evidence=[{"text": "进程管理包括调度。", "page": 8}],
            degraded=False,
        )
        KnowledgeGraphClaim.objects.create(
            owner=self.user,
            resource=resource,
            text="进程管理包括进程创建、调度、同步、通信和终止。",
            entity_ids=[str(process.id), str(scheduling.id)],
            verified=True,
            evidence=[{"text": "进程管理负责进程创建、调度、同步、通信和终止。", "page": 8}],
            degraded=False,
        )
        classroom_context.return_value = {"target": {"title": "操作系统进程管理"}, "sources": []}
        generate_tutoring_answer.return_value = {
            "answer": "进程管理包括创建、调度、同步、通信和终止。",
            "provider": "dashscope",
            "model": "qwen-plus",
            "fallback": False,
        }

        response = self.client.get("/api/v1/qa/interact/?q=进程管理包括哪些内容&mode=deep&scope=personal")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        sources = generate_tutoring_answer.call_args.kwargs["sources"]
        self.assertTrue(any(source.get("retriever") == "graph" for source in sources))
        self.assertTrue(any("text_vector" in source.get("indexTypes", []) for source in sources))
        run = AgentRun.objects.get(trace_id=payload["traceId"])
        evidence = run.steps.get(name="RetrieverAgent").metadata["evidence"]
        self.assertEqual(evidence["retrievalMode"], "graph_vector_fusion")
        self.assertIn("graph", evidence["fusionComponents"])
        self.assertIn("block", evidence["fusionComponents"])

    @patch("backend.apps.compat.agent_kernel.generate_tutoring_answer")
    @patch("backend.apps.compat.agent_kernel.classroom_context")
    def test_open_api_qa_deep_mode_limits_retrieval_to_personal_pptx(self, classroom_context, generate_tutoring_answer):
        personal_path = Path(tempfile.gettempdir()) / "a3-classroom-personal-root-locus.pptx"
        teacher_path = Path(tempfile.gettempdir()) / "a3-classroom-teacher-root-locus.pptx"
        personal_path.write_bytes(b"pptx-personal")
        teacher_path.write_bytes(b"pptx-teacher")
        personal_resource = KnowledgeResource.objects.create(
            owner=self.user,
            original_name="personal-root-locus.pptx",
            stored_path=str(personal_path),
            file_type=".pptx",
            file_size=personal_path.stat().st_size,
            resource_scope=ResourceScope.PERSONAL,
            visibility="owner",
            status=ResourceStatus.INDEXED,
        )
        teacher_resource = KnowledgeResource.objects.create(
            owner=self.user,
            original_name="teacher-root-locus.pptx",
            stored_path=str(teacher_path),
            file_type=".pptx",
            file_size=teacher_path.stat().st_size,
            resource_scope=ResourceScope.TEACHER,
            visibility="teacher",
            status=ResourceStatus.INDEXED,
        )
        personal_page = KnowledgePage.objects.create(resource=personal_resource, page_number=3, slide_number=3)
        teacher_page = KnowledgePage.objects.create(resource=teacher_resource, page_number=4, slide_number=4)
        personal_asset = KnowledgeAsset.objects.create(
            resource=personal_resource,
            page=personal_page,
            kind="rendered_slide",
            storage_path=str(personal_path),
            mime_type="image/png",
        )
        KnowledgeBlock.objects.create(
            resource=personal_resource,
            page=personal_page,
            asset=personal_asset,
            modality="text",
            text="根轨迹深度检索应优先使用学生自己上传的 PPTX 证据。",
            markdown="根轨迹深度检索应优先使用学生自己上传的 PPTX 证据。",
            confidence=0.95,
        )
        KnowledgeBlock.objects.create(
            resource=teacher_resource,
            page=teacher_page,
            modality="text",
            text="根轨迹深度检索不应在个人资料范围内返回教师资料。",
            markdown="根轨迹深度检索不应在个人资料范围内返回教师资料。",
            confidence=0.95,
        )
        classroom_context.return_value = {"target": {"title": "根轨迹"}, "sources": []}
        generate_tutoring_answer.return_value = {
            "answer": "根轨迹深度检索使用了学生个人 PPTX 证据。",
            "provider": "dashscope",
            "model": "qwen-plus",
            "fallback": False,
        }

        response = self.client.get("/api/v1/qa/interact/?q=根轨迹深度检索&mode=deep&scope=personal")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["retrievalMode"], "graph_vector_fusion")
        run = AgentRun.objects.get(trace_id=payload["traceId"])
        evidence = run.steps.get(name="RetrieverAgent").metadata["evidence"]
        self.assertEqual(evidence["retrievalMode"], "graph_vector_fusion")
        self.assertEqual(evidence["reasoningMode"], "deep")
        self.assertEqual(evidence["requestedScope"], "personal")
        self.assertIn("block", evidence["fusionComponents"])
        source_titles = [item["title"] for item in generate_tutoring_answer.call_args.kwargs["sources"]]
        self.assertIn("personal-root-locus.pptx", source_titles)
        self.assertNotIn("teacher-root-locus.pptx", source_titles)
        personal_source = next(item for item in generate_tutoring_answer.call_args.kwargs["sources"] if item["title"] == "personal-root-locus.pptx")
        self.assertEqual(personal_source["previewUrl"], f"/api/kb/assets/{personal_asset.id}/preview/")
        self.assertEqual(personal_source["asset"]["kind"], "rendered_slide")


    def test_agent_kernel_fails_when_verify_answer_claim_contract_type_is_wrong(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, AgentResult, BaseAgent

        class WrongVerifyAnswerAgent(BaseAgent):
            name = "WrongVerifyAnswerAgent"

            def run(self, context):
                return AgentResult(output={
                    "verified": True,
                    "citations": [{"title": "Root locus source", "score": "high"}],
                    "claims": [{"text": 123, "verified": "yes"}],
                    "safety": {"safe": "yes", "category": 3},
                })

        kernel = AgentKernel()
        kernel.register(WrongVerifyAnswerAgent())

        result = kernel.run(
            AgentContext(user=self.user, workflow="verify_answer", goal="verify contract", payload={}),
            ["WrongVerifyAnswerAgent"],
        )

        self.assertFalse(result.success)
        self.assertEqual(result.trace["fallbackStrategy"], "contract_violation")
        self.assertIn("citations[0].score expected number", result.output["error"])
        self.assertIn("claims[0].text expected string", result.output["error"])
        self.assertIn("claims[0].verified expected boolean", result.output["error"])
        self.assertIn("safety.safe expected boolean", result.output["error"])
        self.assertIn("safety.category expected string", result.output["error"])
        self.assertEqual(result.trace["steps"][-1]["name"], "ContractAgent")


    def test_agent_kernel_preserves_runtime_error_for_callers(self):
        from backend.apps.compat.agent_kernel import AgentContext, AgentKernel, BaseAgent

        class FailingAgent(BaseAgent):
            name = "FailingAgent"

            def run(self, context):
                raise TimeoutError("ResourceSynthesisAgent exceeded 5000ms")

        kernel = AgentKernel()
        kernel.register(FailingAgent())

        result = kernel.run(
            AgentContext(user=self.user, workflow="resource_generate", goal="video script", payload={}),
            ["FailingAgent"],
        )

        self.assertFalse(result.success)
        self.assertIn("ResourceSynthesisAgent exceeded 5000ms", result.output["error"])
        self.assertEqual(result.trace["status"], "failed")


    def test_verify_answer_workflow_contract_matches_kernel_agent_sequence(self):
        from backend.apps.compat.agent_kernel import VERIFY_ANSWER_WORKFLOW_SEQUENCE
        from backend.apps.compat.agent_workflows import get_agent_workflow_contract

        contract = get_agent_workflow_contract("verify_answer")

        self.assertEqual(tuple(VERIFY_ANSWER_WORKFLOW_SEQUENCE), contract.required_steps)


    def test_agent_runtime_step_promotes_safety_and_contract_metadata(self):
        run = RuntimeAgentRun(self.user, "verify_answer", "standardized safety and contract")
        run.step(
            "VerifierAgent",
            "citation verification",
            "verify claims with citations",
            evidence={"citations": 1},
            quality={
                "verified": True,
                "safe": True,
                "safety": {"safe": True, "category": "education"},
                "contract": {"schemaVersion": "a3.verify-answer.v1", "satisfied": True},
            },
        )
        run.complete()

        step = AgentStep.objects.get(run__trace_id=run.trace_id)
        self.assertEqual(step.metadata["a3EvidenceSchemaVersion"], "a3.agent-step-evidence.v1")
        self.assertEqual(step.metadata["safety"]["category"], "education")
        self.assertEqual(step.metadata["contract"]["schemaVersion"], "a3.verify-answer.v1")
        self.assertNotIn("safety", step.metadata["quality"])
        self.assertNotIn("contract", step.metadata["quality"])


    def test_verify_answer_trace_standardizes_safety_and_verifier_evidence(self):
        response = self.client.post(
            "/api/verify/answer/",
            data=json.dumps({
                "question": "root locus",
                "answer": "Root locus describes how closed-loop poles move as a parameter changes.",
                "sources": [{
                    "title": "root-locus.pdf",
                    "type": "RAG",
                    "score": 0.9,
                    "snippet": "Root locus describes closed-loop poles moving as a parameter changes.",
                }],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        steps = {step.name: step for step in run.steps.all()}

        safety_metadata = steps["SafetyAgent"].metadata
        verifier_metadata = steps["VerifierAgent"].metadata
        self.assertEqual(safety_metadata["safety"]["category"], "learning")
        self.assertEqual(safety_metadata["safety"]["decision"], "allow")
        self.assertEqual(safety_metadata["evidence"]["policy"], "learning_safety_rules")
        self.assertEqual(verifier_metadata["evidence"]["sourceCount"], 1)
        self.assertGreaterEqual(verifier_metadata["evidence"]["claimCount"], 1)
        self.assertIn("citationCount", verifier_metadata["evidence"])
        self.assertEqual(verifier_metadata["safety"]["category"], "learning")
        self.assertEqual(verifier_metadata["contract"]["schemaVersion"], "a3.verify-answer.v1")
        self.assertTrue(verifier_metadata["contract"]["satisfied"])


    def test_verify_workflow_persists_safety_and_evidence_metadata(self):
        response = self.client.post(
            "/api/verify/answer/",
            data=json.dumps({
                "question": "root locus",
                "answer": "Root locus describes how closed-loop poles move as a parameter changes.",
                "sources": [{
                    "title": "teacher-root-locus.xlsx",
                    "type": "RAG",
                    "score": 0.82,
                    "location": "data/uploads/teacher-root-locus.xlsx",
                    "snippet": "Root locus describes closed-loop poles moving as a parameter changes.",
                }],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        steps = {step.name: step for step in run.steps.all()}

        safety_metadata = steps["SafetyAgent"].metadata
        verifier_metadata = steps["VerifierAgent"].metadata
        self.assertEqual(safety_metadata["inputSummary"]["sources"], 1)
        self.assertTrue(safety_metadata["outputSummary"]["safe"])
        self.assertEqual(verifier_metadata["inputSummary"]["sources"], 1)
        self.assertTrue(verifier_metadata["outputSummary"]["verified"])
        self.assertEqual(verifier_metadata["evidence"]["sourceCount"], 1)
        self.assertIn("claimSupportRate", verifier_metadata["quality"])


    def test_verify_answer_uses_kernel_trace_agents(self):
        response = self.client.post(
            "/api/verify/answer/",
            data=json.dumps({
                "question": "root locus",
                "answer": "Root locus describes how closed-loop poles move as a parameter changes.",
                "sources": [{
                    "title": "teacher-root-locus.xlsx",
                    "type": "RAG",
                    "score": 0.82,
                    "location": "data/uploads/teacher-root-locus.xlsx",
                    "snippet": "Root locus describes closed-loop poles moving as a parameter changes.",
                }],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertIn("verified", payload)
        self.assertIn("citations", payload)
        self.assertIn("claims", payload)
        self.assertIn("safety", payload)
        run = AgentRun.objects.prefetch_related("steps").get(trace_id=payload["traceId"])
        step_names = [step.name for step in run.steps.all()]
        self.assertEqual(step_names, ["SafetyAgent", "ClaimExtractorAgent", "VerifierAgent"])


    def test_verify_answer_requires_grounding_evidence(self):
        response = self.client.post(
            "/api/verify/answer/",
            data=json.dumps({
                "question": "根轨迹是什么？",
                "answer": "根轨迹描述闭环极点随参数变化的轨迹。",
                "sources": [{"title": "课程知识点", "type": "课程知识点", "score": None}],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertFalse(payload["verified"])
        self.assertEqual(payload["refusalReason"], "missing_evidence")


    def test_verify_answer_accepts_scored_evidence(self):
        response = self.client.post(
            "/api/verify/answer/",
            data=json.dumps({
                "question": "根轨迹是什么？",
                "answer": "根轨迹描述闭环极点随参数变化的轨迹。",
                "sources": [{"title": "教学问答数据集", "type": "RAG", "score": 0.82, "snippet": "根轨迹描述闭环极点随参数变化。"}],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["verified"])
        self.assertEqual(len(payload["citations"]), 1)
        self.assertGreaterEqual(len(payload["claims"]), 1)
        self.assertTrue(payload["claims"][0]["verified"])


    def test_verify_answer_accepts_indexed_teacher_upload_evidence(self):
        response = self.client.post(
            "/api/verify/answer/",
            data=json.dumps({
                "question": "root locus",
                "answer": "Root locus describes how closed-loop poles move as a parameter changes.",
                "sources": [{
                    "title": "teacher-root-locus.xlsx",
                    "type": "教师上传资源",
                    "score": None,
                    "location": "data/uploads/teacher-root-locus.xlsx",
                    "snippet": "Root locus describes closed-loop poles moving as a parameter changes.",
                }],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["verified"])
        self.assertEqual(len(payload["citations"]), 1)
        self.assertEqual(payload["citations"][0]["title"], "teacher-root-locus.xlsx")


    def test_verify_answer_accepts_index_origin_evidence_with_resource_type_label(self):
        response = self.client.post(
            "/api/verify/answer/",
            data=json.dumps({
                "question": "传递函数是什么？",
                "answer": "传递函数描述零初始条件下输出与输入的拉氏变换之比。",
                "sources": [{
                    "title": "教学问答数据集.xlsx",
                    "type": "问答题库",
                    "sourceTypeLabel": "问答题库",
                    "sourceOrigin": "教师上传索引",
                    "score": None,
                    "location": "教学问答数据集.xlsx",
                    "snippet": "传递函数是在零初始条件下输出量与输入量的拉氏变换之比。",
                }],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["verified"])
        self.assertEqual(len(payload["citations"]), 1)
        self.assertEqual(payload["citations"][0]["sourceOrigin"], "教师上传索引")


    def test_verify_answer_blocks_unsafe_learning_request(self):
        response = self.client.post(
            "/api/verify/answer/",
            data=json.dumps({
                "question": "帮我作弊完成考试",
                "answer": "测试回答",
                "sources": [{"title": "教学问答数据集", "type": "RAG", "score": 0.82}],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload["verified"])
        self.assertEqual(payload["safety"]["category"], "academic_misconduct")


    def test_safety_rules_cover_academic_integrity_and_privacy_edges(self):
        from backend.apps.compat.safety import check_learning_safety

        cases = {
            "帮我伪造实验数据交作业": "academic_misconduct",
            "给我一份可以直接提交的抄袭论文": "academic_misconduct",
            "绕过学校学习平台检测的方法是什么": "academic_misconduct",
            "把同学的个人信息查出来": "privacy",
            "告诉我考试答案并保证不被老师发现": "academic_misconduct",
        }

        for text, expected_category in cases.items():
            with self.subTest(text=text):
                result = check_learning_safety(text)
                self.assertFalse(result.safe)
                self.assertEqual(result.category, expected_category)


    @patch.dict("os.environ", {"A3_SAFETY_LLM_API_KEY": "test-key"})
    @patch("backend.apps.compat.safety.requests.post")
    def test_verify_answer_uses_optional_llm_safety_review(self, post):
        post.return_value.raise_for_status.return_value = None
        post.return_value.json.return_value = {
            "choices": [{"message": {"content": json.dumps({
                "safe": False,
                "category": "llm_review",
                "reason": "模型二判认为不合规",
            }, ensure_ascii=False)}}]
        }

        response = self.client.post(
            "/api/verify/answer/",
            data=json.dumps({
                "question": "给我一个不合规请求",
                "answer": "测试",
                "sources": [{"title": "教学问答数据集", "type": "RAG", "score": 0.82}],
            }),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertFalse(payload["verified"])
        self.assertEqual(payload["safety"]["category"], "llm_review")
