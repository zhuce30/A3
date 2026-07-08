from __future__ import annotations

import json
import tempfile
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from django.core.management import call_command
from django.core.cache import cache
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.assessments.models import AssessmentSession, Question, WrongQuestion
from backend.apps.engagement.models import UserFavorite, UserNotification
from backend.apps.knowledge_base.models import KnowledgeGraphEntity, KnowledgeGraphRelation, KnowledgeResource
from backend.apps.learning.models import Chapter, Course, KnowledgePoint, LearningPath, LearningPathItem, ResourcePackLog
from backend.apps.compat.agent_runtime import AgentRun as RuntimeAgentRun
from backend.apps.compat.agent_workflows import describe_agent_workflows, evaluate_trace_contract
from backend.apps.compat.models import AgentRun, AgentStep, OpenMAICArtifact
from backend.apps.profiles.models import LearnerProfile


MOJIBAKE_MARKERS = (
    "\u942d",
    "\u9365",
    "\u93cd",
    "\u93ba",
    "\u9422",
    "\u9225",
    "\u9286",
    "\u7ed7",
    "\u95c5",
    "\u9352",
    "\u935b",
    "\u74ba",
    "\u951f",
    "\ufffd",
)


def assert_payload_has_no_mojibake(testcase: TestCase, value):
    if isinstance(value, dict):
        for item in value.values():
            assert_payload_has_no_mojibake(testcase, item)
        return
    if isinstance(value, list):
        for item in value:
            assert_payload_has_no_mojibake(testcase, item)
        return
    if isinstance(value, str):
        for marker in MOJIBAKE_MARKERS:
            testcase.assertNotIn(marker, value)




class CompatApiTestCase(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800139900", password="secure-pass-123")
        self.client = Client()
        self.client.force_login(self.user)
