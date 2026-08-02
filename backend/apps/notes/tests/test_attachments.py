from __future__ import annotations

import io
import json
import socket
import tempfile
import uuid
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests
from celery.exceptions import SoftTimeLimitExceeded
from django.contrib.auth import get_user_model
from django.conf import settings as django_settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import reverse

from backend.apps.notes.models import Note, NoteAttachment


EMPTY_DOC = {"type": "doc", "content": []}


class NotesStorageSettingsTests(SimpleTestCase):
    def test_unset_and_blank_storage_root_use_backend_default(self) -> None:
        from backend.config.settings import resolve_path_setting

        expected = (django_settings.BASE_DIR / "tmp" / "a3-notes").resolve()
        with patch.dict("os.environ", {}, clear=False):
            with patch("os.getenv", return_value=None):
                self.assertEqual(resolve_path_setting("A3_NOTES_STORAGE_ROOT", expected), expected)
            with patch("os.getenv", return_value="   "):
                self.assertEqual(resolve_path_setting("A3_NOTES_STORAGE_ROOT", expected), expected)

    def test_relative_storage_root_is_resolved_from_backend_base_dir(self) -> None:
        from backend.config.settings import resolve_path_setting

        with patch("os.getenv", return_value="tmp/a3-notes"):
            resolved = resolve_path_setting("A3_NOTES_STORAGE_ROOT", django_settings.BASE_DIR / "unused")

        self.assertEqual(resolved, (django_settings.BASE_DIR / "tmp" / "a3-notes").resolve())
        env_example = (django_settings.BASE_DIR / ".env.example").read_text(encoding="utf-8")
        self.assertIn("A3_NOTES_STORAGE_ROOT=tmp/a3-notes", env_example)


def docx_bytes(text: str = "attachment text", *, extra_entries: dict[str, bytes] | None = None) -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", b"""<?xml version="1.0"?>
            <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
              <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
              <Default Extension="xml" ContentType="application/xml"/>
              <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
            </Types>""")
        archive.writestr("_rels/.rels", b"""<?xml version="1.0"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
              <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
            </Relationships>""")
        archive.writestr("word/document.xml", f"""<?xml version="1.0" encoding="UTF-8"?>
            <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
              <w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body>
            </w:document>""".encode())
        for name, value in (extra_entries or {}).items():
            archive.writestr(name, value)
    return stream.getvalue()


@override_settings(
    A3_NOTES_ATTACHMENT_MAX_BYTES=1024 * 1024,
    A3_NOTES_USER_QUOTA_BYTES=2 * 1024 * 1024,
    A3_NOTES_EXTRACTED_TEXT_MAX_CHARS=10_000,
)
class AttachmentTestCase(TestCase):
    def setUp(self) -> None:
        temp_root = Path(__file__).resolve().parents[3] / "tmp" / "note-attachment-tests"
        temp_root.mkdir(parents=True, exist_ok=True)
        self.storage = tempfile.TemporaryDirectory(dir=temp_root)
        self.addCleanup(self.storage.cleanup)
        self.settings_override = override_settings(A3_NOTES_STORAGE_ROOT=Path(self.storage.name))
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)
        user_model = get_user_model()
        self.user = user_model.objects.create_user(phone="13800003001", password="test-password")
        self.other_user = user_model.objects.create_user(phone="13800003002", password="test-password")
        self.note = Note.objects.create(user=self.user, title="附件笔记", content_json=EMPTY_DOC)
        self.client.force_login(self.user)

    def upload(self, name: str, content: bytes, content_type: str):
        return self.client.post(
            reverse("notes:attachment-upload", args=[self.note.id]),
            {"file": SimpleUploadedFile(name, content, content_type=content_type)},
        )

    def create_attachment(self, **overrides) -> NoteAttachment:
        attachment_id = overrides.pop("id", uuid.uuid4())
        relative = f"{self.user.id}/{self.note.id}/{attachment_id}/notes.txt"
        values = {
            "id": attachment_id,
            "user": self.user,
            "note": self.note,
            "kind": NoteAttachment.Kind.FILE,
            "display_name": "notes.txt",
            "relative_path": relative,
            "mime_type": "text/plain",
            "size_bytes": 5,
            "sha256": "0" * 64,
        }
        values.update(overrides)
        attachment = NoteAttachment.objects.create(**values)
        if attachment.relative_path:
            path = Path(self.storage.name) / attachment.relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"hello")
        return attachment


class UploadSecurityTests(AttachmentTestCase):
    @patch("backend.apps.notes.views_attachments.enqueue_attachment_parse")
    def test_upload_stores_normalized_relative_path_and_enqueues_once(self, enqueue) -> None:
        enqueue.side_effect = lambda attachment: attachment
        response = self.upload(" lecture.MD ", b"# Safe notes\n", "text/markdown")

        self.assertEqual(response.status_code, 201)
        attachment = NoteAttachment.objects.get()
        self.assertFalse(Path(attachment.relative_path).is_absolute())
        self.assertNotIn("..", attachment.relative_path.split("/"))
        path_parts = Path(attachment.relative_path).parts
        self.assertEqual(uuid.UUID(path_parts[0]).version, 5)
        self.assertEqual(path_parts[1:3], (str(self.note.id), str(attachment.id)))
        self.assertTrue((Path(self.storage.name) / attachment.relative_path).is_file())
        self.assertNotIn(str(Path(self.storage.name).resolve()), json.dumps(response.json()))
        enqueue.assert_called_once()
        self.assertEqual(enqueue.call_args.args[0].id, attachment.id)

    def test_upload_rejects_mime_mismatch(self) -> None:
        response = self.upload("notes.txt", b"plain text", "image/png")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "attachment_mime_mismatch")

    def test_upload_rejects_signature_mismatch(self) -> None:
        response = self.upload("image.png", b"not a png", "image/png")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "attachment_signature_mismatch")

    def test_upload_rejects_executable_and_macro_office(self) -> None:
        executable = self.upload("notes.txt", b"MZ" + b"\0" * 40, "text/plain")
        macro = self.upload("notes.docx", docx_bytes(extra_entries={"word/vbaProject.bin": b"macro"}), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        self.assertEqual(executable.json()["code"], "unsafe_attachment_content")
        self.assertEqual(macro.json()["code"], "unsafe_office_document")

    def test_upload_rejects_path_traversal_and_control_names(self) -> None:
        from backend.apps.notes.services.attachment_service import (
            AttachmentServiceError,
            validate_attachment_filename,
        )

        for name in ("../notes.txt", "bad\x00name.txt", "bad\x01name.txt"):
            with self.subTest(name=repr(name)):
                with self.assertRaises(AttachmentServiceError) as raised:
                    validate_attachment_filename(name)
                self.assertEqual(raised.exception.code, "invalid_attachment_name")

    @override_settings(A3_NOTES_ATTACHMENT_MAX_BYTES=3)
    def test_upload_rejects_oversize(self) -> None:
        response = self.upload("notes.txt", b"four", "text/plain")
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["code"], "attachment_too_large")

    @override_settings(A3_NOTES_USER_QUOTA_BYTES=8)
    def test_upload_rejects_quota_overflow(self) -> None:
        self.create_attachment(size_bytes=5)
        response = self.upload("more.txt", b"four", "text/plain")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "attachment_quota_exceeded")

    def test_upload_rejects_more_than_thirty_active_attachments(self) -> None:
        NoteAttachment.objects.bulk_create([
            NoteAttachment(
                id=uuid.uuid4(), user=self.user, note=self.note, kind=NoteAttachment.Kind.LINK,
                display_name=f"link-{index}", source_url=f"https://example.com/{index}", parse_status=NoteAttachment.ParseStatus.SUCCEEDED,
            )
            for index in range(30)
        ])
        response = self.upload("notes.txt", b"text", "text/plain")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "attachment_count_exceeded")

    @override_settings(A3_NOTES_ATTACHMENT_MAX_BYTES=200_000)
    def test_upload_rejects_zip_decompression_bomb(self) -> None:
        response = self.upload(
            "bomb.docx",
            docx_bytes(extra_entries={"word/huge.xml": b"x" * 3_000_000}),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "unsafe_office_document")


class AttachmentRouteTests(AttachmentTestCase):
    def test_download_requires_authentication_and_owner(self) -> None:
        attachment = self.create_attachment()
        url = reverse("notes:attachment-download", args=[attachment.id])
        self.client.logout()
        self.assertEqual(self.client.get(url).status_code, 401)
        self.client.force_login(self.other_user)
        self.assertEqual(self.client.get(url).status_code, 404)

    def test_authenticated_download_is_streamed_with_safe_disposition(self) -> None:
        attachment = self.create_attachment(display_name='bad"\r\nname.txt')
        response = self.client.get(reverse("notes:attachment-download", args=[attachment.id]))
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.streaming)
        self.assertEqual(b"".join(response.streaming_content), b"hello")
        self.assertNotIn("\r", response["Content-Disposition"])
        self.assertNotIn("\n", response["Content-Disposition"])
        self.assertNotIn(str(Path(self.storage.name).resolve()), response["Content-Disposition"])

    def test_missing_deleted_and_foreign_attachments_are_404(self) -> None:
        own = self.create_attachment(deleted_at="2026-08-02T00:00:00Z")
        foreign_note = Note.objects.create(user=self.other_user, title="foreign", content_json=EMPTY_DOC)
        foreign = NoteAttachment.objects.create(
            user=self.other_user, note=foreign_note, kind=NoteAttachment.Kind.LINK,
            display_name="foreign", source_url="https://example.com", parse_status=NoteAttachment.ParseStatus.SUCCEEDED,
        )
        for attachment_id in (own.id, foreign.id, uuid.uuid4()):
            with self.subTest(attachment_id=attachment_id):
                self.assertEqual(self.client.get(reverse("notes:attachment-download", args=[attachment_id])).status_code, 404)

    @patch("backend.apps.notes.views_attachments.enqueue_attachment_parse")
    def test_reparse_resets_status_and_enqueues_exactly_once(self, enqueue) -> None:
        enqueue.side_effect = lambda attachment: attachment
        attachment = self.create_attachment(
            parse_status=NoteAttachment.ParseStatus.FAILED,
            extracted_text="old", error_code="parse_failed", error_message="old failure",
        )
        response = self.client.post(reverse("notes:attachment-reparse", args=[attachment.id]))
        attachment.refresh_from_db()
        self.assertEqual(response.status_code, 202)
        self.assertEqual(attachment.parse_status, NoteAttachment.ParseStatus.PENDING)
        self.assertEqual(attachment.extracted_text, "")
        self.assertEqual(attachment.error_code, "")
        self.assertEqual(attachment.parse_generation, 2)
        enqueue.assert_called_once()

    def test_delete_is_soft_and_does_not_remove_physical_file(self) -> None:
        attachment = self.create_attachment()
        path = Path(self.storage.name) / attachment.relative_path
        response = self.client.delete(reverse("notes:attachment-detail", args=[attachment.id]))
        attachment.refresh_from_db()
        self.assertEqual(response.status_code, 200)
        self.assertIsNotNone(attachment.deleted_at)
        self.assertTrue(path.exists())


class ParserTaskTests(AttachmentTestCase):
    def test_parser_success_persists_bounded_text_without_kb_records(self) -> None:
        from backend.apps.knowledge_base.models import KnowledgeResource
        from backend.apps.notes.tasks import parse_attachment_task

        attachment = self.create_attachment(display_name="notes.txt", mime_type="text/plain")
        (Path(self.storage.name) / attachment.relative_path).write_text("abcdefghijk", encoding="utf-8")
        before = KnowledgeResource.objects.count()
        with override_settings(A3_NOTES_EXTRACTED_TEXT_MAX_CHARS=5):
            result = parse_attachment_task(str(attachment.id), attachment.parse_generation)
        attachment.refresh_from_db()
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(attachment.extracted_text, "abcde")
        self.assertEqual(attachment.parse_status, NoteAttachment.ParseStatus.SUCCEEDED)
        self.assertEqual(KnowledgeResource.objects.count(), before)

    @patch("backend.domains.knowledge_base.attachment_text_parser.parse_attachment_text")
    def test_persisted_mime_selects_parser_even_when_extension_changes(self, parser) -> None:
        from backend.apps.notes.services.attachment_service import extract_attachment_text

        parser.return_value = SimpleNamespace(
            text="parsed as PDF",
            metadata={"parser": "attachment_safe_pdf"},
        )
        attachment = self.create_attachment(display_name="misleading.txt", mime_type="application/pdf")

        text, metadata = extract_attachment_text(attachment)

        self.assertEqual(text, "parsed as PDF")
        self.assertEqual(metadata["parser"], "attachment_safe_pdf")
        parser.assert_called_once()

    @patch("backend.domains.knowledge_base.attachment_text_parser.parse_attachment_text")
    def test_xlsx_reuses_knowledge_base_pure_parser(self, parser) -> None:
        from backend.apps.notes.services.attachment_service import extract_attachment_text

        attachment_id = uuid.uuid4()
        relative_path = f"{self.user.id}/{self.note.id}/{attachment_id}/sheet.xlsx"
        parser.return_value = SimpleNamespace(
            text="sheet cells",
            metadata={"parser": "attachment_safe_xlsx"},
        )
        attachment = self.create_attachment(
            id=attachment_id,
            display_name="sheet.xlsx",
            relative_path=relative_path,
            mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )

        text, metadata = extract_attachment_text(attachment)

        self.assertEqual(text, "sheet cells")
        self.assertEqual(metadata["parser"], "attachment_safe_xlsx")
        parser.assert_called_once()

    @patch("backend.apps.notes.services.attachment_service.extract_attachment_text", side_effect=ValueError("secret C:\\private\\file"))
    def test_parser_failure_is_readable_and_does_not_leak_paths(self, _extract) -> None:
        from backend.apps.notes.tasks import parse_attachment_task

        attachment = self.create_attachment()
        result = parse_attachment_task(str(attachment.id), attachment.parse_generation)
        attachment.refresh_from_db()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(attachment.error_code, "attachment_parse_failed")
        self.assertEqual(attachment.error_message, "附件解析失败，请稍后重试")
        self.assertNotIn("private", attachment.error_message)

    @patch("backend.apps.notes.services.attachment_service.extract_attachment_text", side_effect=SoftTimeLimitExceeded())
    def test_parser_timeout_is_persisted(self, _extract) -> None:
        from backend.apps.notes.tasks import parse_attachment_task

        attachment = self.create_attachment()
        result = parse_attachment_task(str(attachment.id), attachment.parse_generation)
        attachment.refresh_from_db()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(attachment.error_code, "attachment_parse_timeout")
        self.assertEqual(attachment.error_message, "附件解析超时，请稍后重试")

    def test_parser_is_idempotent_for_missing_deleted_and_succeeded(self) -> None:
        from backend.apps.notes.tasks import parse_attachment_task

        succeeded = self.create_attachment(parse_status=NoteAttachment.ParseStatus.SUCCEEDED)
        deleted = self.create_attachment(id=uuid.uuid4(), deleted_at="2026-08-02T00:00:00Z")
        for attachment_id in (uuid.uuid4(), succeeded.id, deleted.id):
            with self.subTest(attachment_id=attachment_id):
                self.assertTrue(parse_attachment_task(str(attachment_id), 1)["skipped"])


class LinkSsrfTests(AttachmentTestCase):
    @staticmethod
    def response(*, peer="93.184.216.34", status=200, headers=None, chunks=None):
        response = Mock(status_code=status, headers=headers or {"Content-Type": "text/html"})
        response.iter_content.return_value = chunks if chunks is not None else [b"safe body"]
        sock = Mock()
        sock.getpeername.return_value = (peer, 443)
        response.raw = SimpleNamespace(_connection=SimpleNamespace(sock=sock))
        return response

    def post_link(self, url: str):
        return self.client.post(
            reverse("notes:attachment-link", args=[self.note.id]),
            data=json.dumps({"url": url, "displayName": "reference"}),
            content_type="application/json",
        )

    @patch("backend.apps.notes.services.link_fetcher.socket.getaddrinfo")
    def test_link_rejects_ipv4_ipv6_and_metadata_destinations(self, getaddrinfo) -> None:
        for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1", "fe80::1"):
            getaddrinfo.return_value = [(socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]
            with self.subTest(address=address):
                response = self.post_link("https://example.test/link")
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["code"], "unsafe_note_link")

    def test_link_rejects_non_http_and_embedded_credentials(self) -> None:
        for url in ("file:///etc/passwd", "ftp://example.com/file", "https://user:pass@example.com/file"):
            with self.subTest(url=url):
                response = self.post_link(url)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["code"], "unsafe_note_link")

    @patch("backend.apps.notes.services.link_fetcher.requests.Session")
    @patch("backend.apps.notes.services.link_fetcher.socket.getaddrinfo")
    def test_link_rejects_private_redirect_target(self, getaddrinfo, session_factory) -> None:
        getaddrinfo.side_effect = [
            [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))],
            [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.169.254", 80))],
        ]
        session = session_factory.return_value
        session.get.return_value = self.response(
            status=302,
            headers={"Location": "http://169.254.169.254/latest/meta-data"},
        )
        response = self.post_link("https://example.test/link")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "unsafe_note_link")
        session.get.assert_called_once()
        self.assertFalse(session.get.call_args.kwargs["allow_redirects"])

    @patch("backend.apps.notes.services.link_fetcher.requests.Session")
    @patch("backend.apps.notes.services.link_fetcher.socket.getaddrinfo")
    def test_link_revalidates_dns_each_redirect_and_limits_body(self, getaddrinfo, session_factory) -> None:
        getaddrinfo.return_value = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
        first = self.response(status=302, headers={"Location": "/final"})
        second = self.response(status=200, headers={"Content-Length": str(2 * 1024 * 1024 + 1)})
        session = session_factory.return_value
        session.get.side_effect = [first, second]
        response = self.post_link("https://example.test/start")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "note_link_too_large")
        self.assertEqual(getaddrinfo.call_count, 2)
        self.assertEqual(session.get.call_count, 2)

    @patch("backend.apps.notes.services.link_fetcher.requests.Session")
    @patch("backend.apps.notes.services.link_fetcher.socket.getaddrinfo")
    def test_link_stream_timeout_returns_stable_error(self, getaddrinfo, session_factory) -> None:
        getaddrinfo.return_value = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
        response_mock = self.response()
        response_mock.iter_content.side_effect = requests.Timeout("stream timeout")
        session_factory.return_value.get.return_value = response_mock

        response = self.post_link("https://example.test/reference")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "note_link_unavailable")

    @patch("backend.apps.notes.views_attachments.enqueue_attachment_parse")
    @patch("backend.apps.notes.services.link_fetcher.requests.Session")
    @patch("backend.apps.notes.services.link_fetcher.socket.getaddrinfo")
    def test_safe_link_is_created_without_duplicate_enqueue(self, getaddrinfo, session_factory, enqueue) -> None:
        getaddrinfo.return_value = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
        response_mock = self.response(
            headers={"Content-Length": "19", "Content-Type": "text/html"},
            chunks=[b"<p>hello world!</p>"],
        )
        session_factory.return_value.get.return_value = response_mock
        response = self.post_link("https://example.test/reference")
        self.assertEqual(response.status_code, 201)
        attachment = NoteAttachment.objects.get()
        self.assertEqual(attachment.kind, NoteAttachment.Kind.LINK)
        self.assertEqual(attachment.source_url, "https://example.test/reference")
        self.assertEqual(attachment.relative_path, "")
        self.assertEqual(attachment.parse_status, NoteAttachment.ParseStatus.SUCCEEDED)
        self.assertEqual(attachment.extracted_text, "hello world!")
        enqueue.assert_not_called()
