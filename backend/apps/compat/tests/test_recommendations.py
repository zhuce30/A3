from .common import *


class CompatApiTests(CompatApiTestCase):
    def test_recommend_alias_returns_recommendations_and_sources(self):
        response = self.client.post("/api/recommend/", data="{}", content_type="application/json")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertIn("recommendations", payload)
        self.assertIn("sources", payload)
        self.assertIn("rationale", payload)
        self.assertGreater(len(payload["recommendations"]), 0)
        first = payload["recommendations"][0]
        self.assertIn("score", first)
        self.assertIn("reason", first)
        self.assertIn("type", first)
        self.assertIn("evidence", first)
        self.assertIn("profileMatch", first["evidence"])
        self.assertIn("rankingBasis", first["evidence"])
        self.assertIn("sourceEvidence", first["evidence"])
        self.assertIn("fallback", first["evidence"])
        self.assertIn("weights", payload["rationale"])
        self.assertEqual(payload["rationale"]["retrievalMode"], "fast")


    def test_recommend_alias_includes_resource_effect_attribution_evidence(self):
        from backend.apps.learning.effect_events import record_learning_event

        course = Course.objects.create(code="REC-ATTR", title="Recommendation Attribution")
        chapter = Chapter.objects.create(course=course, order=1, title="Basics")
        point = KnowledgePoint.objects.create(
            chapter=chapter,
            code="REC-ATTR-KP",
            order=1,
            title="Memory paging",
            difficulty=2,
            estimated_minutes=30,
        )
        question = Question.objects.create(
            knowledge_point=point,
            stem="Paging question",
            options=[{"key": "A", "text": "A"}, {"key": "B", "text": "B"}],
            correct_answer="A",
            explanation="A",
        )
        WrongQuestion.objects.create(user=self.user, question=question, wrong_count=2, mastered=False)
        for event_type in ("resource_opened", "resource_completed", "resource_favorited"):
            record_learning_event(
                self.user,
                event_type=event_type,
                target_type="resource_pack",
                target_id="pack-attribution",
                knowledge_point_id=str(point.id),
                resource_type="practice_set",
                score=90 if event_type == "resource_completed" else None,
            )
        record_learning_event(
            self.user,
            event_type="question_answered",
            target_type="assessment_question",
            target_id="q-after",
            knowledge_point_id=str(point.id),
            score=100,
        )

        response = self.client.post("/api/recommend/", data=json.dumps({"topK": 5}), content_type="application/json")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        practice = next(item for item in payload["recommendations"] if item["href"] == "/a3/wrong-notebook")
        self.assertIn("resourceEffect", practice["evidence"])
        effect = practice["evidence"]["resourceEffect"]
        self.assertEqual(effect["resourceType"], "practice_set")
        self.assertIn(effect["effectConfidence"], {"medium", "high"})
        ranking = practice["evidence"]["rankingBasis"]
        self.assertTrue(any(item["label"] == "历史有效性" for item in ranking))
        self.assertTrue(any(item["label"] == "探索推荐" for item in ranking))
        self.assertTrue(any(item["label"] == "证据置信度" for item in ranking))
        self.assertIn("历史有效性", practice["reason"])
        self.assertIn("resourceEffectAttribution", payload["rationale"])


    def test_recommend_alias_exposes_profile_inputs_used_for_ranking(self):
        LearnerProfile.objects.update_or_create(
            user=self.user,
            defaults={
                "foundation_level": "基础薄弱",
                "daily_study_time": 35,
                "learning_goals": ["补齐自动控制基础"],
                "weak_points": ["根轨迹基本规则", "频率响应"],
                "expected_resources": ["练习题库"],
            },
        )

        response = self.client.post("/api/recommend/", data="{}", content_type="application/json")

        self.assertEqual(response.status_code, 200)
        profile_inputs = response.json()["rationale"]["profileInputs"]
        self.assertEqual(profile_inputs["snapshotSchemaVersion"], "a3.profile-snapshot.v1")
        self.assertIn("readiness", profile_inputs)
        self.assertIn("evidenceSources", profile_inputs)
        self.assertEqual(profile_inputs["dailyMinutes"], 35)
        self.assertEqual(profile_inputs["learningGoals"], ["补齐自动控制基础"])
        self.assertEqual(profile_inputs["weakPoints"], ["根轨迹基本规则", "频率响应"])
        self.assertEqual(profile_inputs["expectedResources"], ["练习题库"])


    def test_recommend_alias_adapts_path_recommendation_to_foundation_and_daily_time(self):
        course = Course.objects.create(code="REC-FOUNDATION-PACE", title="推荐基础与节奏测试课")
        chapter = Chapter.objects.create(course=course, order=1, title="基础节奏章节")
        point = KnowledgePoint.objects.create(
            chapter=chapter,
            code="REC-FOUNDATION-PACE-A",
            order=1,
            title="传递函数基础",
            difficulty=2,
            estimated_minutes=45,
        )
        LearnerProfile.objects.update_or_create(
            user=self.user,
            defaults={
                "foundation_level": "基础较弱",
                "daily_study_time": 20,
                "learning_goals": ["补齐自动控制基础"],
                "weak_points": [],
                "expected_resources": ["知识卡片"],
            },
        )
        path = LearningPath.objects.create(user=self.user, course=course, title="基础节奏个性化路径")
        LearningPathItem.objects.create(
            path=path,
            knowledge_point=point,
            order=1,
            status="current",
            estimated_minutes=point.estimated_minutes,
        )

        response = self.client.post("/api/recommend/", data="{}", content_type="application/json")

        self.assertEqual(response.status_code, 200)
        first = response.json()["recommendations"][0]
        self.assertIn("低负荷", first["reason"])
        self.assertEqual(first["href"], "/a3/classroom")
        ranking = first["evidence"]["rankingBasis"]
        self.assertIn({"label": "基础水平适配", "value": "基础较弱"}, ranking)
        self.assertIn({"label": "每日时间适配", "value": "20 分钟"}, ranking)
        self.assertTrue(first["evidence"]["profileMatch"]["matched"])
        self.assertIn("foundationPace", first["evidence"]["profileMatch"]["signals"])


    def test_recommend_alias_returns_executable_resource_pack(self):
        response = self.client.post(
            "/api/recommend/",
            data=json.dumps({"goal": "root locus", "topK": 3}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("resourcePack", payload)
        pack = payload["resourcePack"]
        self.assertEqual(pack["schemaVersion"], "a3.resource-pack.v1")
        self.assertIn("title", pack)
        self.assertIn("learningGoal", pack)
        self.assertIn("estimatedMinutes", pack)
        self.assertIn("resources", pack)
        self.assertIn("practice", pack)
        self.assertIn("reviewQueue", pack)
        self.assertIn("evidence", pack)
        self.assertIn("nextAction", pack)
        self.assertGreater(len(pack["resources"]), 0)
        self.assertGreaterEqual(pack["estimatedMinutes"], 10)
        first_resource = pack["resources"][0]
        self.assertIn("recommendationId", first_resource)
        self.assertIn("title", first_resource)
        self.assertIn("reason", first_resource)
        self.assertIn("source", first_resource)
        self.assertIn("action", first_resource)
        self.assertTrue(pack["practice"]["href"].startswith("/a3/assessment?practice="))
        self.assertIn("verifiedSourceCount", pack["evidence"])
        self.assertIn("confidence", pack["evidence"])
        self.assertIn(pack["nextAction"]["href"], {"/a3/classroom", "/a3/assessment", "/a3/wrong-notebook", "/a3/learning-path"})


    def test_path_recommendation_resource_action_enters_classroom(self):
        course = Course.objects.create(code="REC-CLASSROOM-ACTION", title="Recommendation Classroom Action")
        chapter = Chapter.objects.create(course=course, order=1, title="Chapter")
        point = KnowledgePoint.objects.create(
            chapter=chapter,
            code="REC-CLASSROOM-ACTION-KP",
            order=1,
            title="Root locus entry",
            difficulty=2,
            estimated_minutes=30,
        )
        LearningPath.objects.filter(user=self.user).delete()
        path = LearningPath.objects.create(user=self.user, course=course, title="Action Path")
        LearningPathItem.objects.create(
            path=path,
            knowledge_point=point,
            order=1,
            status="current",
            estimated_minutes=point.estimated_minutes,
        )

        response = self.client.post(
            "/api/recommend/",
            data=json.dumps({"goal": "Root locus entry", "topK": 5}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        path_item = next(item for item in payload["recommendations"] if item["title"] == "Root locus entry 专项学习包")
        resource = next(item for item in payload["resourcePack"]["resources"] if item["recommendationId"] == path_item["id"])
        self.assertEqual(path_item["href"], "/a3/classroom")
        self.assertEqual(resource["action"]["href"], "/a3/classroom")


    def test_recommend_resource_pack_practice_href_targets_goal(self):
        response = self.client.post(
            "/api/recommend/",
            data=json.dumps({"goal": "root locus", "topK": 3}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        pack = response.json()["resourcePack"]
        self.assertEqual(pack["practice"]["href"], "/a3/assessment?practice=root%20locus")


    def test_recommend_alias_user_facing_copy_is_readable_chinese(self):
        response = self.client.post("/api/recommend/", data="{}", content_type="application/json")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        assert_payload_has_no_mojibake(self, {
            "query": payload["query"],
            "profileSignals": payload["profileSignals"],
            "recommendations": payload["recommendations"],
            "sources": payload["sources"],
            "rationale": payload["rationale"],
        })


    @patch("backend.apps.compat.recommendations.search_knowledge_base")
    def test_recommend_alias_deep_mode_uses_vector_retrieval_without_changing_default(self, search):
        from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult

        search.return_value = [
            KnowledgeBaseSearchResult(
                score=0.88,
                text="深度检索命中的根轨迹知识库片段",
                metadata={"title": "深度检索资料", "resource_type": "document"},
            )
        ]

        response = self.client.post(
            "/api/recommend/",
            data=json.dumps({"mode": "deep", "topK": 3}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["rationale"]["retrievalMode"], "deep")
        self.assertFalse(payload["rationale"]["fallbackUsed"])
        self.assertEqual(payload["sources"][0]["title"], "深度检索资料")
        search.assert_called_once()


    @patch("backend.apps.compat.recommendations.search_knowledge_base")
    def test_recommend_alias_resource_preference_reranks_equal_sources(self, search):
        from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult

        LearnerProfile.objects.update_or_create(
            user=self.user,
            defaults={
                "foundation_level": "基础较弱",
                "daily_study_time": 45,
                "learning_goals": ["补齐自动控制基础"],
                "weak_points": ["根轨迹基本规则"],
                "expected_resources": ["练习题库"],
            },
        )
        search.return_value = [
            KnowledgeBaseSearchResult(
                score=0.5,
                text="Root locus lecture note.",
                metadata={"title": "root locus lecture", "resource_type": "document"},
            ),
            KnowledgeBaseSearchResult(
                score=0.5,
                text="Root locus practice question.",
                metadata={"title": "root locus practice", "resource_type": "question"},
            ),
        ]

        response = self.client.post(
            "/api/recommend/",
            data=json.dumps({"mode": "deep", "goal": "根轨迹", "topK": 2}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        recommendations = response.json()["recommendations"]
        self.assertIn("root locus practice", recommendations[0]["title"])
        self.assertGreater(recommendations[0]["score"], recommendations[1]["score"])

    @patch("backend.apps.compat.recommendations.search_knowledge_base")
    def test_resource_feedback_adjusts_future_recommendation_ranking(self, search):
        from backend.domains.knowledge_base.schemas import KnowledgeBaseSearchResult

        profile, _ = LearnerProfile.objects.update_or_create(
            user=self.user,
            defaults={
                "foundation_level": "基础一般",
                "daily_study_time": 45,
                "learning_goals": ["巩固根轨迹"],
                "weak_points": ["根轨迹基本规则"],
                "expected_resources": ["练习题库"],
                "extra_profile": {
                    "resourceFeedback": [
                        {"action": "skipped", "resourceType": "practice_set", "score": 30},
                    ],
                },
            },
        )
        search.return_value = [
            KnowledgeBaseSearchResult(
                score=0.5,
                text="Root locus lecture note.",
                metadata={"title": "root locus lecture", "resource_type": "document"},
            ),
            KnowledgeBaseSearchResult(
                score=0.5,
                text="Root locus practice question.",
                metadata={"title": "root locus practice", "resource_type": "question"},
            ),
        ]

        skipped_response = self.client.post(
            "/api/recommend/",
            data=json.dumps({"mode": "deep", "goal": "根轨迹", "topK": 8}),
            content_type="application/json",
        )

        self.assertEqual(skipped_response.status_code, 200)
        skipped_recommendations = skipped_response.json()["recommendations"]
        lecture_after_skip = next(item for item in skipped_recommendations if "lecture" in item["title"])
        practice_after_skip = next(item for item in skipped_recommendations if "practice" in item["title"])
        self.assertGreater(lecture_after_skip["score"], practice_after_skip["score"])
        skip_basis = practice_after_skip["evidence"]["rankingBasis"]
        self.assertIn({"label": "资源反馈调权", "value": "skipped:-8"}, skip_basis)

        profile.extra_profile = {
            "resourceFeedback": [
                {"action": "completed", "resourceType": "practice_set", "score": 92},
            ],
        }
        profile.save(update_fields=["extra_profile", "updated_at"])

        completed_response = self.client.post(
            "/api/recommend/",
            data=json.dumps({"mode": "deep", "goal": "根轨迹", "topK": 8}),
            content_type="application/json",
        )

        self.assertEqual(completed_response.status_code, 200)
        completed_recommendations = completed_response.json()["recommendations"]
        lecture_after_complete = next(item for item in completed_recommendations if "lecture" in item["title"])
        practice_after_complete = next(item for item in completed_recommendations if "practice" in item["title"])
        self.assertGreater(practice_after_complete["score"], lecture_after_complete["score"])
        completed_basis = practice_after_complete["evidence"]["rankingBasis"]
        self.assertIn({"label": "资源反馈调权", "value": "completed:+8"}, completed_basis)


    def test_recommend_alias_reorders_path_items_and_explains_weak_point_match(self):
        course = Course.objects.create(code="REC-PERSONALIZATION", title="推荐个性化测试课")
        chapter = Chapter.objects.create(course=course, order=1, title="个性化章节")
        points = [
            KnowledgePoint.objects.create(
                chapter=chapter,
                code="REC-PERSONALIZATION-A",
                order=1,
                title="根轨迹基本规则",
                difficulty=2,
                estimated_minutes=25,
            ),
            KnowledgePoint.objects.create(
                chapter=chapter,
                code="REC-PERSONALIZATION-B",
                order=2,
                title="频率响应与伯德图",
                difficulty=3,
                estimated_minutes=35,
            ),
        ]

        other_user = User.objects.create_user(phone="13800139901", password="secure-pass-123")
        LearnerProfile.objects.update_or_create(
            user=self.user,
            defaults={
                "foundation_level": "基础较弱",
                "daily_study_time": 30,
                "learning_goals": ["补齐自动控制基础"],
                "weak_points": [points[0].title],
                "expected_resources": ["练习题库"],
            },
        )
        LearnerProfile.objects.update_or_create(
            user=other_user,
            defaults={
                "foundation_level": "基础较弱",
                "daily_study_time": 30,
                "learning_goals": ["补齐自动控制基础"],
                "weak_points": [points[1].title],
                "expected_resources": ["练习题库"],
            },
        )
        for user in (self.user, other_user):
            path = LearningPath.objects.create(user=user, course=course, title=f"{user.phone} 个性化路径")
            for index, point in enumerate(points, start=1):
                LearningPathItem.objects.create(
                    path=path,
                    knowledge_point=point,
                    order=index,
                    status="current" if index == 1 else "locked",
                    estimated_minutes=point.estimated_minutes,
                )

        first_response = self.client.post("/api/recommend/", data="{}", content_type="application/json")
        self.client.force_login(other_user)
        second_response = self.client.post("/api/recommend/", data="{}", content_type="application/json")

        self.assertEqual(first_response.status_code, 200)
        self.assertEqual(second_response.status_code, 200)
        first_payload = first_response.json()
        second_payload = second_response.json()
        first_top = first_payload["recommendations"][0]
        second_top = second_payload["recommendations"][0]

        self.assertIn(points[0].title, first_top["title"])
        self.assertIn(points[1].title, second_top["title"])
        self.assertNotEqual(first_top["title"], second_top["title"])
        self.assertIn("薄弱点匹配", first_top["reason"])
        self.assertIn(points[0].title, first_top["reason"])
        self.assertIn("薄弱点匹配", second_top["reason"])
        self.assertIn(points[1].title, second_top["reason"])

        self.assertEqual(first_payload["rationale"]["profileInputs"]["weakPoints"], [points[0].title])
        self.assertEqual(second_payload["rationale"]["profileInputs"]["weakPoints"], [points[1].title])
        self.assertIn(first_payload["rationale"]["profileInputs"]["weakPoints"][0], first_top["title"])
        self.assertIn(second_payload["rationale"]["profileInputs"]["weakPoints"][0], second_top["title"])


    def test_assessment_wrong_point_immediately_reranks_recommendations(self):
        course = Course.objects.create(code="REC-ASSESSMENT-LOOP", title="推荐测评闭环测试课")
        chapter = Chapter.objects.create(course=course, order=1, title="测评闭环章节")
        first_point = KnowledgePoint.objects.create(
            chapter=chapter,
            code="REC-ASSESSMENT-A",
            order=1,
            title="传递函数基础",
            difficulty=1,
            estimated_minutes=20,
        )
        weak_point = KnowledgePoint.objects.create(
            chapter=chapter,
            code="REC-ASSESSMENT-B",
            order=2,
            title="根轨迹基本规则",
            difficulty=3,
            estimated_minutes=35,
        )
        LearnerProfile.objects.update_or_create(
            user=self.user,
            defaults={
                "foundation_level": "基础较弱",
                "daily_study_time": 30,
                "learning_goals": ["通过练习巩固薄弱点"],
                "weak_points": [],
                "expected_resources": ["练习题库"],
            },
        )
        path = LearningPath.objects.create(user=self.user, course=course, title="测评闭环个性化路径")
        LearningPathItem.objects.create(
            path=path,
            knowledge_point=first_point,
            order=1,
            status="current",
            estimated_minutes=first_point.estimated_minutes,
        )
        LearningPathItem.objects.create(
            path=path,
            knowledge_point=weak_point,
            order=2,
            status="locked",
            estimated_minutes=weak_point.estimated_minutes,
        )
        question = Question.objects.create(
            knowledge_point=weak_point,
            stem="根轨迹基本规则练习题",
            options=[
                {"key": "A", "text": "先确认开环极点和零点"},
                {"key": "B", "text": "只看闭环增益"},
                {"key": "C", "text": "忽略实轴判据"},
                {"key": "D", "text": "直接绘制伯德图"},
            ],
            correct_answer="A",
            explanation="根轨迹规则需要先确认开环极点和零点。",
            error_cause="根轨迹基本规则掌握不牢",
        )
        session = AssessmentSession.objects.create(user=self.user, question_ids=[str(question.id)])

        grade_response = self.client.post(
            "/api/assess/grade/",
            data=json.dumps({"sessionId": str(session.id), "selectedAnswer": "B"}),
            content_type="application/json",
        )
        self.assertEqual(grade_response.status_code, 200)
        self.assertTrue(grade_response.json()["success"])
        self.assertFalse(grade_response.json()["isCorrect"])
        self.assertIn(weak_point.title, grade_response.json()["profileUpdate"]["weakPoints"])
        profile = LearnerProfile.objects.get(user=self.user)
        self.assertIn(weak_point.title, profile.weak_points)
        self.assertTrue(WrongQuestion.objects.filter(user=self.user, question=question, mastered=False).exists())

        recommend_response = self.client.post("/api/recommend/", data="{}", content_type="application/json")

        self.assertEqual(recommend_response.status_code, 200)
        top = recommend_response.json()["recommendations"][0]
        self.assertIn(weak_point.title, top["title"])
        self.assertIn(weak_point.title, top["reason"])
        self.assertIn("weakPoint", top["evidence"]["profileMatch"]["signals"])
        ranking_labels = [item["label"] for item in top["evidence"]["rankingBasis"]]
        self.assertIn("错题薄弱点匹配", ranking_labels)


    def test_demo_status_exposes_fast_and_deep_recommendation_metrics(self):
        response = self.client.get("/api/demo/status/")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        recommendation = payload["recommendation"]
        self.assertIn("fast", recommendation)
        self.assertIn("deep", recommendation)
        self.assertEqual(recommendation["fast"]["mode"], "fast")
        self.assertEqual(recommendation["deep"]["mode"], "deep")
        self.assertGreaterEqual(recommendation["fast"]["latencyMs"], 0)
        self.assertGreaterEqual(recommendation["deep"]["latencyMs"], 0)
        self.assertGreaterEqual(recommendation["fast"]["count"], 1)
        self.assertGreaterEqual(recommendation["fast"]["sourceCount"], 1)


    def test_recommend_alias_uses_kernel_trace_agents(self):
        response = self.client.post(
            "/api/recommend/",
            data=json.dumps({"goal": "root locus", "topK": 3}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        run = AgentRun.objects.get(trace_id=payload["traceId"])
        step_names = list(run.steps.order_by("order").values_list("name", flat=True))
        self.assertEqual(
            step_names,
            ["LearningStateAgent", "RetrieverAgent", "RankerAgent", "VerifierAgent", "ResourcePackAgent"],
        )
