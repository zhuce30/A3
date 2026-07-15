from __future__ import annotations

from django.urls import path

from backend.apps.knowledge_base import views


urlpatterns = [
    path("library/", views.curated_library, name="knowledge-base-curated-library"),
    path("library/<str:resource_code>/", views.curated_library_detail, name="knowledge-base-curated-library-detail"),
    path("library/<str:resource_code>/preview/", views.curated_library_preview, name="knowledge-base-curated-library-preview"),
    path("library/<str:resource_code>/content/", views.curated_library_content, name="knowledge-base-curated-library-content"),
    path("graph/", views.material_graph, name="knowledge-base-material-graph"),
    path("resources/", views.resources, name="knowledge-base-resources"),
    path("resources/upload/", views.upload, name="knowledge-base-upload"),
    path("resources/<uuid:resource_id>/", views.resource_detail, name="knowledge-base-resource-detail"),
    path("resources/<uuid:resource_id>/parse/", views.resource_parse_detail, name="knowledge-base-resource-parse-detail"),
    path("resources/<uuid:resource_id>/reparse/", views.resource_reparse, name="knowledge-base-resource-reparse"),
    path("resources/<uuid:resource_id>/wiki/rebuild/", views.resource_wiki_rebuild, name="knowledge-base-resource-wiki-rebuild"),
    path("resources/<uuid:resource_id>/download/", views.download, name="knowledge-base-download"),
    path("assets/<uuid:asset_id>/preview/", views.asset_preview, name="knowledge-base-asset-preview"),
    path("wiki/rebuild/", views.wiki_rebuild_resources, name="knowledge-base-wiki-rebuild"),
    path("reset/", views.reset, name="knowledge-base-reset"),
    path("reparse/force/", views.force_reparse_resources, name="knowledge-base-force-reparse"),
    path("jobs/", views.jobs, name="knowledge-base-jobs"),
    path("jobs/<uuid:job_id>/", views.job_detail, name="knowledge-base-job-detail"),
    path("jobs/<uuid:job_id>/retry/", views.retry_job, name="knowledge-base-job-retry"),
    path("rebuild/", views.rebuild, name="knowledge-base-rebuild"),
    path("search/", views.search, name="knowledge-base-search"),
]
