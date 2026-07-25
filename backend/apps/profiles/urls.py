from __future__ import annotations

from django.urls import path

from . import views


urlpatterns = [
    path("me/", views.my_profile, name="my-profile"),
    path("options/", views.profile_options, name="profile-options"),
    path("tutor-preference/", views.tutor_preference, name="tutor-preference"),
    path("learning-profile/", views.learning_profile, name="learning-profile"),
    path("extract/", views.extract_profile, name="profile-extract"),
    path("dynamic-profile/", views.dynamic_profile, name="dynamic-profile"),
    path("profile-updates/<str:update_id>/confirm/", views.confirm_profile_update_view, name="profile-update-confirm"),
    path("profile-updates/<str:update_id>/reject/", views.reject_profile_update_view, name="profile-update-reject"),
]
