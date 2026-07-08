from __future__ import annotations

from django.apps import AppConfig


class KnowledgeBaseConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "backend.apps.knowledge_base"
    label = "knowledge_base"
    verbose_name = "知识库"
