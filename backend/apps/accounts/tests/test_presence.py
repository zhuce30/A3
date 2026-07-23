from datetime import timedelta

from django.core.cache import cache
from django.test import RequestFactory, TestCase
from django.utils import timezone

from backend.apps.accounts.models import User
from backend.apps.accounts.presence import get_user_presence, touch_user_presence


class PresenceTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(phone='presence-user', password='password123')
        self.request = RequestFactory().post('/api/auth/presence/heartbeat/', REMOTE_ADDR='127.0.0.1')

    def test_heartbeat_marks_user_online_and_persists_last_seen(self):
        touch_user_presence(self.user, self.request, '/a3/today')
        self.assertEqual(get_user_presence(self.user)['status'], 'online')
        self.user.refresh_from_db()
        self.assertIsNotNone(self.user.access_state.last_seen_at)

    def test_missing_heartbeat_falls_back_to_idle_then_offline(self):
        state = self.user.access_state if hasattr(self.user, 'access_state') else None
        self.assertIsNone(state)
        self.assertEqual(get_user_presence(self.user)['status'], 'offline')

        touch_user_presence(self.user, self.request, '/a3/today')
        cache.delete(f'a3:presence:{self.user.pk}')
        self.user.access_state.last_seen_at = timezone.now() - timedelta(minutes=5)
        self.user.access_state.save(update_fields=['last_seen_at'])
        self.assertEqual(get_user_presence(self.user)['status'], 'idle')

        self.user.access_state.last_seen_at = timezone.now() - timedelta(minutes=16)
        self.user.access_state.save(update_fields=['last_seen_at'])
        self.assertEqual(get_user_presence(self.user)['status'], 'offline')
