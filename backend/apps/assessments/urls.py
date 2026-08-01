from django.urls import path

from backend.apps.assessments import views


urlpatterns = [
    path("current/", views.current_assessment, name="assessment-current"),
    path("start/", views.start_assessment, name="assessment-start"),
    path("sessions/<uuid:session_id>/answer/", views.submit_answer, name="assessment-answer"),
    path("wrong-questions/", views.wrong_questions, name="wrong-questions"),
    path("wrong-questions/export/", views.wrong_question_export, name="wrong-question-export"),
    path("wrong-questions/exports/", views.wrong_question_export_jobs, name="wrong-question-export-jobs"),
    path("wrong-questions/exports/<uuid:job_id>/", views.wrong_question_export_job_detail, name="wrong-question-export-detail"),
    path("wrong-questions/exports/<uuid:job_id>/cancel/", views.cancel_wrong_question_export_job, name="wrong-question-export-cancel"),
    path("wrong-questions/exports/<uuid:job_id>/retry/", views.retry_wrong_question_export, name="wrong-question-export-retry"),
    path("wrong-questions/exports/<uuid:job_id>/download/", views.download_wrong_question_export, name="wrong-question-export-download"),
    path("wrong-questions/review-handouts/", views.review_handout_jobs, name="review-handout-jobs"),
    path("wrong-questions/review-handouts/<uuid:job_id>/", views.review_handout_job_detail, name="review-handout-detail"),
    path("wrong-questions/review-handouts/<uuid:job_id>/cancel/", views.cancel_review_handout_job, name="review-handout-cancel"),
    path("wrong-questions/review-handouts/<uuid:job_id>/retry/", views.retry_review_handout, name="review-handout-retry"),
    path("wrong-questions/review-handouts/<uuid:job_id>/download/<str:export_format>/", views.download_review_handout, name="review-handout-download"),
    path("wrong-questions/<uuid:wrong_id>/retry/", views.retry_wrong_question, name="wrong-question-retry"),
    path("report/", views.learning_report, name="learning-report"),
    path("questions/", views.questions, name="question-list"),
    path("questions/generate/", views.generate_questions, name="question-generate"),
    path("questions/batch-review/", views.batch_review_questions, name="question-batch-review"),
    path("questions/<uuid:question_id>/review/", views.review_question, name="question-review"),
]
