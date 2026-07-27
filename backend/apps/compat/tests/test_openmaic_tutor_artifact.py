from __future__ import annotations

import json

from backend.apps.compat.models import OpenMAICArtifact
from backend.apps.compat.tests.common import CompatApiTestCase
from backend.apps.learning.models import TutorAvatarAsset, TutorPersonaConfiguration
from backend.apps.learning.tutor_persona_operations import invalidate_tutor_persona_overlay_cache
from backend.apps.learning.tutor_personas import (
    public_tutor_persona,
    resolve_tutor_persona,
    resolve_user_tutor_preference,
)
from backend.apps.profiles.models import LearnerProfile


class OpenMAICTutorArtifactTests(CompatApiTestCase):
    def setUp(self):
        super().setUp()
        LearnerProfile.objects.create(
            user=self.user,
            extra_profile={
                "tutorPreference": {
                    "personaId": "foundation-coach",
                    "schemaVersion": "a3.tutor-preference.v1",
                    "updatedAt": "2026-07-26T00:00:00+00:00",
                },
                "resourcePacks": [
                    {
                        "resourcePackId": "pack-tutor-1",
                        "goal": "进程调度",
                        "resources": [],
                        "nextActions": [],
                        "multimodalArtifacts": [],
                    }
                ],
            },
        )
        invalidate_tutor_persona_overlay_cache()
        self.url = "/api/resources/packs/pack-tutor-1/openmaic-classroom/"

    def tearDown(self):
        invalidate_tutor_persona_overlay_cache()
        super().tearDown()

    def canonical_context(self):
        preference, fallback_used = resolve_user_tutor_preference(self.user)
        persona = public_tutor_persona(resolve_tutor_persona(preference["personaId"]))
        self.assertIsNotNone(persona)
        return persona, fallback_used

    def post_artifact(self, payload):
        return self.client.post(
            self.url,
            data=json.dumps(payload),
            content_type="application/json",
        )

    def queued_payload(self, job_id, *, persona=None, fallback_used=None):
        canonical_persona, canonical_fallback = self.canonical_context()
        return {
            "jobId": job_id,
            "status": "queued",
            "provider": "openmaic-generate-classroom",
            "tutorPersona": canonical_persona if persona is None else persona,
            "fallbackUsed": canonical_fallback if fallback_used is None else fallback_used,
        }

    def test_first_write_persists_the_current_canonical_snapshot(self):
        canonical_persona, canonical_fallback = self.canonical_context()
        response = self.post_artifact(self.queued_payload("job-canonical"))

        self.assertEqual(response.status_code, 200, response.content)
        artifact = response.json()["artifact"]
        self.assertEqual(artifact["tutorPersona"], canonical_persona)
        self.assertEqual(artifact["fallbackUsed"], canonical_fallback)
        row = OpenMAICArtifact.objects.get(job_id="job-canonical")
        self.assertEqual(row.payload["tutorPersona"], canonical_persona)

    def test_rejects_forged_public_snapshot_values(self):
        canonical_persona, _fallback_used = self.canonical_context()
        forged_values = {
            "allowedWorkflows": ["classroom"],
            "voicePreviewEnabled": not canonical_persona["voicePreviewEnabled"],
            "avatarAssetId": "forged-avatar-v1",
            "avatarPublicPath": "/a3/assets/teacher-avatar/forged.vrm",
            "name": "伪造导师名称",
            "shortDescription": "伪造简介",
            "teachingStyle": "forged-style",
            "voiceProfileId": "forged-public-voice-profile",
        }

        for index, (field, value) in enumerate(forged_values.items()):
            with self.subTest(field=field):
                forged = {**canonical_persona, field: value}
                response = self.post_artifact(
                    self.queued_payload(f"job-forged-{index}", persona=forged)
                )
                self.assertEqual(response.status_code, 400, response.content)

    def test_rejects_unknown_disabled_and_unsafe_asset_personas(self):
        canonical_persona, canonical_fallback = self.canonical_context()
        unknown = self.post_artifact(
            self.queued_payload(
                "job-unknown",
                persona={**canonical_persona, "id": "unknown-persona"},
            )
        )
        self.assertEqual(unknown.status_code, 400, unknown.content)

        TutorPersonaConfiguration.objects.filter(persona_id="foundation-coach").update(enabled=False)
        invalidate_tutor_persona_overlay_cache()
        disabled = self.post_artifact(
            {
                "jobId": "job-disabled",
                "status": "queued",
                "tutorPersona": canonical_persona,
                "fallbackUsed": canonical_fallback,
            }
        )
        self.assertEqual(disabled.status_code, 400, disabled.content)

        TutorPersonaConfiguration.objects.filter(persona_id="foundation-coach").update(enabled=True)
        unsafe_asset = TutorAvatarAsset.objects.create(
            asset_id="unsafe-foundation-v1",
            display_name="Unsafe",
            public_path="/a3/assets/teacher-avatar/../unsafe.vrm",
            sha256="a" * 64,
            file_size_bytes=1,
            status="enabled",
        )
        TutorPersonaConfiguration.objects.filter(persona_id="foundation-coach").update(
            avatar_asset=unsafe_asset
        )
        invalidate_tutor_persona_overlay_cache()
        unsafe = self.post_artifact(
            {
                "jobId": "job-unsafe",
                "status": "queued",
                "tutorPersona": canonical_persona,
                "fallbackUsed": canonical_fallback,
            }
        )
        self.assertEqual(unsafe.status_code, 400, unsafe.content)

    def test_rejects_forged_fallback_evidence(self):
        _persona, canonical_fallback = self.canonical_context()
        response = self.post_artifact(
            self.queued_payload("job-fallback", fallback_used=not canonical_fallback)
        )
        self.assertEqual(response.status_code, 400, response.content)

    def test_later_states_inherit_snapshot_and_reject_rewrites(self):
        canonical_persona, canonical_fallback = self.canonical_context()
        queued = self.post_artifact(self.queued_payload("job-tutor-1"))
        self.assertEqual(queued.status_code, 200, queued.content)

        failed = self.post_artifact(
            {
                "jobId": "job-tutor-1",
                "status": "failed",
                "provider": "openmaic-generate-classroom",
                "degradedReason": "provider failed",
            }
        )
        self.assertEqual(failed.status_code, 200, failed.content)
        self.assertEqual(failed.json()["artifact"]["tutorPersona"], canonical_persona)
        self.assertEqual(failed.json()["artifact"]["fallbackUsed"], canonical_fallback)

        rewrite = self.post_artifact(
            {
                "jobId": "job-tutor-1",
                "status": "succeeded",
                "tutorPersona": {**canonical_persona, "name": "状态改写"},
                "fallbackUsed": not canonical_fallback,
            }
        )
        self.assertEqual(rewrite.status_code, 400, rewrite.content)
        row = OpenMAICArtifact.objects.get(job_id="job-tutor-1")
        self.assertEqual(row.status, "failed")
        self.assertEqual(row.payload["tutorPersona"], canonical_persona)
