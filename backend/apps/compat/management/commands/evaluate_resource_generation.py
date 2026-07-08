from __future__ import annotations

import json
from pathlib import Path

from django.core.management.base import BaseCommand

from backend.apps.accounts.models import User
from backend.apps.compat.resource_generation import RESOURCE_TYPES, generate_resource_pack_v2
from backend.core.settings import BACKEND_ROOT


class Command(BaseCommand):
    help = "Evaluate A3 personalized multimodal resource generation coverage."

    def add_arguments(self, parser):
        parser.add_argument("--json", action="store_true", dest="as_json")
        parser.add_argument("--output", default="")
        parser.add_argument("--goal", default="处理机调度与虚拟内存")

    def handle(self, *args, **options):
        user = User.objects.filter(is_active=True).first()
        if not user:
            raise RuntimeError("No active user exists. Run seed_demo_data first.")
        result = generate_resource_pack_v2(user, goal=options["goal"], top_k=3)
        pack = result["resourcePack"]
        resources = pack.get("resources") or []
        generated_types = {item.get("type") for item in resources}
        missing_types = [item for item in RESOURCE_TYPES if item not in generated_types]
        verified_count = len([item for item in resources if item.get("verified") and item.get("citations")])
        payload = {
            "overallStatus": "pass" if not missing_types and verified_count >= len(RESOURCE_TYPES) else "fail",
            "resourcePackId": pack.get("resourcePackId"),
            "traceId": result.get("traceId"),
            "requiredTypes": list(RESOURCE_TYPES),
            "generatedTypes": sorted(generated_types),
            "missingTypes": missing_types,
            "resourceCount": len(resources),
            "verifiedResourceCount": verified_count,
            "verifiedCoverage": round(verified_count / max(1, len(RESOURCE_TYPES)) * 100, 1),
        }
        if options["output"]:
            output_path = Path(options["output"])
            if not output_path.is_absolute():
                output_path = BACKEND_ROOT.parent / output_path
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        if options["as_json"]:
            self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))
            return
        self.stdout.write("A3 resource generation evaluation")
        self.stdout.write(f"status: {payload['overallStatus']}")
        self.stdout.write(f"resourceCount: {payload['resourceCount']}")
        self.stdout.write(f"verifiedCoverage: {payload['verifiedCoverage']}%")
        if missing_types:
            self.stdout.write(f"missingTypes: {', '.join(missing_types)}")
