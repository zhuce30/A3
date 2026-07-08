from __future__ import annotations

from django.urls import path

from . import views


urlpatterns = [
    path("me/", views.my_profile, name="my-profile"),
    path("options/", views.profile_options, name="profile-options"),
    path("learning-profile/", views.learning_profile, name="learning-profile"),
    path("extract/", views.extract_profile, name="profile-extract"),
]
