import json

from django.test import SimpleTestCase

from backend.apps.assessments.content_prompts import (
    REVIEW_HANDOUT_PROMPT_VERSION,
    WRONG_EXPORT_PROMPT_VERSION,
    build_review_handout_messages,
    build_wrong_export_messages,
    sanitize_prompt_value,
)
from backend.apps.assessments.content_schemas import (
    ContentValidationError,
    extract_json_object,
    validate_review_handout_payload,
    validate_wrong_export_payload,
)


PROFILE = {
    "grade": "大二",
    "majorDirection": "计算机科学",
    "foundationLevel": "基础",
    "learningGoal": "掌握操作系统",
    "preferences": ["例题", "图解"],
    "weakPoints": ["进程调度"],
    "phone": "13800001111",
    "session": "session-secret",
    "apiKey": "key-secret",
}
QUESTION = {
    "questionId": "q-1",
    "stem": "时间片轮转调度的核心机制是什么？",
    "options": ["按优先级", "按固定时间片轮转", "只运行最短作业"],
    "correctAnswer": "B",
    "studentAnswer": "A",
    "errorCause": "混淆了优先级调度",
    "explanation": "就绪进程按固定时间片轮流获得 CPU。",
    "sourcePath": "D:/private/material.pdf",
}
SOURCE = {
    "sourceId": "S1",
    "title": "操作系统课程资料",
    "location": "进程管理",
    "snippet": "时间片轮转按固定时间片依次调度就绪进程。",
    "sourcePath": "D:/private/material.pdf",
}
WEAKNESS = {
    "knowledgePoint": "进程调度",
    "score": 0.82,
    "dueCount": 2,
    "errorCount": 4,
    "adjacentSections": ["进程状态", "调度算法"],
}


def valid_wrong_export_payload(*, citation_ids=None):
    return {
        "knowledgePoint": "进程调度",
        "groupDiagnosis": "调度规则辨析不清。",
        "prerequisiteGaps": ["就绪队列"],
        "confusions": [
            {"conceptA": "时间片轮转", "conceptB": "优先级调度", "difference": "选择依据不同。"}
        ],
        "questionAnalyses": [
            {
                "questionId": "q-1",
                "deepErrorDiagnosis": "把调度顺序误认为只由优先级决定。",
                "solutionSteps": ["识别算法名称", "核对时间片机制"],
                "selfCheck": "检查每个就绪进程是否轮流获得 CPU。",
                "reviewAdvice": "对比两种算法后重练。",
                "citationIds": citation_ids if citation_ids is not None else ["S1"],
            }
        ],
        "transferPractice": [
            {
                "prompt": "三个进程按时间片轮转，写出首轮顺序。",
                "answer": "P1、P2、P3",
                "explanation": "就绪队列中的进程依次获得一个时间片。",
                "difficulty": "基础",
                "citationIds": citation_ids if citation_ids is not None else ["S1"],
            }
        ],
        "evidenceStatus": "verified",
    }


def valid_handout_payload(*, citation_ids=None):
    return {
        "knowledgePoint": "进程调度",
        "learningDiagnosis": "需要区分不同调度依据。",
        "coreConcept": "时间片轮转让就绪进程依次占用 CPU。",
        "prerequisites": ["进程状态", "就绪队列"],
        "commonErrorPatterns": ["把时间片轮转当成优先级调度"],
        "method": ["识别算法", "模拟队列", "检查轮转顺序"],
        "workedExample": {
            "prompt": "模拟三个进程的第一轮调度。",
            "steps": ["建立就绪队列", "依次执行一个时间片"],
            "answer": "P1、P2、P3",
        },
        "tieredPractice": [
            {"level": "基础", "prompt": "判断调度依据。", "answer": "时间片", "explanation": "按时间片轮转。"},
            {"level": "巩固", "prompt": "模拟两轮队列。", "answer": "按队列循环", "explanation": "未完成进程回到队尾。"},
            {"level": "迁移", "prompt": "比较时间片大小的影响。", "answer": "影响响应与切换开销", "explanation": "时间片越小响应越快但切换更多。"},
        ],
        "reviewActions": ["画出就绪队列", "隔天重练"],
        "citationIds": citation_ids if citation_ids is not None else ["S1"],
        "evidenceStatus": "verified",
    }


class ContentPromptTests(SimpleTestCase):
    def test_prompt_versions_are_stable(self):
        self.assertEqual(WRONG_EXPORT_PROMPT_VERSION, "wrong-export-v1")
        self.assertEqual(REVIEW_HANDOUT_PROMPT_VERSION, "review-handout-v1")

    def test_wrong_export_prompt_forbids_answer_rewrite_and_unknown_sources(self):
        messages = build_wrong_export_messages(PROFILE, [QUESTION], [SOURCE])
        self.assertEqual([message["role"] for message in messages], ["system", "user"])
        system, user = messages[0]["content"], messages[1]["content"]
        self.assertIn("不得修改或质疑 correctAnswer", system)
        self.assertIn("只能使用提供的 sourceId", system)
        self.assertIn("只输出一个 JSON 对象", system)
        self.assertIn('"questionId": "q-1"', user)
        self.assertIn('"sourceId": "S1"', user)
        self.assertNotIn("13800001111", user)
        self.assertNotIn("session-secret", user)
        self.assertNotIn("key-secret", user)
        self.assertNotIn("D:/private", user)

    def test_handout_prompt_requires_tiered_practice_and_no_fake_pages(self):
        messages = build_review_handout_messages(PROFILE, WEAKNESS, [QUESTION], [SOURCE])
        system, user = messages[0]["content"], messages[1]["content"]
        self.assertIn("不得伪造教材名称、页码", system)
        self.assertIn("基础、巩固、迁移", system)
        self.assertIn("evidenceStatus", system)
        self.assertNotIn("13800001111", user)

    def test_prompt_drops_absolute_path_misfiled_as_source_location(self):
        source = dict(SOURCE, location="D:/private/course/material.pdf")
        user = build_wrong_export_messages(PROFILE, [QUESTION], [source])[1]["content"]
        self.assertNotIn("D:/private", user)

    def test_prompt_recursively_redacts_paths_and_key_like_values(self):
        profile = dict(
            PROFILE,
            learningGoal="参考 C:\\private\\plan.txt 并使用 sk-secretvalue123456",
            preferences=["图解", "/opt/a3/private/notes.txt"],
        )
        question = dict(QUESTION, stem="题目存于 \\\\server\\private\\question.txt")
        source = dict(SOURCE, title="D:/private/x.pdf", location="公开课程第 3 章")
        user = build_wrong_export_messages(profile, [question], [source])[1]["content"]
        self.assertNotIn("C:\\private", user)
        self.assertNotIn("/opt/a3", user)
        self.assertNotIn("\\\\server", user)
        self.assertNotIn("D:/private", user)
        self.assertNotIn("sk-secretvalue", user)
        self.assertIn("公开课程第 3 章", user)

    def test_prompt_sanitizer_is_recursive_and_preserves_public_locations(self):
        sanitized = sanitize_prompt_value({
            "nested": ["D:\\private\\one.txt", {"token": "api_key-secretvalue123456"}],
            "location": "操作系统课程 > 进程管理 > 第 3 节",
        })
        serialized = json.dumps(sanitized, ensure_ascii=False)
        self.assertNotIn("D:\\private", serialized)
        self.assertNotIn("api_key-secret", serialized)
        self.assertEqual(sanitized["location"], "操作系统课程 > 进程管理 > 第 3 节")

    def test_prompt_sanitizer_preserves_urls_and_redacts_sensitive_keys(self):
        sanitized = sanitize_prompt_value({
            "location": "https://example.edu/course/chapter-3",
            "nested": {"apiKey": "abcdefghijklmnop", "session": "session-secret"},
        })
        serialized = json.dumps(sanitized, ensure_ascii=False)
        self.assertEqual(sanitized["location"], "https://example.edu/course/chapter-3")
        self.assertNotIn("abcdefghijklmnop", serialized)
        self.assertNotIn("session-secret", serialized)


class ContentSchemaTests(SimpleTestCase):
    def test_extract_json_object_accepts_only_one_plain_object(self):
        self.assertEqual(extract_json_object('  {"ok": true}  '), {"ok": True})
        for content in ('```json\n{"ok": true}\n```', '{"a": 1}{"b": 2}', '[{"a": 1}]', '前言 {"a": 1}'):
            with self.subTest(content=content):
                with self.assertRaises(ContentValidationError):
                    extract_json_object(content)

    def test_wrong_export_validator_normalizes_valid_payload(self):
        payload = validate_wrong_export_payload(
            valid_wrong_export_payload(),
            question_ids={"q-1"},
            source_ids={"S1"},
            answers={"q-1": "B"},
        )
        self.assertEqual(payload["questionAnalyses"][0]["questionId"], "q-1")
        self.assertEqual(payload["evidenceStatus"], "verified")
        self.assertIsNot(payload, valid_wrong_export_payload())

    def test_wrong_export_validator_rejects_unknown_and_duplicate_question_ids(self):
        unknown = valid_wrong_export_payload()
        unknown["questionAnalyses"][0]["questionId"] = "q-9"
        with self.assertRaisesMessage(ContentValidationError, "未知题目 q-9"):
            validate_wrong_export_payload(unknown, question_ids={"q-1"}, source_ids={"S1"}, answers={"q-1": "B"})
        duplicate = valid_wrong_export_payload()
        duplicate["questionAnalyses"].append(dict(duplicate["questionAnalyses"][0]))
        with self.assertRaisesMessage(ContentValidationError, "重复题目 q-1"):
            validate_wrong_export_payload(duplicate, question_ids={"q-1"}, source_ids={"S1"}, answers={"q-1": "B"})

    def test_wrong_export_validator_rejects_unknown_citation_and_answer_conflict(self):
        with self.assertRaisesMessage(ContentValidationError, "未知引用 S9"):
            validate_wrong_export_payload(valid_wrong_export_payload(citation_ids=["S9"]), question_ids={"q-1"}, source_ids={"S1"}, answers={"q-1": "B"})
        conflict = valid_wrong_export_payload()
        conflict["questionAnalyses"][0]["deepErrorDiagnosis"] = "本题正确答案应为 A。"
        with self.assertRaisesMessage(ContentValidationError, "正确答案冲突"):
            validate_wrong_export_payload(conflict, question_ids={"q-1"}, source_ids={"S1"}, answers={"q-1": "B"})

    def test_wrong_export_validator_checks_answer_claims_in_all_generated_sections(self):
        mutations = [
            lambda value: value.__setitem__("groupDiagnosis", "正确答案是 A。"),
            lambda value: value.__setitem__("prerequisiteGaps", ["正确选项为 A。"]),
            lambda value: value["confusions"][0].__setitem__("difference", "答案为 A。"),
            lambda value: value["questionAnalyses"][0].__setitem__("selfCheck", "答案是 A。"),
        ]
        for mutate in mutations:
            payload = valid_wrong_export_payload()
            mutate(payload)
            with self.subTest(payload=payload):
                with self.assertRaisesMessage(ContentValidationError, "正确答案冲突"):
                    validate_wrong_export_payload(payload, question_ids={"q-1"}, source_ids={"S1"}, answers={"q-1": "B"})

    def test_wrong_export_validator_does_not_treat_practice_answer_as_original_claim(self):
        payload = valid_wrong_export_payload()
        payload["transferPractice"][0]["answer"] = "A"
        payload["transferPractice"][0]["explanation"] = "这道迁移练习的正确答案是 A。"
        validated = validate_wrong_export_payload(payload, question_ids={"q-1"}, source_ids={"S1"}, answers={"q-1": "B"})
        self.assertEqual(validated["transferPractice"][0]["answer"], "A")

    def test_wrong_export_validator_keeps_question_answer_mapping(self):
        payload = valid_wrong_export_payload()
        payload["groupDiagnosis"] = "q-1 的正确答案是 A。"
        with self.assertRaisesMessage(ContentValidationError, "正确答案冲突"):
            validate_wrong_export_payload(
                payload,
                question_ids={"q-1", "q-2"},
                source_ids={"S1"},
                answers={"q-1": "B", "q-2": "A"},
            )

    def test_wrong_export_validator_rejects_missing_invalid_and_oversized_fields(self):
        missing = valid_wrong_export_payload()
        del missing["groupDiagnosis"]
        with self.assertRaises(ContentValidationError):
            validate_wrong_export_payload(missing, question_ids={"q-1"}, source_ids={"S1"}, answers={"q-1": "B"})
        invalid = valid_wrong_export_payload()
        invalid["evidenceStatus"] = "trusted"
        with self.assertRaises(ContentValidationError):
            validate_wrong_export_payload(invalid, question_ids={"q-1"}, source_ids={"S1"}, answers={"q-1": "B"})
        oversized = valid_wrong_export_payload()
        oversized["groupDiagnosis"] = "长" * 2001
        with self.assertRaises(ContentValidationError):
            validate_wrong_export_payload(oversized, question_ids={"q-1"}, source_ids={"S1"}, answers={"q-1": "B"})
        too_many = valid_wrong_export_payload()
        too_many["prerequisiteGaps"] = [str(index) for index in range(13)]
        with self.assertRaises(ContentValidationError):
            validate_wrong_export_payload(too_many, question_ids={"q-1"}, source_ids={"S1"}, answers={"q-1": "B"})
        too_many_exercises = valid_wrong_export_payload()
        too_many_exercises["transferPractice"] *= 7
        with self.assertRaises(ContentValidationError):
            validate_wrong_export_payload(too_many_exercises, question_ids={"q-1"}, source_ids={"S1"}, answers={"q-1": "B"})

    def test_handout_validator_normalizes_and_rejects_bad_contracts(self):
        payload = validate_review_handout_payload(valid_handout_payload(), source_ids={"S1"}, answers={"q-1": "B"})
        self.assertEqual([item["level"] for item in payload["tieredPractice"]], ["基础", "巩固", "迁移"])
        for mutation in ("missing", "citation", "status", "exercise_count"):
            candidate = valid_handout_payload()
            if mutation == "missing":
                del candidate["coreConcept"]
            elif mutation == "citation":
                candidate["citationIds"] = ["S9"]
            elif mutation == "status":
                candidate["evidenceStatus"] = "trusted"
            else:
                candidate["tieredPractice"] *= 3
            with self.subTest(mutation=mutation):
                with self.assertRaises(ContentValidationError):
                    validate_review_handout_payload(candidate, source_ids={"S1"}, answers={"q-1": "B"})

    def test_handout_validator_rejects_missing_tier_and_long_prose(self):
        missing_tier = valid_handout_payload()
        missing_tier["tieredPractice"] = missing_tier["tieredPractice"][:2]
        with self.assertRaises(ContentValidationError):
            validate_review_handout_payload(missing_tier, source_ids={"S1"}, answers={"q-1": "B"})
        oversized = valid_handout_payload()
        oversized["coreConcept"] = "长" * 2001
        with self.assertRaises(ContentValidationError):
            validate_review_handout_payload(oversized, source_ids={"S1"}, answers={"q-1": "B"})

    def test_handout_validator_rejects_original_answer_conflict_anywhere(self):
        mutations = (
            lambda value: value.__setitem__("learningDiagnosis", "本题正确选项为 A。"),
            lambda value: value.__setitem__("coreConcept", "答案是 A。"),
        )
        for mutate in mutations:
            payload = valid_handout_payload()
            mutate(payload)
            with self.subTest(payload=payload):
                with self.assertRaisesMessage(ContentValidationError, "正确答案冲突"):
                    validate_review_handout_payload(payload, source_ids={"S1"}, answers={"q-1": "B"})

    def test_handout_validator_allows_new_example_answer_explanations(self):
        payload = valid_handout_payload()
        payload["workedExample"]["answer"] = "A"
        payload["workedExample"]["steps"] = ["本例正确答案是 A。"]
        payload["tieredPractice"][0]["answer"] = "A"
        payload["tieredPractice"][0]["explanation"] = "这道练习的正确答案是 A。"
        validated = validate_review_handout_payload(payload, source_ids={"S1"}, answers={"q-1": "B"})
        self.assertEqual(validated["workedExample"]["answer"], "A")

    def test_handout_validator_keeps_question_answer_mapping(self):
        payload = valid_handout_payload()
        payload["learningDiagnosis"] = "q-1 的正确答案是 A。"
        with self.assertRaisesMessage(ContentValidationError, "正确答案冲突"):
            validate_review_handout_payload(
                payload,
                source_ids={"S1"},
                question_ids={"q-1", "q-2"},
                answers={"q-1": "B", "q-2": "A"},
            )

    def test_validators_reject_extra_fields_duplicate_citations_and_bad_enums(self):
        cases = []
        extra = valid_wrong_export_payload()
        extra["unexpected"] = "no"
        cases.append((validate_wrong_export_payload, extra, {"question_ids": {"q-1"}, "source_ids": {"S1"}, "answers": {"q-1": "B"}}))
        duplicate_citation = valid_wrong_export_payload(citation_ids=["S1", "S1"])
        cases.append((validate_wrong_export_payload, duplicate_citation, {"question_ids": {"q-1"}, "source_ids": {"S1"}, "answers": {"q-1": "B"}}))
        bad_difficulty = valid_wrong_export_payload()
        bad_difficulty["transferPractice"][0]["difficulty"] = "困难"
        cases.append((validate_wrong_export_payload, bad_difficulty, {"question_ids": {"q-1"}, "source_ids": {"S1"}, "answers": {"q-1": "B"}}))
        bad_level = valid_handout_payload()
        bad_level["tieredPractice"][0]["level"] = "入门"
        cases.append((validate_review_handout_payload, bad_level, {"source_ids": {"S1"}, "answers": {"q-1": "B"}}))
        wrong_type = valid_handout_payload()
        wrong_type["method"] = "识别"
        cases.append((validate_review_handout_payload, wrong_type, {"source_ids": {"S1"}, "answers": {"q-1": "B"}}))
        for validator, payload, kwargs in cases:
            with self.subTest(validator=validator.__name__, payload=payload):
                with self.assertRaises(ContentValidationError):
                    validator(payload, **kwargs)

    def test_valid_payload_remains_json_serializable(self):
        normalized = validate_wrong_export_payload(valid_wrong_export_payload(), question_ids={"q-1"}, source_ids={"S1"}, answers={"q-1": "B"})
        json.dumps(normalized, ensure_ascii=False)
