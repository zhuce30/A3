from django.test import Client, TestCase

from backend.apps.accounts.models import User, UserRole


class AdminPermissionTests(TestCase):
    def setUp(self):
        self.client = Client()

    def test_admin_overview_requires_admin_role(self):
        response = self.client.get('/api/admin/overview/')
        self.assertEqual(response.status_code, 401)

        for role in (UserRole.STUDENT, UserRole.TEACHER):
            user = User.objects.create_user(phone=f'{role}-permission', password='password123', role=role)
            self.client.force_login(user)
            response = self.client.get('/api/admin/overview/')
            self.assertEqual(response.status_code, 403)
            self.client.logout()

        admin = User.objects.create_user(phone='admin-permission', password='password123', role=UserRole.ADMIN)
        self.client.force_login(admin)
        response = self.client.get('/api/admin/overview/')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['success'])
