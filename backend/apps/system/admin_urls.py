from django.urls import path

from backend.apps.system import admin_views


urlpatterns = [
    path("overview/", admin_views.overview),
    path("users/", admin_views.users),
    path("users/<int:user_id>/", admin_views.user_detail),
    path("users/<int:user_id>/status/", admin_views.user_status),
    path("users/<int:user_id>/reveal-ip/", admin_views.reveal_ip),
    path("activity/", admin_views.activity),
    path("security-events/", admin_views.security_events),
]
