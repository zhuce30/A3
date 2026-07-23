from django.db import connection
from django.test import Client, TestCase
from django.test.utils import CaptureQueriesContext

from backend.apps.accounts.models import User, UserRole
from backend.apps.learning.models import LearningEvent


class AdminUsersTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.admin = User.objects.create_user(phone='admin-users', password='password123', role=UserRole.ADMIN)
        self.student = User.objects.create_user(
            phone='13800138000',
            email='student@example.com',
            password='password123',
            display_name='测试学生',
        )
        LearningEvent.objects.create(user=self.student, event_type='task_completed')
        self.client.force_login(self.admin)

    def test_lists_real_users_with_masked_identifiers_and_activity(self):
        response = self.client.get('/api/admin/users/?search=测试学生')
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['pagination']['total'], 1)
        item = payload['items'][0]
        self.assertEqual(item['displayName'], '测试学生')
        self.assertNotEqual(item['phone'], '13800138000')
        self.assertEqual(item['activity']['learningEvents'], 1)
        self.assertEqual(item['registrationIp']['status'], 'not_collected')

    def test_user_list_does_not_join_multiple_activity_tables_in_one_query(self):
        activity_tables = {
            'a3_learning_events',
            'a3_coaching_sessions',
            'a3_resource_pack_logs',
            'a3_agent_runs',
        }
        with CaptureQueriesContext(connection) as captured:
            response = self.client.get('/api/admin/users/?page=1&pageSize=20')

        self.assertEqual(response.status_code, 200)
        joined_activity_tables = [
            {table for table in activity_tables if table in query['sql']}
            for query in captured.captured_queries
        ]
        self.assertFalse(
            any(len(tables) > 1 for tables in joined_activity_tables),
            joined_activity_tables,
        )
        profile_and_access_sorts = [
            query['sql']
            for query in captured.captured_queries
            if 'a3_learner_profiles' in query['sql']
            and 'a3_user_access_states' in query['sql']
            and 'ORDER BY' in query['sql'].upper()
        ]
        self.assertEqual(profile_and_access_sorts, [])

    def test_status_update_is_audited_and_cannot_disable_self(self):
        response = self.client.post(
            f'/api/admin/users/{self.student.pk}/status/',
            data='{"isActive": false, "reason": "测试停用"}',
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 200)
        self.student.refresh_from_db()
        self.assertFalse(self.student.is_active)

        response = self.client.post(
            f'/api/admin/users/{self.admin.pk}/status/',
            data='{"isActive": false, "reason": "错误操作"}',
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)
