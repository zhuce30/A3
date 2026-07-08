from __future__ import annotations

from django.urls import path

from backend.apps.system import views

urlpatterns = [
    path("health/", views.health),
]
