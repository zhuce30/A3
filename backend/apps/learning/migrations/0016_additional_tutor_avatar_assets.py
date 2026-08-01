from django.db import migrations


DEFAULT_ASSET_ID = "teacher-default-v1"

ASSETS = (
    {
        "asset_id": "teacher-insight-v1",
        "display_name": "启思导师",
        "public_path": "/a3/assets/teacher-avatar/teacher2.vrm",
        "sha256": "cf0e672ae98ca5cb35de92dd99bf836725d619931c0ef174e5e9e50a1a0001bf",
        "file_size_bytes": 14_574_928,
    },
    {
        "asset_id": "teacher-practice-v1",
        "display_name": "知行导师",
        "public_path": "/a3/assets/teacher-avatar/teacher3.vrm",
        "sha256": "9ea7e12d57025f16101f867b0e3f88907bbabcf697d9edfa1176fc4bc7b0bc1e",
        "file_size_bytes": 15_195_704,
    },
    {
        "asset_id": "teacher-foundation-v1",
        "display_name": "明理导师",
        "public_path": "/a3/assets/teacher-avatar/teacher4.vrm",
        "sha256": "ff0b340fb317d70039b15e34e165f46ec1aaead691aa28abca524a1861dcbe61",
        "file_size_bytes": 15_088_084,
    },
)

ASSET_IDS = tuple(asset["asset_id"] for asset in ASSETS)

PERSONA_ASSIGNMENTS = {
    "socratic-guide": "teacher-insight-v1",
    "practice-coach": "teacher-practice-v1",
    "foundation-coach": "teacher-foundation-v1",
}

COMMON_DEFAULTS = {
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

MIGRATION_MARKER_KEY = "seededByMigration"
MIGRATION_MARKER_VALUE = "learning.0016"


def is_safe_persona_asset(asset, asset_definition):
    return (
        asset.public_path == asset_definition["public_path"]
        and asset.sha256 == asset_definition["sha256"]
        and asset.file_size_bytes == asset_definition["file_size_bytes"]
        and asset.status == "enabled"
        and not asset.is_default
    )


def forwards(apps, schema_editor):
    db_alias = schema_editor.connection.alias
    TutorAvatarAsset = apps.get_model("learning", "TutorAvatarAsset")
    TutorPersonaConfiguration = apps.get_model("learning", "TutorPersonaConfiguration")
    default_asset = TutorAvatarAsset.objects.using(db_alias).get(asset_id=DEFAULT_ASSET_ID)

    assets_by_id = {}
    for asset_definition in ASSETS:
        asset_id = asset_definition["asset_id"]
        defaults = {
            **COMMON_DEFAULTS,
            **{key: value for key, value in asset_definition.items() if key != "asset_id"},
        }
        asset, _ = TutorAvatarAsset.objects.using(db_alias).get_or_create(
            asset_id=asset_id,
            defaults=defaults,
        )
        if is_safe_persona_asset(asset, asset_definition):
            assets_by_id[asset_id] = asset

    for persona_id, asset_id in PERSONA_ASSIGNMENTS.items():
        asset = assets_by_id.get(asset_id)
        if asset is None:
            continue
        TutorPersonaConfiguration.objects.using(db_alias).filter(
            persona_id=persona_id,
            avatar_asset=default_asset,
            updated_by__isnull=True,
        ).update(avatar_asset=asset)


def reverse(apps, schema_editor):
    db_alias = schema_editor.connection.alias
    TutorAvatarAsset = apps.get_model("learning", "TutorAvatarAsset")
    TutorPersonaConfiguration = apps.get_model("learning", "TutorPersonaConfiguration")
    default_asset = TutorAvatarAsset.objects.using(db_alias).get(asset_id=DEFAULT_ASSET_ID)

    for persona_id, asset_id in PERSONA_ASSIGNMENTS.items():
        asset = TutorAvatarAsset.objects.using(db_alias).filter(asset_id=asset_id).first()
        if asset is None:
            continue
        TutorPersonaConfiguration.objects.using(db_alias).filter(
            persona_id=persona_id,
            avatar_asset=asset,
            updated_by__isnull=True,
        ).update(avatar_asset=default_asset)

    for asset_id in ASSET_IDS:
        asset = TutorAvatarAsset.objects.using(db_alias).filter(asset_id=asset_id).first()
        if asset is None:
            continue
        metadata = asset.metadata if isinstance(asset.metadata, dict) else {}
        seeded_by_this_migration = (
            metadata.get(MIGRATION_MARKER_KEY) == MIGRATION_MARKER_VALUE
        )
        if seeded_by_this_migration and not asset.persona_configurations.using(db_alias).exists():
            asset.delete(using=db_alias)


class Migration(migrations.Migration):
    dependencies = [
        ("learning", "0015_tutor_analytics_indexes"),
    ]

    operations = [
        migrations.RunPython(forwards, reverse),
    ]
