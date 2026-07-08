from __future__ import annotations

from django.urls import path

from backend.apps.engagement import views


urlpatterns = [
    path("favorites/", views.favorites),
    path("favorites/create/", views.create_favorite),
    path("favorites/<uuid:favorite_id>/", views.delete_favorite),
    path("notifications/", views.notifications),
    path("notifications/read-all/", views.mark_all_notifications_read),
    path("notifications/<uuid:notification_id>/read/", views.mark_notification_read),
]

