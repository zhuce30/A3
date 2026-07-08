from __future__ import annotations

from django.contrib import admin
from django.urls import include, path


urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/auth/", include("backend.apps.accounts.urls")),
    path("api/", include("backend.apps.compat.urls")),
    path("api/profiles/", include("backend.apps.profiles.urls")),
    path("api/kb/", include("backend.apps.knowledge_base.urls")),
    path("api/learning/", include("backend.apps.learning.urls")),
    path("api/assessments/", include("backend.apps.assessments.urls")),
    path("api/engagement/", include("backend.apps.engagement.urls")),
    path("api/system/", include("backend.apps.system.urls")),
]
