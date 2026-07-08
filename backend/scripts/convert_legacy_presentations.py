from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from backend.core.settings import DATA_ROOT, METADATA_DIR

if sys.platform != "win32":
    raise RuntimeError("PowerPoint COM conversion is only available on Windows.")

try:
    import pythoncom
    import win32com.client
except ImportError as exc:
    raise RuntimeError("pywin32 is required. Run: pip install pywin32") from exc


PPTX_FORMAT = 24  # ppSaveAsOpenXMLPresentation
ALERTS_NONE = 1  # ppAlertsNone


def convert_legacy_presentations(
    source_root: Path,
    force: bool = False,
    limit: int | None = None,
) -> dict:
    source_root = source_root.resolve()
    ppt_files = sorted(path for path in source_root.rglob("*.ppt") if path.suffix.lower() == ".ppt")
    if limit:
        ppt_files = ppt_files[:limit]

    report = {
        "source_root": str(source_root),
        "total_candidates": len(ppt_files),
        "converted": [],
        "skipped": [],
        "failed": [],
    }

    if not ppt_files:
        return report

    pythoncom.CoInitialize()
    powerpoint = None
    try:
        powerpoint = win32com.client.DispatchEx("PowerPoint.Application")
        powerpoint.DisplayAlerts = ALERTS_NONE

        for ppt_path in ppt_files:
            pptx_path = ppt_path.with_suffix(".pptx")
            if pptx_path.exists() and not force:
                report["skipped"].append(
                    {
                        "source": str(ppt_path),
                        "target": str(pptx_path),
                        "reason": "target_exists",
                    }
                )
                continue

            presentation = None
            try:
                presentation = _open_presentation(powerpoint, ppt_path)
                presentation.SaveAs(str(pptx_path), PPTX_FORMAT)
                report["converted"].append({"source": str(ppt_path), "target": str(pptx_path)})
            except Exception as exc:
                report["failed"].append(
                    {
                        "source": str(ppt_path),
                        "target": str(pptx_path),
                        "reason": f"{type(exc).__name__}: {exc}",
                    }
                )
            finally:
                if presentation is not None:
                    try:
                        presentation.Close()
                    except Exception:
                        pass
    finally:
        if powerpoint is not None:
            try:
                powerpoint.Quit()
            except Exception:
                pass
        pythoncom.CoUninitialize()

    return report


def _open_presentation(powerpoint, ppt_path: Path):
    try:
        return powerpoint.Presentations.Open(
            str(ppt_path),
            True,   # ReadOnly
            False,  # Untitled
            False,  # WithWindow
        )
    except Exception:
        # Some legacy Office files are blocked by PowerPoint's file validation in
        # normal automation mode. Protected View can still open them and promote
        # the document to an editable presentation for conversion.
        temp_dir = ppt_path.parent / ".ppt_conversion_tmp"
        temp_dir.mkdir(exist_ok=True)
        temp_path = temp_dir / "legacy_input.ppt"
        shutil.copy2(ppt_path, temp_path)
        view = powerpoint.ProtectedViewWindows.Open(str(temp_path))
        return view.Edit()


def write_report(report: dict, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert legacy .ppt files to .pptx.")
    parser.add_argument("--source-root", type=Path, default=DATA_ROOT / "PPT")
    parser.add_argument("--force", action="store_true", help="Overwrite existing .pptx files.")
    parser.add_argument("--strict", action="store_true", help="Exit with code 1 when any file fails.")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument(
        "--report-path",
        type=Path,
        default=METADATA_DIR / "ppt_conversion_report.json",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = convert_legacy_presentations(
        source_root=args.source_root,
        force=args.force,
        limit=args.limit,
    )
    write_report(report, args.report_path)

    print("Legacy presentation conversion finished.")
    print(f"source_root: {report['source_root']}")
    print(f"total_candidates: {report['total_candidates']}")
    print(f"converted: {len(report['converted'])}")
    print(f"skipped: {len(report['skipped'])}")
    print(f"failed: {len(report['failed'])}")
    print(f"report_path: {args.report_path.resolve()}")

    if args.strict and report["failed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
