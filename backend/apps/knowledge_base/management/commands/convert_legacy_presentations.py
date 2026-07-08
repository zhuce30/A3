from __future__ import annotations

from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from backend.core.settings import DATA_ROOT, METADATA_DIR
from backend.scripts.convert_legacy_presentations import convert_legacy_presentations, write_report


class Command(BaseCommand):
    help = "Convert legacy .ppt files to .pptx before knowledge-base indexing."

    def add_arguments(self, parser):
        parser.add_argument("--source-root", type=Path, default=DATA_ROOT / "PPT")
        parser.add_argument("--force", action="store_true")
        parser.add_argument("--strict", action="store_true")
        parser.add_argument("--limit", type=int, default=None)
        parser.add_argument("--report-path", type=Path, default=METADATA_DIR / "ppt_conversion_report.json")

    def handle(self, *args, **options):
        report = convert_legacy_presentations(
            source_root=options["source_root"],
            force=options["force"],
            limit=options["limit"],
        )
        write_report(report, options["report_path"])

        self.stdout.write(self.style.SUCCESS("Legacy presentation conversion finished."))
        self.stdout.write(f"source_root: {report['source_root']}")
        self.stdout.write(f"total_candidates: {report['total_candidates']}")
        self.stdout.write(f"converted: {len(report['converted'])}")
        self.stdout.write(f"skipped: {len(report['skipped'])}")
        self.stdout.write(f"failed: {len(report['failed'])}")
        self.stdout.write(f"report_path: {options['report_path'].resolve()}")

        if options["strict"] and report["failed"]:
            raise CommandError("Some legacy presentations failed to convert.")
