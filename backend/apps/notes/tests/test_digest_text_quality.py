from pathlib import Path

from django.conf import settings
from django.test import SimpleTestCase


class DigestTextQualityTests(SimpleTestCase):
    def test_task_12_sources_contain_no_common_mojibake(self) -> None:
        root = Path(settings.BASE_DIR).parent
        files = (
            "backend/apps/notes/migrations/0001_initial.py",
            "backend/apps/notes/models.py",
            "backend/apps/notes/services/attachment_service.py",
            "backend/apps/notes/services/digest_service.py",
            "backend/apps/notes/tasks.py",
            "backend/apps/notes/urls.py",
            "backend/apps/notes/views_digests.py",
            "backend/apps/notes/tests/test_digest_text_quality.py",
            "backend/apps/notes/tests/test_digests.py",
            "backend/config/settings.py",
            "OpenMAIC/components/a3/notes/note-digest-view.tsx",
            "OpenMAIC/components/a3/notes/notes-workspace.tsx",
            "OpenMAIC/lib/a3/notes/client.ts",
            "OpenMAIC/lib/a3/notes/types.ts",
            "OpenMAIC/tests/a3-personal-notes-digests.test.tsx",
            "OpenMAIC/tests/a3-personal-notes-model.test.ts",
        )
        forbidden_codepoints = (
            (0xFFFD,),
            (0x951B,),
            (0x9286,),
            (0x9225,),
            (0x7ED7, 0x65C7, 0x8BB0),
            (0x59E3, 0x5FD4, 0x68E9),
            (0x9422, 0x71B8, 0x579A),
            (0x7487, 0x70FD, 0x5678, 0x7487),
        )
        forbidden = tuple("".join(chr(value) for value in values) for values in forbidden_codepoints)

        for relative_path in files:
            text = (root / relative_path).read_text(encoding="utf-8")
            for pattern in forbidden:
                with self.subTest(file=relative_path, pattern=pattern):
                    self.assertNotIn(pattern, text)
