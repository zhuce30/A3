from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings

from backend.apps.knowledge_base.docx_preview import (
    DocxPreviewSourceUnavailable,
    DocxPreviewUnavailable,
    DocxPreviewUnsupported,
    get_or_create_docx_preview,
)


def preview_resource(source_path: Path, *, content_hash: str = "abc123"):
    return SimpleNamespace(
        resource_code="OS-DOC-TEST",
        content_hash=content_hash,
        knowledge_resource=SimpleNamespace(stored_path=str(source_path)),
    )


class DocxPreviewConversionTests(SimpleTestCase):
    def test_converts_managed_docx_once_and_reuses_persistent_cache(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "managed.docx"
            source.write_bytes(b"docx-content")
            resource = preview_resource(source)

            def convert(command, **_kwargs):
                output_dir = Path(command[command.index("--outdir") + 1])
                converted_source = Path(command[-1])
                (output_dir / f"{converted_source.stem}.pdf").write_bytes(b"%PDF-1.4\npreview")
                return subprocess.CompletedProcess(command, 0)

            with override_settings(
                KNOWLEDGE_UPLOAD_ROOT=root / "uploads",
                KNOWLEDGE_UPLOAD_MAX_BYTES=1024,
                A3_SOFFICE_PATH="soffice-test",
                A3_DOCX_PREVIEW_TIMEOUT_SECONDS=9,
            ), patch("backend.apps.knowledge_base.docx_preview.subprocess.run", side_effect=convert) as run:
                first = get_or_create_docx_preview(resource)
                second = get_or_create_docx_preview(resource)
                self.assertEqual(first, second)
                self.assertEqual(first.name, "OS-DOC-TEST-abc123.pdf")
                self.assertEqual(first.parent, (root / "uploads" / "previews" / "curated").resolve())
                self.assertEqual(first.read_bytes(), b"%PDF-1.4\npreview")
                self.assertEqual(run.call_count, 1)
                self.assertEqual(run.call_args.kwargs["timeout"], 9)
                self.assertEqual(run.call_args.args[0][0], "soffice-test")

    def test_rejects_non_docx_sources(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "managed.pdf"
            source.write_bytes(b"%PDF")

            with self.assertRaises(DocxPreviewUnsupported):
                get_or_create_docx_preview(preview_resource(source))

    def test_reports_missing_source_without_exposing_its_path(self):
        source = Path("/private/managed/missing.docx")

        with self.assertRaises(DocxPreviewSourceUnavailable) as raised:
            get_or_create_docx_preview(preview_resource(source))

        self.assertNotIn(str(source), str(raised.exception))

    def test_rejects_sources_over_the_knowledge_upload_limit(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "managed.docx"
            source.write_bytes(b"too-large")

            with override_settings(KNOWLEDGE_UPLOAD_MAX_BYTES=4):
                with self.assertRaises(DocxPreviewUnavailable):
                    get_or_create_docx_preview(preview_resource(source))

    def test_reports_missing_libreoffice_with_a_generic_error(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "managed.docx"
            source.write_bytes(b"docx-content")

            with override_settings(KNOWLEDGE_UPLOAD_ROOT=root / "uploads"), patch(
                "backend.apps.knowledge_base.docx_preview.subprocess.run",
                side_effect=FileNotFoundError("/secret/soffice"),
            ):
                with self.assertRaises(DocxPreviewUnavailable) as raised:
                    get_or_create_docx_preview(preview_resource(source))

        self.assertNotIn("/secret/soffice", str(raised.exception))

    def test_reports_conversion_timeout_and_invalid_output(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "managed.docx"
            source.write_bytes(b"docx-content")
            resource = preview_resource(source)

            with override_settings(KNOWLEDGE_UPLOAD_ROOT=root / "uploads"), patch(
                "backend.apps.knowledge_base.docx_preview.subprocess.run",
                side_effect=subprocess.TimeoutExpired("soffice", 30),
            ):
                with self.assertRaises(DocxPreviewUnavailable):
                    get_or_create_docx_preview(resource)

            def invalid_pdf(command, **_kwargs):
                output_dir = Path(command[command.index("--outdir") + 1])
                converted_source = Path(command[-1])
                (output_dir / f"{converted_source.stem}.pdf").write_bytes(b"not-a-pdf")
                return subprocess.CompletedProcess(command, 0)

            with override_settings(KNOWLEDGE_UPLOAD_ROOT=root / "uploads"), patch(
                "backend.apps.knowledge_base.docx_preview.subprocess.run",
                side_effect=invalid_pdf,
            ):
                with self.assertRaises(DocxPreviewUnavailable):
                    get_or_create_docx_preview(resource)
