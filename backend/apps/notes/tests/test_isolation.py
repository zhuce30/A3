from __future__ import annotations

import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from django.test import SimpleTestCase


REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
SOURCE_SUFFIXES = {".py", ".ts", ".tsx"}
EXCLUDED_PARTS = {
    ".next",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "docs",
    "e2e",
    "generated",
    "migrations",
    "node_modules",
    "tests",
    "vendor",
}


@dataclass(frozen=True)
class ForbiddenReference:
    name: str
    pattern: re.Pattern[str]


FORBIDDEN_REFERENCES = (
    ForbiddenReference(
        "notes backend dependency",
        re.compile(r"\bbackend\.apps\.notes\b|\bfrom\s+backend\.apps\s+import\s+notes\b"),
    ),
    ForbiddenReference("NoteMemory model", re.compile(r"\bNoteMemory\b")),
    ForbiddenReference(
        "notes memory endpoint",
        re.compile(
            r"(?:/api/(?:a3/)?notes/(?:memory|memories)\b|/api/(?:a3/)?notes-memory\b|\bnotes[_-]memory\b)",
            re.IGNORECASE,
        ),
    ),
    ForbiddenReference(
        "personal notes memory control",
        re.compile(
            r"(?:个人笔记记忆|笔记记忆|使用个人笔记(?:作为)?记忆|personal\s+notes?\s+memory)",
            re.IGNORECASE,
        ),
    ),
)


def _tracked_source_paths(root: Path = REPOSITORY_ROOT) -> list[PurePosixPath]:
    result = subprocess.run(
        ["git", "ls-files", "-z", "--", "*.py", "*.ts", "*.tsx"],
        cwd=root,
        check=True,
        capture_output=True,
    )
    return [
        PurePosixPath(raw.decode("utf-8"))
        for raw in result.stdout.split(b"\0")
        if raw
    ]


def _is_product_source(path: PurePosixPath) -> bool:
    if path.suffix not in SOURCE_SUFFIXES or any(part in EXCLUDED_PARTS for part in path.parts):
        return False
    if path.parts[:3] == ("backend", "apps", "learning"):
        return True
    if path.parts[:2] != ("OpenMAIC", "app") and path.parts[:2] != ("OpenMAIC", "components") and path.parts[:2] != ("OpenMAIC", "lib"):
        return False
    if "a3" not in path.parts:
        return False
    product_name = path.stem.lower().startswith(("classroom", "coaching"))
    return "classroom" in path.parts or "coaching" in path.parts or product_name


def _scan_file(path: Path) -> list[tuple[int, str]]:
    findings: list[tuple[int, str]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        for reference in FORBIDDEN_REFERENCES:
            if reference.pattern.search(line):
                findings.append((line_number, reference.name))
    return findings


class PersonalNoteAiIsolationTests(SimpleTestCase):
    def test_product_path_selection_is_structured(self) -> None:
        accepted = (
            "backend/apps/learning/views.py",
            "OpenMAIC/app/a3/classroom/page.tsx",
            "OpenMAIC/components/a3/coaching-panel.tsx",
            "OpenMAIC/lib/a3/classroom-types.ts",
        )
        rejected = (
            "backend/apps/notes/services/assistant_service.py",
            "backend/apps/learning/tests/test_notes.py",
            "OpenMAIC/e2e/tests/a3-classroom-note.spec.ts",
            "OpenMAIC/docs/classroom-notes.ts",
            "OpenMAIC/node_modules/classroom/index.ts",
            "OpenMAIC/.next/generated/coaching.ts",
        )
        self.assertTrue(all(_is_product_source(PurePosixPath(path)) for path in accepted))
        self.assertFalse(any(_is_product_source(PurePosixPath(path)) for path in rejected))

    def test_synthetic_forbidden_product_reference_is_detected(self) -> None:
        synthetic_path = PurePosixPath("OpenMAIC/app/a3/classroom/synthetic.ts")
        self.assertTrue(_is_product_source(synthetic_path))
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "synthetic.ts"
            source.write_text(
                "import { NoteMemory } from 'backend.apps.notes';\n"
                "fetch('/api/a3/notes/memory/');\n",
                encoding="utf-8",
            )
            findings = _scan_file(source)
        self.assertEqual(
            {rule for _, rule in findings},
            {"notes backend dependency", "NoteMemory model", "notes memory endpoint"},
        )

    def test_learning_classroom_and_coaching_do_not_depend_on_personal_note_memory(self) -> None:
        candidates = [path for path in _tracked_source_paths() if _is_product_source(path)]
        self.assertTrue(candidates, "No tracked learning/classroom/coaching production sources were found")
        violations = [
            f"{path.as_posix()}:{line_number}: {rule}"
            for path in candidates
            for line_number, rule in _scan_file(REPOSITORY_ROOT.joinpath(*path.parts))
        ]
        self.assertEqual(
            violations,
            [],
            "Personal note AI must remain one-way isolated from learning/classroom/coaching:\n"
            + "\n".join(violations),
        )
