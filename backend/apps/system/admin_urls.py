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
    path("security-events/<int:event_id>/review/", admin_views.security_event_review),
    path("conversations/", admin_views.conversations),
    path("conversations/<uuid:session_id>/", admin_views.conversation_detail),
    path("conversations/<uuid:session_id>/reveal/", admin_views.conversation_reveal),
    path("courses/", admin_views.courses),
    path("courses/<uuid:course_id>/status/", admin_views.course_status),
    path("resources/", admin_views.resources),
    path("resources/<uuid:resource_id>/status/", admin_views.resource_status),
    path("resources/<uuid:resource_id>/reindex/", admin_views.resource_reindex),
    path("catalog/courses/", admin_views.courses),
    path("catalog/courses/<uuid:course_id>/status/", admin_views.course_status),
    path("catalog/resources/", admin_views.resources),
    path("catalog/resources/<uuid:resource_id>/status/", admin_views.resource_status),
    path("catalog/resources/<uuid:resource_id>/reindex/", admin_views.resource_reindex),
    path("tasks/", admin_views.tasks),
    path("tasks/<str:kind>/<str:item_id>/", admin_views.task_detail),
    path("tasks/<str:kind>/<str:item_id>/retry/", admin_views.task_retry),
    path("tasks/<str:kind>/<str:item_id>/cancel/", admin_views.task_cancel),
    path("agent-runs/", admin_views.agent_runs),
    path("agent-runs/<str:trace_id>/", admin_views.agent_run_detail),
    path("configuration/", admin_views.configuration),
    path("configuration/<str:check>/verify/", admin_views.configuration_verify),
    path("audit-logs/", admin_views.audit_logs),
]
