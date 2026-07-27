import importlib

from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import migrations
from django.db import IntegrityError, transaction
from django.db.models.deletion import ProtectedError
from django.test import TestCase

from backend.apps.accounts.models import User
from backend.apps.learning import models as learning_models
from backend.apps.learning.models import CoachingSession


class TutorPersonaOperationsModelTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(phone="13800007201", password="TestPassword123")
        self.session = CoachingSession.objects.create(user=self.user, topic_title="反馈控制")

    def get_model(self, name):
        self.assertTrue(hasattr(learning_models, name), f"learning.models must define {name}")
        return getattr(learning_models, name)

    def test_seeded_catalog_contains_one_default_asset_and_four_personas(self):
        TutorAvatarAsset = self.get_model("TutorAvatarAsset")
        TutorPersonaConfiguration = self.get_model("TutorPersonaConfiguration")

        asset = TutorAvatarAsset.objects.get(asset_id="teacher-default-v1")
        self.assertEqual(TutorAvatarAsset.objects.filter(is_default=True).count(), 1)
        self.assertEqual(asset.display_name, "默认教师数字人")
        self.assertEqual(asset.public_path, "/a3/assets/teacher-avatar/teacher.vrm")
        self.assertEqual(asset.sha256, "1b94e3e82b181db1dba503fa2ab97f54574a52e2e6d6ced2db8ed20a7e1c9af4")
        self.assertEqual(asset.file_size_bytes, 16_496_824)
        self.assertEqual(asset.status, "enabled")
        self.assertTrue(asset.is_default)
        self.assertEqual(asset.default_slot, "default")
        self.assertEqual(asset.author, "")
        self.assertEqual(asset.source_name, "")
        self.assertEqual(asset.source_url, "")
        self.assertEqual(asset.license_name, "")
        self.assertEqual(asset.license_url, "")
        self.assertEqual(asset.usage_scope, [])
        self.assertEqual(
            asset.metadata,
            {"licenseStatus": "incomplete", "legacyCompatibility": True},
        )

        configurations = TutorPersonaConfiguration.objects.select_related("avatar_asset")
        self.assertEqual(configurations.count(), 4)
        self.assertEqual(
            set(configurations.values_list("persona_id", flat=True)),
            {"structured-teacher", "socratic-guide", "practice-coach", "foundation-coach"},
        )
        self.assertEqual({configuration.avatar_asset_id for configuration in configurations}, {asset.id})

    def test_feedback_is_unique_per_user_and_session(self):
        TutorPersonaFeedback = self.get_model("TutorPersonaFeedback")
        TutorPersonaFeedback.objects.create(
            user=self.user,
            session=self.session,
            persona_id="structured-teacher",
            rating=4,
        )

        with self.assertRaises(IntegrityError), transaction.atomic():
            TutorPersonaFeedback.objects.create(
                user=self.user,
                session=self.session,
                persona_id="structured-teacher",
                rating=5,
            )

    def test_only_one_avatar_asset_can_be_default(self):
        TutorAvatarAsset = self.get_model("TutorAvatarAsset")

        with self.assertRaises(IntegrityError), transaction.atomic():
            TutorAvatarAsset.objects.create(
                asset_id="teacher-second-v1",
                display_name="第二教师数字人",
                public_path="/a3/assets/teacher-avatar/teacher-second.vrm",
                sha256="0" * 64,
                file_size_bytes=1,
                status="enabled",
                is_default=True,
            )

    def test_default_slot_is_portable_and_consistent_with_public_flag(self):
        TutorAvatarAsset = self.get_model("TutorAvatarAsset")
        default_asset = TutorAvatarAsset.objects.get(asset_id="teacher-default-v1")
        first = TutorAvatarAsset.objects.create(
            asset_id="teacher-nondefault-v1",
            display_name="非默认教师一",
            public_path="/a3/assets/teacher-avatar/nondefault-one.vrm",
            sha256="2" * 64,
            file_size_bytes=3,
        )
        second = TutorAvatarAsset.objects.create(
            asset_id="teacher-nondefault-v2",
            display_name="非默认教师二",
            public_path="/a3/assets/teacher-avatar/nondefault-two.vrm",
            sha256="3" * 64,
            file_size_bytes=4,
        )

        self.assertEqual(default_asset.default_slot, "default")
        self.assertIsNone(first.default_slot)
        self.assertIsNone(second.default_slot)
        default_slot = TutorAvatarAsset._meta.get_field("default_slot")
        self.assertTrue(default_slot.unique)
        self.assertTrue(default_slot.null)
        self.assertFalse(default_slot.editable)

        with self.assertRaises(IntegrityError), transaction.atomic():
            TutorAvatarAsset.objects.filter(pk=first.pk).update(is_default=True)
        with self.assertRaises(IntegrityError), transaction.atomic():
            TutorAvatarAsset.objects.filter(pk=default_asset.pk).update(is_default=False)

    def test_rating_validators_and_database_constraint_reject_out_of_range_values(self):
        TutorPersonaFeedback = self.get_model("TutorPersonaFeedback")
        validators = TutorPersonaFeedback._meta.get_field("rating").validators
        self.assertTrue(
            any(
                isinstance(validator, MinValueValidator) and validator.limit_value == 1
                for validator in validators
            )
        )
        self.assertTrue(
            any(
                isinstance(validator, MaxValueValidator) and validator.limit_value == 5
                for validator in validators
            )
        )

        for rating in (0, 6):
            with self.subTest(rating=rating):
                feedback = TutorPersonaFeedback(
                    user=self.user,
                    session=self.session,
                    persona_id="structured-teacher",
                    rating=rating,
                )
                with self.assertRaises(ValidationError):
                    feedback.full_clean()
                with self.assertRaises(IntegrityError), transaction.atomic():
                    TutorPersonaFeedback.objects.create(
                        user=self.user,
                        session=self.session,
                        persona_id="structured-teacher",
                        rating=rating,
                    )

    def test_feedback_user_must_match_session_user_on_save(self):
        TutorPersonaFeedback = self.get_model("TutorPersonaFeedback")
        other_user = User.objects.create_user(phone="13800007202", password="TestPassword123")

        with self.assertRaisesMessage(ValidationError, "反馈用户必须与辅导会话用户一致"):
            TutorPersonaFeedback.objects.create(
                user=other_user,
                session=self.session,
                persona_id="structured-teacher",
                rating=4,
            )

    def test_migration_reverse_is_noop_and_constraint_names_match_models(self):
        migration_module = importlib.import_module(
            "backend.apps.learning.migrations.0014_tutor_persona_operations"
        )
        run_python = next(
            operation
            for operation in migration_module.Migration.operations
            if isinstance(operation, migrations.RunPython)
        )
        self.assertIs(run_python.reverse_code, migrations.RunPython.noop)

        model_constraints = {
            constraint.name
            for model in (
                self.get_model("TutorAvatarAsset"),
                self.get_model("TutorPersonaFeedback"),
            )
            for constraint in model._meta.constraints
        }
        migration_constraints = {
            constraint.name
            for operation in migration_module.Migration.operations
            if isinstance(operation, migrations.CreateModel)
            for constraint in operation.options.get("constraints", [])
        }
        expected = {"tutor_avatar_default_slot_consistent", "tutor_feedback_rating_1_5"}
        self.assertTrue(expected.issubset(model_constraints))
        self.assertTrue(expected.issubset(migration_constraints))

    def test_model_defaults_and_protected_avatar_binding(self):
        TutorAvatarAsset = self.get_model("TutorAvatarAsset")
        TutorPersonaConfiguration = self.get_model("TutorPersonaConfiguration")
        TutorPersonaFeedback = self.get_model("TutorPersonaFeedback")

        asset = TutorAvatarAsset.objects.create(
            asset_id="teacher-draft-v1",
            display_name="待审核教师数字人",
            public_path="/a3/assets/teacher-avatar/teacher-draft.vrm",
            sha256="1" * 64,
            file_size_bytes=2,
        )
        configuration = TutorPersonaConfiguration.objects.create(
            persona_id="test-persona",
            avatar_asset=asset,
        )
        feedback = TutorPersonaFeedback.objects.create(
            user=self.user,
            session=self.session,
            persona_id="test-persona",
            rating=4,
        )

        self.assertEqual(asset.status, "draft")
        self.assertFalse(asset.is_default)
        self.assertIsNone(asset.default_slot)
        self.assertEqual(asset.thumbnail_path, "")
        self.assertEqual(asset.usage_scope, [])
        self.assertEqual(asset.metadata, {})
        self.assertTrue(configuration.enabled)
        self.assertTrue(configuration.voice_preview_enabled)
        self.assertIsNone(configuration.updated_by)
        self.assertEqual(feedback.tags, [])
        with self.assertRaises(ProtectedError):
            asset.delete()
