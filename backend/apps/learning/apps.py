from django.apps import AppConfig


class LearningConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "backend.apps.learning"
    label = "learning"
    verbose_name = "课程与学习路径"
