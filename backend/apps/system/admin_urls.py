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
    path("conversations/", admin_views.conversations),
    path("conversations/<uuid:session_id>/", admin_views.conversation_detail),
    path("conversations/<uuid:session_id>/reveal/", admin_views.conversation_reveal),
    path("courses/", admin_views.courses),
    path("resources/", admin_views.resources),
    path("catalog/courses/", admin_views.courses),
    path("catalog/resources/", admin_views.resources),
    path("tasks/", admin_views.tasks),
    path("tasks/<str:kind>/<str:item_id>/", admin_views.task_detail),
    path("agent-runs/", admin_views.agent_runs),
    path("agent-runs/<str:trace_id>/", admin_views.agent_run_detail),
]
