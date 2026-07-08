from __future__ import annotations

import json

from django.test import Client, TestCase

from backend.apps.accounts.models import User
from backend.apps.profiles.models import LearnerProfile


class TokenAuthTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800138000", password="secure-pass-123")
        self.client = Client()

    def test_token_login_returns_bearer_token(self):
        response = self.client.post(
            "/api/auth/token/",
            data=json.dumps({"identifier": self.user.phone, "password": "secure-pass-123"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["success"])
        self.assertEqual(payload["tokenType"], "Bearer")
        self.assertTrue(payload["accessToken"])

    def test_bearer_token_authenticates_me_endpoint(self):
        token_response = self.client.post(
            "/api/auth/token/",
            data=json.dumps({"identifier": self.user.phone, "password": "secure-pass-123"}),
            content_type="application/json",
        )
        token = token_response.json()["accessToken"]

        response = self.client.get("/api/auth/me/", HTTP_AUTHORIZATION=f"Bearer {token}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user"]["phone"], self.user.phone)

    def test_me_endpoint_includes_saved_learning_profile(self):
        LearnerProfile.objects.create(
            user=self.user,
            grade="大二",
            major_direction="控制理论与控制工程",
            foundation_level="基础较弱",
            daily_study_time=60,
            learning_goals=["掌握自动控制原理"],
            learning_preferences=["例题推导"],
            weak_points=["根轨迹"],
            expected_resources=["视频课程"],
            pace="standard",
        )
        self.client.force_login(self.user)

        response = self.client.get("/api/auth/me/")

        self.assertEqual(response.status_code, 200)
        profile = response.json()["user"]["learningProfile"]
        self.assertEqual(profile["grade"], "大二")
        self.assertEqual(profile["weakPoints"], ["根轨迹"])
        self.assertEqual(profile["expectedResources"], ["视频课程"])

    def test_invalid_bearer_token_does_not_authenticate(self):
        response = self.client.get("/api/auth/me/", HTTP_AUTHORIZATION="Bearer invalid")

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["user"])
