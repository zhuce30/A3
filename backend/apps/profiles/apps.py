from __future__ import annotations

from django.apps import AppConfig


class ProfilesConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "backend.apps.profiles"
    label = "profiles"
    verbose_name = "学习画像"
