from __future__ import annotations

from django.urls import path

from backend.apps.notes import views_notes


app_name = "notes"
urlpatterns = [
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
