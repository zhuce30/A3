from django.test import TestCase

from backend.apps.accounts.models import User
from backend.apps.learning.models import CoachingMessage, CoachingSession


class CoachingSessionModelTests(TestCase):
    def test_session_and_messages_are_ordered_for_latest_recovery(self):
        user = User.objects.create_user(phone="13800007101", password="TestPassword123")
        session = CoachingSession.objects.create(user=user, topic_title="反馈控制")
        CoachingMessage.objects.create(session=session, role="user", content="反馈控制是什么？")
        CoachingMessage.objects.create(session=session, role="assistant", content="反馈控制会回送输出。", verified=True)

        latest = CoachingSession.objects.filter(user=user, status="active").first()

        self.assertEqual(latest.id, session.id)
        self.assertEqual(list(latest.messages.values_list("role", flat=True)), ["user", "assistant"])
