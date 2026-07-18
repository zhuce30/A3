from __future__ import annotations

import json

from django.core.management.base import BaseCommand

from backend.apps.compat.resource_generation import compact_resource_pack_payload
from backend.apps.learning.models import ResourcePackLog
from backend.apps.profiles.models import LearnerProfile


def _json_size(value: object) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


class Command(BaseCommand):
    help = "Remove recursively embedded profile history from stored A3 resource packs."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument("--user-id", type=int, default=0)

    def handle(self, *args, **options):
        dry_run = bool(options["dry_run"])
        user_id = int(options["user_id"] or 0)
        profiles = LearnerProfile.objects.all().only("id", "user_id", "extra_profile")
        logs = (
            ResourcePackLog.objects.filter(source="resource_generation")
            .order_by()
            .only("id", "user_id", "payload")
        )
        if user_id:
            profiles = profiles.filter(user_id=user_id)
            logs = logs.filter(user_id=user_id)

        profiles_updated = 0
        logs_updated = 0
        bytes_before = 0
        bytes_after = 0

        for profile in profiles.iterator(chunk_size=50):
            extra = dict(profile.extra_profile or {})
            packs = extra.get("resourcePacks")
            if not isinstance(packs, list):
                continue
            compacted_packs = [
                compact_resource_pack_payload(pack) if isinstance(pack, dict) else pack
                for pack in packs
            ]
            if compacted_packs == packs:
                continue
            before = _json_size(extra)
            extra["resourcePacks"] = compacted_packs
            after = _json_size(extra)
            bytes_before += before
            bytes_after += after
            profiles_updated += 1
            if not dry_run:
                profile.extra_profile = extra
                profile.save(update_fields=["extra_profile", "updated_at"])

        for log in logs.iterator(chunk_size=50):
            if not isinstance(log.payload, dict):
                continue
            compacted = compact_resource_pack_payload(log.payload)
            if compacted == log.payload:
                continue
            before = _json_size(log.payload)
            after = _json_size(compacted)
            bytes_before += before
            bytes_after += after
            logs_updated += 1
            if not dry_run:
                log.payload = compacted
                log.save(update_fields=["payload"])

        reclaimed = max(0, bytes_before - bytes_after)
        mode = "dry-run" if dry_run else "applied"
        self.stdout.write(
            self.style.SUCCESS(
                f"resource pack compaction {mode}: profiles={profiles_updated}, "
                f"logs={logs_updated}, reclaimed_bytes={reclaimed}"
            )
        )
