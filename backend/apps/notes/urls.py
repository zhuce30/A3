from __future__ import annotations

from django.urls import path

from backend.apps.notes import views_assistant, views_attachments, views_notes


app_name = "notes"
urlpatterns = [
    path("assistant/sessions/", views_assistant.sessions, name="assistant-session-list"),
    path(
        "assistant/sessions/<uuid:session_id>/messages/",
        views_assistant.session_messages,
        name="assistant-session-messages",
    ),
    path("assistant/chat/", views_assistant.chat, name="assistant-chat"),
    path(
        "assistant/messages/<uuid:message_id>/",
        views_assistant.message_detail,
        name="assistant-message-detail",
    ),
    path("exports/", views_notes.exports, name="export-list"),
    path("exports/<uuid:export_id>/download/", views_notes.export_download, name="export-download"),
    path("exports/<uuid:export_id>/", views_notes.export_detail, name="export-detail"),
    path("notes/<uuid:note_id>/attachments/upload/", views_attachments.attachment_upload, name="attachment-upload"),
    path("notes/<uuid:note_id>/attachments/link/", views_attachments.attachment_link, name="attachment-link"),
    path("notes/<uuid:note_id>/attachments/", views_attachments.attachment_list, name="attachment-list"),
    path("attachments/<uuid:attachment_id>/download/", views_attachments.attachment_download, name="attachment-download"),
    path("attachments/<uuid:attachment_id>/reparse/", views_attachments.attachment_reparse, name="attachment-reparse"),
    path("attachments/<uuid:attachment_id>/", views_attachments.attachment_detail, name="attachment-detail"),
    path("notebooks/", views_notes.notebooks, name="notebook-list"),
    path("notebooks/<uuid:notebook_id>/", views_notes.notebook_detail, name="notebook-detail"),
    path("tags/", views_notes.tags, name="tag-list"),
    path("tags/<uuid:tag_id>/", views_notes.tag_detail, name="tag-detail"),
    path("notes/", views_notes.notes, name="note-list"),
    path("notes/<uuid:note_id>/restore/", views_notes.note_restore, name="note-restore"),
    path("notes/<uuid:note_id>/purge/", views_notes.note_purge, name="note-purge"),
    path("notes/<uuid:note_id>/revisions/", views_notes.revisions, name="revision-list"),
    path(
        "notes/<uuid:note_id>/revisions/<uuid:revision_id>/restore/",
        views_notes.revision_restore,
        name="revision-restore",
    ),
    path("notes/<uuid:note_id>/", views_notes.note_detail, name="note-detail"),
    path("search/", views_notes.search, name="search"),
]
