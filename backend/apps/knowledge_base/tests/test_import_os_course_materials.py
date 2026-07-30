from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase, override_settings

from backend.apps.accounts.models import UserRole
from backend.apps.knowledge_base.models import KnowledgeResource, ResourceStatus


class ImportOsCourseMaterialsTests(TestCase):
    def setUp(self):
        self.teacher = get_user_model().objects.create_user(
            phone="13800139001",
            password="Demo@123456",
            role=UserRole.TEACHER,
        )

    @patch("backend.apps.knowledge_base.services.create_upload_index_job")
    @patch(
        "backend.apps.knowledge_base.management.commands.import_os_course_materials._repair_default_course_catalog",
        return_value=SimpleNamespace(code="OS-001"),
    )
    def test_import_enqueues_new_course_materials_for_indexing(self, _repair_course, create_index_job):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_dir = root / "source"
            upload_dir = root / "uploads"
            source_dir.mkdir()
            (source_dir / "3-deadlock.pptx").write_bytes(b"pptx fixture")

            with override_settings(KNOWLEDGE_UPLOAD_ROOT=upload_dir):
                call_command(
                    "import_os_course_materials",
                    "--source-dir",
                    str(source_dir),
                    "--owner-phone",
                    self.teacher.phone,
                    stdout=StringIO(),
                )

        resource = KnowledgeResource.objects.get(owner=self.teacher)
        create_index_job.assert_called_once()
        self.assertEqual(create_index_job.call_args.args[0], self.teacher)
        self.assertEqual(create_index_job.call_args.args[1], [resource])

    @patch("backend.apps.knowledge_base.services.create_upload_index_job")
    @patch(
        "backend.apps.knowledge_base.management.commands.import_os_course_materials._repair_default_course_catalog",
        return_value=SimpleNamespace(code="OS-001"),
    )
    def test_import_does_not_requeue_unchanged_indexed_materials(self, _repair_course, create_index_job):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_dir = root / "source"
            upload_dir = root / "uploads"
            source_dir.mkdir()
            (source_dir / "3-deadlock.pptx").write_bytes(b"pptx fixture")

            with override_settings(KNOWLEDGE_UPLOAD_ROOT=upload_dir):
                call_command(
                    "import_os_course_materials",
                    "--source-dir",
                    str(source_dir),
                    "--owner-phone",
                    self.teacher.phone,
                    stdout=StringIO(),
                )
                resource = KnowledgeResource.objects.get(owner=self.teacher)
                resource.status = ResourceStatus.INDEXED
                resource.save(update_fields=["status", "updated_at"])
                create_index_job.reset_mock()

                call_command(
                    "import_os_course_materials",
                    "--source-dir",
                    str(source_dir),
                    "--owner-phone",
                    self.teacher.phone,
                    stdout=StringIO(),
                )

        create_index_job.assert_not_called()

    @patch("backend.apps.knowledge_base.services.create_upload_index_job")
    @patch(
        "backend.apps.knowledge_base.management.commands.import_os_course_materials._repair_default_course_catalog",
        return_value=SimpleNamespace(code="OS-001"),
    )
    def test_import_requeues_indexed_material_when_file_changes(self, _repair_course, create_index_job):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_dir = root / "source"
            upload_dir = root / "uploads"
            source_dir.mkdir()
            source_path = source_dir / "3-deadlock.pptx"
            source_path.write_bytes(b"pptx fixture")

            with override_settings(KNOWLEDGE_UPLOAD_ROOT=upload_dir):
                call_command(
                    "import_os_course_materials",
                    "--source-dir",
                    str(source_dir),
                    "--owner-phone",
                    self.teacher.phone,
                    stdout=StringIO(),
                )
                resource = KnowledgeResource.objects.get(owner=self.teacher)
                resource.status = ResourceStatus.INDEXED
                resource.save(update_fields=["status", "updated_at"])
                source_path.write_bytes(b"updated pptx fixture")
                create_index_job.reset_mock()

                call_command(
                    "import_os_course_materials",
                    "--source-dir",
                    str(source_dir),
                    "--owner-phone",
                    self.teacher.phone,
                    stdout=StringIO(),
                )

        create_index_job.assert_called_once()
        self.assertEqual(create_index_job.call_args.args[1], [resource])
