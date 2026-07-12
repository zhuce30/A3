from __future__ import annotations

from django.urls import path

from backend.apps.compat import views


urlpatterns = [
    path("profile/interview/", views.profile_interview, name="compat-profile-interview"),
    path("profile/interview/session/", views.profile_interview_session, name="compat-profile-interview-session"),
    path("profile/extract/", views.profile_extract, name="compat-profile-extract"),
    path("profile/update/", views.profile_update, name="compat-profile-update"),
    path("resources/generate/", views.resource_generate, name="compat-resource-generate"),
    path("resources/jobs/", views.resource_generation_jobs, name="compat-resource-generation-jobs"),
    path("resources/jobs/<str:job_id>/", views.resource_generation_job_detail, name="compat-resource-generation-job-detail"),
    path("resources/packs/", views.resource_packs, name="compat-resource-packs"),
    path("resources/packs/<str:pack_id>/feedback/", views.resource_pack_feedback, name="compat-resource-pack-feedback"),
    path("resources/packs/<str:pack_id>/code-lab/run/", views.resource_pack_code_lab_run, name="compat-resource-pack-code-lab-run"),
    path("resources/packs/<str:pack_id>/openmaic-classroom/", views.resource_pack_openmaic_classroom, name="compat-resource-pack-openmaic-classroom"),
    path("resources/packs/<str:pack_id>/openmaic-video/", views.resource_pack_openmaic_video, name="compat-resource-pack-openmaic-video"),
    path("resources/packs/<str:pack_id>/openmaic-pptx-export/", views.resource_pack_openmaic_pptx_export, name="compat-resource-pack-openmaic-pptx-export"),
    path("resources/packs/<str:pack_id>/openmaic-interaction/", views.resource_pack_openmaic_interaction, name="compat-resource-pack-openmaic-interaction"),
    path("resources/packs/<str:pack_id>/", views.resource_pack_detail, name="compat-resource-pack-detail"),
    path("learning/effect/evaluate/", views.learning_effect_evaluate, name="compat-learning-effect-evaluate"),
    path("learning/effect/report/", views.learning_effect_report, name="compat-learning-effect-report"),
    path("learning/effect/optimization-policy/", views.learning_effect_optimization_policy, name="compat-learning-effect-optimization-policy"),
    path("path/generate/", views.path_generate, name="compat-path-generate"),
    path("assess/grade/", views.assess_grade, name="compat-assess-grade"),
    path("recommend/", views.recommend, name="compat-recommend"),
    path("verify/answer/", views.verify_answer_view, name="compat-verify-answer"),
    path("demo/status/", views.demo_status, name="compat-demo-status"),
    path("demo/agent-runs/<str:trace_id>/export/", views.demo_agent_run_export, name="compat-demo-agent-run-export"),
    path("demo/agent-runs/<str:trace_id>/", views.demo_agent_run_detail, name="compat-demo-agent-run-detail"),
    path("demo/validate/", views.demo_validate, name="compat-demo-validate"),
    path("demo/report/", views.demo_report, name="compat-demo-report"),
    path("demo/evaluate/", views.demo_evaluate, name="compat-demo-evaluate"),
    path("v1/qa/interact/", views.qa_interact, name="compat-v1-qa-interact"),
    path("v1/progress/track/", views.progress_track, name="compat-v1-progress-track"),
]
