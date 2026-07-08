from django.urls import path

from backend.apps.learning import views


urlpatterns = [
    path("courses/", views.courses, name="learning-courses"),
    path("courses/<uuid:course_id>/", views.course_detail, name="learning-course-detail"),
    path("courses/<uuid:course_id>/materials/", views.course_materials_view, name="learning-course-materials"),
    path("courses/<uuid:course_id>/enroll/", views.enroll, name="learning-enroll"),
    path("paths/current/", views.current_path, name="learning-current-path"),
    path("paths/generate/", views.generate_path, name="learning-generate-path"),
    path("path-items/<uuid:item_id>/progress/", views.path_item_progress, name="learning-path-progress"),
    path("dashboard/", views.dashboard, name="learning-dashboard"),
    path("events/", views.ingest_event, name="learning-events-ingest"),
    path("events/batch/", views.ingest_events_batch, name="learning-events-batch-ingest"),
    path("events/recent/", views.recent_events, name="learning-events-recent"),
    path("events/summary/", views.events_summary, name="learning-events-summary"),
    path("effect/resource-attribution/", views.resource_attribution, name="learning-resource-attribution"),
    path("admission-diagnostic/", views.admission_diagnostic, name="learning-admission-diagnostic"),
    path("study-plan/", views.study_plan, name="learning-study-plan"),
    path("study-plan/generate/", views.generate_plan, name="learning-study-plan-generate"),
    path("study-plan/tasks/complete/", views.complete_plan_task, name="learning-study-plan-task-complete"),
    path("study-plan/resource-pack/assign/", views.assign_resource_pack, name="learning-study-plan-resource-pack-assign"),
    path("study-plan/reflections/", views.daily_reflection, name="learning-daily-reflection"),
    path("graph/", views.graph, name="learning-graph"),
    path("classroom/", views.classroom, name="learning-classroom"),
    path("classroom/history/", views.classroom_history, name="learning-classroom-history"),
    path("coaching/sessions/", views.coaching_sessions, name="learning-coaching-sessions"),
    path("coaching/sessions/<uuid:session_id>/", views.coaching_session_by_id, name="learning-coaching-session-detail"),
    path("coaching/sessions/<uuid:session_id>/summary/", views.coaching_session_summary, name="learning-coaching-session-summary"),
    path("coaching/session/", views.coaching_history, name="learning-coaching-session"),
    path("coaching/session/end/", views.coaching_end, name="learning-coaching-session-end"),
    path("teacher/workbench/", views.teacher, name="learning-teacher-workbench"),
    path("teacher/tasks/execute/", views.teacher_task_execute, name="learning-teacher-task-execute"),
]
