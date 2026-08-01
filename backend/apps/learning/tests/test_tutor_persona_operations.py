import importlib
from types import SimpleNamespace

from django.apps import apps as django_apps
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import IntegrityError, connection, migrations, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.models.deletion import ProtectedError
from django.test import TestCase, TransactionTestCase

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
        self.assertEqual(TutorAvatarAsset.objects.count(), 4)
        self.assertEqual(
            set(configurations.values_list("persona_id", flat=True)),
            {"structured-teacher", "socratic-guide", "practice-coach", "foundation-coach"},
        )
        self.assertEqual(
            {
                configuration.persona_id: configuration.avatar_asset.asset_id
                for configuration in configurations
            },
            {
                "structured-teacher": "teacher-default-v1",
                "socratic-guide": "teacher-insight-v1",
                "practice-coach": "teacher-practice-v1",
                "foundation-coach": "teacher-foundation-v1",
            },
        )

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

    def get_additional_avatar_migration(self):
        return importlib.import_module(
            "backend.apps.learning.migrations.0016_additional_tutor_avatar_assets"
        )

    def get_migration_schema_editor(self):
        return SimpleNamespace(connection=connection)

    def reset_additional_avatar_migration_state(self):
        migration_module = self.get_additional_avatar_migration()
        TutorAvatarAsset = self.get_model("TutorAvatarAsset")
        TutorPersonaConfiguration = self.get_model("TutorPersonaConfiguration")
        default_asset = TutorAvatarAsset.objects.get(asset_id="teacher-default-v1")

        TutorPersonaConfiguration.objects.filter(
            persona_id__in=migration_module.PERSONA_ASSIGNMENTS,
        ).update(avatar_asset=default_asset, updated_by=None)
        TutorAvatarAsset.objects.filter(asset_id__in=migration_module.ASSET_IDS).delete()
        return migration_module, default_asset

    def test_additional_avatar_migration_seeds_exact_assets_and_assigns_untouched_personas(self):
        migration_module, default_asset = self.reset_additional_avatar_migration_state()
        TutorAvatarAsset = self.get_model("TutorAvatarAsset")
        TutorPersonaConfiguration = self.get_model("TutorPersonaConfiguration")

        migration_module.forwards(django_apps, self.get_migration_schema_editor())

        expected_assets = {
            "teacher-insight-v1": {
                "display_name": "启思导师",
                "public_path": "/a3/assets/teacher-avatar/teacher2.vrm",
                "sha256": "cf0e672ae98ca5cb35de92dd99bf836725d619931c0ef174e5e9e50a1a0001bf",
                "file_size_bytes": 14_574_928,
            },
            "teacher-practice-v1": {
                "display_name": "知行导师",
                "public_path": "/a3/assets/teacher-avatar/teacher3.vrm",
                "sha256": "9ea7e12d57025f16101f867b0e3f88907bbabcf697d9edfa1176fc4bc7b0bc1e",
                "file_size_bytes": 15_195_704,
            },
            "teacher-foundation-v1": {
                "display_name": "明理导师",
                "public_path": "/a3/assets/teacher-avatar/teacher4.vrm",
                "sha256": "ff0b340fb317d70039b15e34e165f46ec1aaead691aa28abca524a1861dcbe61",
                "file_size_bytes": 15_088_084,
            },
        }
        common_fields = {
            "thumbnail_path": "",
            "author": "A3 project team",
            "source_name": "VRoid Studio self-created model",
            "source_url": "https://vroid.com/en/studio",
            "license_name": "VRM 1.0 project-scoped non-commercial",
            "license_url": "https://vrm.dev/licenses/1.0/",
            "usage_scope": ["A3 demo", "competition", "product prototype"],
            "status": "enabled",
            "is_default": False,
            "metadata": {
                "licenseStatus": "complete",
                "vrmVersion": "1.0",
                "humanBoneCount": 54,
                "expressionPresetCount": 14,
                "runtimeAnimations": "shared-vrma",
                "seededByMigration": "learning.0016",
            },
        }

        self.assertEqual(tuple(expected_assets), migration_module.ASSET_IDS)
        for asset_id, expected in expected_assets.items():
            asset = TutorAvatarAsset.objects.get(asset_id=asset_id)
            for field, value in {**expected, **common_fields}.items():
                self.assertEqual(getattr(asset, field), value)

        self.assertEqual(
            TutorPersonaConfiguration.objects.get(persona_id="structured-teacher").avatar_asset_id,
            default_asset.id,
        )
        for persona_id, asset_id in migration_module.PERSONA_ASSIGNMENTS.items():
            configuration = TutorPersonaConfiguration.objects.get(persona_id=persona_id)
            self.assertEqual(configuration.avatar_asset.asset_id, asset_id)

    def test_additional_avatar_migration_is_idempotent_and_preserves_overrides(self):
        migration_module, default_asset = self.reset_additional_avatar_migration_state()
        TutorAvatarAsset = self.get_model("TutorAvatarAsset")
        TutorPersonaConfiguration = self.get_model("TutorPersonaConfiguration")
        custom_asset = TutorAvatarAsset.objects.create(
            asset_id="teacher-custom-v1",
            display_name="自定义导师",
            public_path="/a3/assets/teacher-avatar/custom.vrm",
            sha256="4" * 64,
            file_size_bytes=5,
        )
        practice = TutorPersonaConfiguration.objects.get(persona_id="practice-coach")
        practice.updated_by = self.user
        practice.save(update_fields=["updated_by"])
        foundation = TutorPersonaConfiguration.objects.get(persona_id="foundation-coach")
        foundation.avatar_asset = custom_asset
        foundation.save(update_fields=["avatar_asset"])

        migration_module.forwards(django_apps, self.get_migration_schema_editor())
        TutorAvatarAsset.objects.filter(asset_id="teacher-insight-v1").update(display_name="旧名称")
        migration_module.forwards(django_apps, self.get_migration_schema_editor())

        self.assertEqual(
            TutorAvatarAsset.objects.filter(asset_id__in=migration_module.ASSET_IDS).count(),
            3,
        )
        self.assertEqual(
            TutorAvatarAsset.objects.get(asset_id="teacher-insight-v1").display_name,
            "旧名称",
        )
        practice.refresh_from_db()
        foundation.refresh_from_db()
        self.assertEqual(practice.avatar_asset_id, default_asset.id)
        self.assertEqual(practice.updated_by_id, self.user.id)
        self.assertEqual(foundation.avatar_asset_id, custom_asset.id)

    def test_additional_avatar_reverse_restores_only_untouched_bindings_and_keeps_reused_assets(self):
        migration_module, default_asset = self.reset_additional_avatar_migration_state()
        TutorAvatarAsset = self.get_model("TutorAvatarAsset")
        TutorPersonaConfiguration = self.get_model("TutorPersonaConfiguration")
        migration_module.forwards(django_apps, self.get_migration_schema_editor())

        insight_asset = TutorAvatarAsset.objects.get(asset_id="teacher-insight-v1")
        practice = TutorPersonaConfiguration.objects.get(persona_id="practice-coach")
        practice.updated_by = self.user
        practice.save(update_fields=["updated_by"])
        TutorPersonaConfiguration.objects.create(
            persona_id="administrator-reused-avatar",
            avatar_asset=insight_asset,
            updated_by=self.user,
        )

        migration_module.reverse(django_apps, self.get_migration_schema_editor())

        socratic = TutorPersonaConfiguration.objects.get(persona_id="socratic-guide")
        foundation = TutorPersonaConfiguration.objects.get(persona_id="foundation-coach")
        practice.refresh_from_db()
        self.assertEqual(socratic.avatar_asset_id, default_asset.id)
        self.assertEqual(foundation.avatar_asset_id, default_asset.id)
        self.assertEqual(practice.avatar_asset.asset_id, "teacher-practice-v1")
        self.assertEqual(practice.updated_by_id, self.user.id)
        self.assertTrue(TutorAvatarAsset.objects.filter(asset_id="teacher-insight-v1").exists())
        self.assertTrue(TutorAvatarAsset.objects.filter(asset_id="teacher-practice-v1").exists())
        self.assertFalse(TutorAvatarAsset.objects.filter(asset_id="teacher-foundation-v1").exists())


class AdditionalTutorAvatarMigrationTests(TransactionTestCase):
    serialized_rollback = True
    migrate_from = ("learning", "0015_tutor_analytics_indexes")
    migrate_to = ("learning", "0016_additional_tutor_avatar_assets")

    expected_assets = {
        "teacher-insight-v1": {
            "display_name": "启思导师",
            "public_path": "/a3/assets/teacher-avatar/teacher2.vrm",
            "sha256": "cf0e672ae98ca5cb35de92dd99bf836725d619931c0ef174e5e9e50a1a0001bf",
            "file_size_bytes": 14_574_928,
        },
        "teacher-practice-v1": {
            "display_name": "知行导师",
            "public_path": "/a3/assets/teacher-avatar/teacher3.vrm",
            "sha256": "9ea7e12d57025f16101f867b0e3f88907bbabcf697d9edfa1176fc4bc7b0bc1e",
            "file_size_bytes": 15_195_704,
        },
        "teacher-foundation-v1": {
            "display_name": "明理导师",
            "public_path": "/a3/assets/teacher-avatar/teacher4.vrm",
            "sha256": "ff0b340fb317d70039b15e34e165f46ec1aaead691aa28abca524a1861dcbe61",
            "file_size_bytes": 15_088_084,
        },
    }

    def setUp(self):
        super().setUp()
        self.db_alias = connection.alias
        self.executor = MigrationExecutor(connection)
        self.executor.migrate([self.migrate_from])
        self.old_apps = self.executor.loader.project_state([self.migrate_from]).apps

    def tearDown(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())
        super().tearDown()

    def migrate(self, target):
        executor = MigrationExecutor(connection)
        executor.migrate([target])
        return executor.loader.project_state([target]).apps

    def asset_snapshot(self, Asset, asset_id):
        field_names = [field.attname for field in Asset._meta.concrete_fields]
        return (
            Asset.objects.using(self.db_alias)
            .values(*field_names)
            .get(asset_id=asset_id)
        )

    def test_real_forward_migration_seeds_canonical_assets_and_assigns_untouched_personas(self):
        migration_module = importlib.import_module(
            "backend.apps.learning.migrations.0016_additional_tutor_avatar_assets"
        )

        apps = self.migrate(self.migrate_to)
        Asset = apps.get_model("learning", "TutorAvatarAsset")
        Configuration = apps.get_model("learning", "TutorPersonaConfiguration")

        self.assertEqual(tuple(self.expected_assets), migration_module.ASSET_IDS)
        self.assertEqual(
            migration_module.PERSONA_ASSIGNMENTS,
            {
                "socratic-guide": "teacher-insight-v1",
                "practice-coach": "teacher-practice-v1",
                "foundation-coach": "teacher-foundation-v1",
            },
        )
        for asset_id, expected in self.expected_assets.items():
            asset = Asset.objects.using(self.db_alias).get(asset_id=asset_id)
            for field_name, value in expected.items():
                self.assertEqual(getattr(asset, field_name), value)
            self.assertEqual(asset.thumbnail_path, "")
            self.assertEqual(asset.author, "A3 project team")
            self.assertEqual(asset.source_name, "VRoid Studio self-created model")
            self.assertEqual(asset.source_url, "https://vroid.com/en/studio")
            self.assertEqual(asset.license_name, "VRM 1.0 project-scoped non-commercial")
            self.assertEqual(asset.license_url, "https://vrm.dev/licenses/1.0/")
            self.assertEqual(asset.usage_scope, ["A3 demo", "competition", "product prototype"])
            self.assertEqual(asset.status, "enabled")
            self.assertFalse(asset.is_default)
            self.assertIsNone(asset.default_slot)
            self.assertEqual(
                asset.metadata,
                {
                    "licenseStatus": "complete",
                    "vrmVersion": "1.0",
                    "humanBoneCount": 54,
                    "expressionPresetCount": 14,
                    "runtimeAnimations": "shared-vrma",
                    "seededByMigration": "learning.0016",
                },
            )

        assignments = {
            configuration.persona_id: configuration.avatar_asset.asset_id
            for configuration in Configuration.objects.using(self.db_alias)
            .select_related("avatar_asset")
            .order_by("persona_id")
        }
        self.assertEqual(
            assignments,
            {
                "foundation-coach": "teacher-foundation-v1",
                "practice-coach": "teacher-practice-v1",
                "socratic-guide": "teacher-insight-v1",
                "structured-teacher": "teacher-default-v1",
            },
        )

    def test_real_forward_migration_preserves_admin_override_on_default_asset(self):
        User = self.old_apps.get_model("accounts", "User")
        Asset = self.old_apps.get_model("learning", "TutorAvatarAsset")
        Configuration = self.old_apps.get_model("learning", "TutorPersonaConfiguration")
        user = User.objects.using(self.db_alias).create(
            phone="13800007211",
            password="unused",
        )
        default_asset = Asset.objects.using(self.db_alias).get(asset_id="teacher-default-v1")
        Configuration.objects.using(self.db_alias).filter(persona_id="practice-coach").update(
            avatar_asset=default_asset,
            updated_by_id=user.id,
        )

        apps = self.migrate(self.migrate_to)
        Configuration = apps.get_model("learning", "TutorPersonaConfiguration")
        configuration = Configuration.objects.using(self.db_alias).select_related(
            "avatar_asset"
        ).get(persona_id="practice-coach")

        self.assertEqual(configuration.avatar_asset.asset_id, "teacher-default-v1")
        self.assertEqual(configuration.updated_by_id, user.id)

    def test_preexisting_asset_is_not_overwritten_or_deleted_and_only_safe_asset_is_bound(self):
        Asset = self.old_apps.get_model("learning", "TutorAvatarAsset")
        Configuration = self.old_apps.get_model("learning", "TutorPersonaConfiguration")
        safe = self.expected_assets["teacher-insight-v1"]
        Asset.objects.using(self.db_alias).create(
            asset_id="teacher-insight-v1",
            display_name="管理员预置启思形象",
            public_path=safe["public_path"],
            thumbnail_path="/custom/insight.png",
            author="administrator",
            source_name="pre-existing catalog",
            source_url="https://example.com/source",
            license_name="custom approved license",
            license_url="https://example.com/license",
            usage_scope=["custom scope"],
            sha256=safe["sha256"],
            file_size_bytes=safe["file_size_bytes"],
            status="enabled",
            is_default=False,
            metadata={"owner": "administrator"},
        )
        unsafe = self.expected_assets["teacher-practice-v1"]
        Asset.objects.using(self.db_alias).create(
            asset_id="teacher-practice-v1",
            display_name="不安全的预置形象",
            public_path=unsafe["public_path"],
            sha256="0" * 64,
            file_size_bytes=unsafe["file_size_bytes"],
            status="enabled",
            is_default=False,
            metadata={"owner": "administrator"},
        )
        safe_before = self.asset_snapshot(Asset, "teacher-insight-v1")
        unsafe_before = self.asset_snapshot(Asset, "teacher-practice-v1")

        apps = self.migrate(self.migrate_to)
        Asset = apps.get_model("learning", "TutorAvatarAsset")
        Configuration = apps.get_model("learning", "TutorPersonaConfiguration")
        self.assertEqual(self.asset_snapshot(Asset, "teacher-insight-v1"), safe_before)
        self.assertEqual(self.asset_snapshot(Asset, "teacher-practice-v1"), unsafe_before)
        self.assertEqual(
            Configuration.objects.using(self.db_alias)
            .select_related("avatar_asset")
            .get(persona_id="socratic-guide")
            .avatar_asset.asset_id,
            "teacher-insight-v1",
        )
        self.assertEqual(
            Configuration.objects.using(self.db_alias)
            .select_related("avatar_asset")
            .get(persona_id="practice-coach")
            .avatar_asset.asset_id,
            "teacher-default-v1",
        )

        apps = self.migrate(self.migrate_from)
        Asset = apps.get_model("learning", "TutorAvatarAsset")
        self.assertEqual(self.asset_snapshot(Asset, "teacher-insight-v1"), safe_before)
        self.assertEqual(self.asset_snapshot(Asset, "teacher-practice-v1"), unsafe_before)

    def test_real_reverse_migration_preserves_admin_reuse_and_admin_modified_assignment(self):
        apps = self.migrate(self.migrate_to)
        User = apps.get_model("accounts", "User")
        Asset = apps.get_model("learning", "TutorAvatarAsset")
        Configuration = apps.get_model("learning", "TutorPersonaConfiguration")
        user = User.objects.using(self.db_alias).create(
            phone="13800007212",
            password="unused",
        )
        insight_asset = Asset.objects.using(self.db_alias).get(asset_id="teacher-insight-v1")
        Configuration.objects.using(self.db_alias).create(
            persona_id="administrator-reused-avatar",
            avatar_asset=insight_asset,
            updated_by_id=user.id,
        )
        Configuration.objects.using(self.db_alias).filter(persona_id="practice-coach").update(
            updated_by_id=user.id,
        )

        apps = self.migrate(self.migrate_from)
        Asset = apps.get_model("learning", "TutorAvatarAsset")
        Configuration = apps.get_model("learning", "TutorPersonaConfiguration")

        self.assertEqual(
            Configuration.objects.using(self.db_alias)
            .select_related("avatar_asset")
            .get(persona_id="socratic-guide")
            .avatar_asset.asset_id,
            "teacher-default-v1",
        )
        self.assertEqual(
            Configuration.objects.using(self.db_alias)
            .select_related("avatar_asset")
            .get(persona_id="administrator-reused-avatar")
            .avatar_asset.asset_id,
            "teacher-insight-v1",
        )
        practice = Configuration.objects.using(self.db_alias).select_related("avatar_asset").get(
            persona_id="practice-coach"
        )
        self.assertEqual(practice.avatar_asset.asset_id, "teacher-practice-v1")
        self.assertEqual(practice.updated_by_id, user.id)
        self.assertTrue(
            Asset.objects.using(self.db_alias).filter(asset_id="teacher-insight-v1").exists()
        )
        self.assertTrue(
            Asset.objects.using(self.db_alias).filter(asset_id="teacher-practice-v1").exists()
        )
        self.assertFalse(
            Asset.objects.using(self.db_alias).filter(asset_id="teacher-foundation-v1").exists()
        )
