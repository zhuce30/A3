from __future__ import annotations

from django.urls import path

from backend.apps.accounts import views

urlpatterns = [
    path("presence/heartbeat/", views.presence_heartbeat),
    path("csrf/", views.csrf_token),
    path("register/", views.register),
    path("login/", views.login_view),
    path("token/", views.token_login),
    path("logout/", views.logout_view),
    path("me/", views.me),
    path("send-code/", views.send_code),
    path("reset-password/", views.reset_password),
]
