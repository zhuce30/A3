from __future__ import annotations

from django.apps import AppConfig


class NotesConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "backend.apps.notes"
    label = "notes"
    verbose_name = "A3 Personal Notes"
