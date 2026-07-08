from django.urls import path

from backend.apps.assessments import views


urlpatterns = [
    path("current/", views.current_assessment, name="assessment-current"),
    path("start/", views.start_assessment, name="assessment-start"),
    path("sessions/<uuid:session_id>/answer/", views.submit_answer, name="assessment-answer"),
    path("wrong-questions/", views.wrong_questions, name="wrong-questions"),
    path("wrong-questions/<uuid:wrong_id>/retry/", views.retry_wrong_question, name="wrong-question-retry"),
    path("report/", views.learning_report, name="learning-report"),
    path("questions/", views.questions, name="question-list"),
    path("questions/generate/", views.generate_questions, name="question-generate"),
    path("questions/<uuid:question_id>/review/", views.review_question, name="question-review"),
]
