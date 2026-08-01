# A3 Multi-Tutor Avatar Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register three new VRM teacher models in the existing A3 tutor asset catalog, safely assign them to three tutor personas, and preserve administrator overrides and runtime fallback behavior.

**Architecture:** Keep tutor identity and model selection in the existing Django-backed `TutorAvatarAsset` and `TutorPersonaConfiguration` catalog. Sanitize and validate the three runtime VRM files, seed them through a reversible data migration, and let the existing admin selector, student persona snapshot, OpenMAIC handoff, and frontend runtime consume the new asset paths without changing API contracts.

**Tech Stack:** Django migrations and tests, Next.js/React, TypeScript, Vitest, VRM 1.0/GLB, Git.

---

## File Map

- Modify: `OpenMAIC/tests/a3-digital-human-avatar.test.ts` — verify every shipped VRM is sanitized and structurally valid.
- Modify: `OpenMAIC/public/a3/assets/teacher-avatar/README.md` — document the four runtime models, names, ownership, licensing, and shared animations.
- Modify: `.gitignore` — keep editable `.vroid` source projects out of Git.
- Add: `OpenMAIC/public/a3/assets/teacher-avatar/teacher2.vrm` — runtime model for 启思导师.
- Add: `OpenMAIC/public/a3/assets/teacher-avatar/teacher3.vrm` — runtime model for 知行导师.
- Add: `OpenMAIC/public/a3/assets/teacher-avatar/teacher4.vrm` — runtime model for 明理导师.
- Create: `backend/apps/learning/migrations/0016_additional_tutor_avatar_assets.py` — seed assets and conditionally assign tutor personas.
- Modify: `backend/apps/learning/tests/test_tutor_persona_operations.py` — verify migration seeding, protected administrator overrides, and reverse behavior.
- Modify: `backend/apps/system/tests/test_admin_tutors.py` — verify the admin catalog exposes all safe enabled assets.
- Modify: `OpenMAIC/tests/a3-digital-human-avatar-assets.test.ts` — verify the runtime accepts and switches among the new public paths.
- Modify: `OpenMAIC/tests/a3-admin-tutors-behavior.test.ts` — verify the existing admin selector renders the new assets without frontend hardcoding.

### Task 1: Sanitize and validate the three VRM runtime assets

**Files:**
- Modify: `OpenMAIC/tests/a3-digital-human-avatar.test.ts`
- Add: `OpenMAIC/public/a3/assets/teacher-avatar/teacher2.vrm`
- Add: `OpenMAIC/public/a3/assets/teacher-avatar/teacher3.vrm`
- Add: `OpenMAIC/public/a3/assets/teacher-avatar/teacher4.vrm`

- [ ] **Step 1: Expand the existing sanitation test to cover all shipped teachers**

Replace the single-model sanitation case with a parameterized case that parses each runtime file:

```ts
const runtimeTeacherFiles = ['teacher.vrm', 'teacher2.vrm', 'teacher3.vrm', 'teacher4.vrm'];

it.each(runtimeTeacherFiles)(
  'publishes a sanitized and structurally valid project-scoped VRM: %s',
  (fileName) => {
    const avatarDirectory = path.resolve(process.cwd(), 'public/a3/assets/teacher-avatar');
    const teacherPath = path.join(avatarDirectory, fileName);
    const teacherBuffer = fs.readFileSync(teacherPath);
    const teacherJson = readGlbJson(teacherPath);
    const meta = teacherJson.extensions?.VRMC_vrm?.meta as Record<string, unknown>;

    expect(teacherBuffer.subarray(0, 4).toString('utf8')).toBe('glTF');
    expect(teacherBuffer.readUInt32LE(8)).toBe(teacherBuffer.length);
    expect(readGlbChunkLengths(teacherBuffer).every((length) => length % 4 === 0)).toBe(true);
    expect(meta.authors).toEqual(['A3 project team']);
    expect(meta).not.toHaveProperty('contactInformation');
    expect(meta).not.toHaveProperty('thumbnailImage');
    expect(meta.avatarPermission).toBe('onlySeparatelyLicensedPerson');
    expect(meta.allowRedistribution).toBe(false);
    expect(meta.commercialUsage).toBe('personalNonProfit');
    expect(meta.modification).toBe('prohibited');
    expect(fs.statSync(teacherPath).size).toBeLessThan(17_000_000);
  },
);
```

Keep the existing buffer-view, image, texture, and personal-phone scans, and run those assertions for each model rather than only `teacher.vrm`.

- [ ] **Step 2: Run the focused test and verify the new files fail sanitation**

Run:

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-digital-human-avatar.test.ts
```

Expected: FAIL for `teacher2.vrm`, `teacher3.vrm`, and `teacher4.vrm` because their author and thumbnail metadata have not yet been normalized.

- [ ] **Step 3: Sanitize each new model with the existing deterministic script**

For each file, write to a temporary output and replace the original only after the command succeeds:

```powershell
cd D:\Download\A3\OpenMAIC
$files = 'teacher2.vrm', 'teacher3.vrm', 'teacher4.vrm'
foreach ($file in $files) {
  $inputPath = Join-Path 'public\a3\assets\teacher-avatar' $file
  $outputPath = Join-Path $env:TEMP ("a3-sanitized-" + $file)
  node scripts\sanitize-a3-teacher-vrm.mjs --input $inputPath --output $outputPath
  Move-Item -Force -LiteralPath $outputPath -Destination $inputPath
}
```

- [ ] **Step 4: Verify sanitation is idempotent and record final hashes and sizes**

Run the sanitizer a second time into temporary files and compare bytes. Then capture release metadata:

```powershell
cd D:\Download\A3\OpenMAIC
$files = 'teacher2.vrm', 'teacher3.vrm', 'teacher4.vrm'
foreach ($file in $files) {
  $inputPath = Join-Path 'public\a3\assets\teacher-avatar' $file
  $outputPath = Join-Path $env:TEMP ("a3-idempotent-" + $file)
  node scripts\sanitize-a3-teacher-vrm.mjs --input $inputPath --output $outputPath
  if ((Get-FileHash $inputPath).Hash -ne (Get-FileHash $outputPath).Hash) {
    throw "$file sanitation is not idempotent"
  }
  Remove-Item -LiteralPath $outputPath
  Get-Item $inputPath | Select-Object Name, Length
  Get-FileHash -Algorithm SHA256 $inputPath | Select-Object Hash
}
```

Expected: no exception; all files remain below 17 MB and produce stable SHA-256 values. Use these post-sanitation values in Task 2, not the pre-sanitation hashes.

- [ ] **Step 5: Run the focused model test**

Run:

```powershell
pnpm.cmd vitest run tests/a3-digital-human-avatar.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit sanitized runtime assets and the model test**

```powershell
cd D:\Download\A3
git add OpenMAIC/tests/a3-digital-human-avatar.test.ts `
  OpenMAIC/public/a3/assets/teacher-avatar/teacher2.vrm `
  OpenMAIC/public/a3/assets/teacher-avatar/teacher3.vrm `
  OpenMAIC/public/a3/assets/teacher-avatar/teacher4.vrm
git commit -m "feat: add three tutor avatar models"
```

### Task 2: Seed the backend asset catalog without overwriting administrators

**Files:**
- Create: `backend/apps/learning/migrations/0016_additional_tutor_avatar_assets.py`
- Modify: `backend/apps/learning/tests/test_tutor_persona_operations.py`

- [ ] **Step 1: Write migration behavior tests**

Add tests that import the new migration and call its forward function through Django's app registry. Cover both untouched and administrator-modified configurations:

```python
from django.apps import apps as django_apps

def test_additional_avatar_migration_seeds_assets_and_assigns_untouched_personas(self):
    migration_module = importlib.import_module(
        "backend.apps.learning.migrations.0016_additional_tutor_avatar_assets"
    )
    TutorAvatarAsset = self.get_model("TutorAvatarAsset")
    TutorPersonaConfiguration = self.get_model("TutorPersonaConfiguration")

    default_asset = TutorAvatarAsset.objects.get(asset_id="teacher-default-v1")
    TutorPersonaConfiguration.objects.filter(
        persona_id__in=migration_module.PERSONA_ASSIGNMENTS,
    ).update(avatar_asset=default_asset, updated_by=None)
    TutorAvatarAsset.objects.filter(asset_id__in=migration_module.ASSET_IDS).delete()
    migration_module.seed_additional_tutor_avatar_assets(django_apps, None)

    self.assertEqual(
        set(TutorAvatarAsset.objects.filter(asset_id__in=migration_module.ASSET_IDS)
            .values_list("asset_id", flat=True)),
        set(migration_module.ASSET_IDS),
    )
    self.assertEqual(
        TutorPersonaConfiguration.objects.get(persona_id="socratic-guide").avatar_asset.asset_id,
        "teacher-insight-v1",
    )
    self.assertEqual(
        TutorPersonaConfiguration.objects.get(persona_id="practice-coach").avatar_asset.asset_id,
        "teacher-practice-v1",
    )
    self.assertEqual(
        TutorPersonaConfiguration.objects.get(persona_id="foundation-coach").avatar_asset.asset_id,
        "teacher-foundation-v1",
    )

def test_additional_avatar_migration_preserves_admin_override(self):
    migration_module = importlib.import_module(
        "backend.apps.learning.migrations.0016_additional_tutor_avatar_assets"
    )
    TutorAvatarAsset = self.get_model("TutorAvatarAsset")
    TutorPersonaConfiguration = self.get_model("TutorPersonaConfiguration")
    default_asset = TutorAvatarAsset.objects.get(asset_id="teacher-default-v1")
    configuration = TutorPersonaConfiguration.objects.get(persona_id="socratic-guide")
    configuration.avatar_asset = default_asset
    configuration.updated_by = self.user
    configuration.save(update_fields=["avatar_asset", "updated_by", "updated_at"])

    migration_module.seed_additional_tutor_avatar_assets(django_apps, None)

    configuration.refresh_from_db()
    self.assertEqual(configuration.avatar_asset_id, default_asset.id)
    self.assertEqual(configuration.updated_by_id, self.user.id)
```

Add a reverse test that confirms untouched migration-owned bindings return to `teacher-default-v1`, while an administrator-reassigned asset remains intact and prevents unsafe deletion.

- [ ] **Step 2: Run the migration tests and verify they fail**

Run:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test `
  backend.apps.learning.tests.test_tutor_persona_operations.TutorPersonaOperationsModelTests
```

Expected: FAIL because migration `0016_additional_tutor_avatar_assets` does not exist.

- [ ] **Step 3: Implement the data migration using the sanitized hashes**

Create `0016_additional_tutor_avatar_assets.py` with dependency `("learning", "0015_tutor_analytics_indexes")`. Define immutable asset data and persona assignments:

```python
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
```

Use these exact post-sanitation hashes and byte counts in the implementation file. Each asset's defaults must also include:

```python
{
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
    },
}
```

Use `update_or_create(asset_id=..., defaults=...)`. Assign a persona only with this filter:

```python
TutorPersonaConfiguration.objects.filter(
    persona_id=persona_id,
    avatar_asset__asset_id=DEFAULT_ASSET_ID,
    updated_by__isnull=True,
).update(avatar_asset=assets_by_id[asset_id])
```

The reverse function must restore only configurations that still point to the migration's matching asset and have `updated_by__isnull=True`. Delete a new asset only when `persona_configurations.exists()` is false. Register both functions with `migrations.RunPython(forward, reverse)`.

- [ ] **Step 4: Run migration tests and Django migration checks**

Run:

```powershell
backend\.venv\Scripts\python.exe backend\manage.py test `
  backend.apps.learning.tests.test_tutor_persona_operations.TutorPersonaOperationsModelTests
backend\.venv\Scripts\python.exe backend\manage.py makemigrations --check --dry-run
backend\.venv\Scripts\python.exe backend\manage.py migrate --plan
```

Expected: tests PASS; `makemigrations` reports no changes; migration plan includes `learning.0016_additional_tutor_avatar_assets` when the local database has not applied it.

- [ ] **Step 5: Commit the migration and tests**

```powershell
git add backend/apps/learning/migrations/0016_additional_tutor_avatar_assets.py `
  backend/apps/learning/tests/test_tutor_persona_operations.py
git commit -m "feat: register tutor avatar assets"
```

### Task 3: Verify the admin catalog and runtime switching use backend data

**Files:**
- Modify: `backend/apps/system/tests/test_admin_tutors.py`
- Modify: `OpenMAIC/tests/a3-admin-tutors-behavior.test.ts`
- Modify: `OpenMAIC/tests/a3-digital-human-avatar-assets.test.ts`

- [ ] **Step 1: Add a backend catalog test**

Seed the additional assets through the migration function, call the existing admin tutor endpoint, and verify stable IDs and paths:

```python
def test_catalog_exposes_all_enabled_project_avatar_assets(self):
    import importlib
    from django.apps import apps as django_apps

    migration_module = importlib.import_module(
        "backend.apps.learning.migrations.0016_additional_tutor_avatar_assets"
    )
    migration_module.seed_additional_tutor_avatar_assets(django_apps, None)
    response = self.client.get(self.collection_url)
    self.assertEqual(response.status_code, 200)
    assets = {row["assetId"]: row for row in response.json()["assets"]}
    self.assertEqual(
        set(assets),
        {
            "teacher-default-v1",
            "teacher-insight-v1",
            "teacher-practice-v1",
            "teacher-foundation-v1",
        },
    )
    self.assertEqual(
        assets["teacher-insight-v1"]["publicPath"],
        "/a3/assets/teacher-avatar/teacher2.vrm",
    )
    self.assertTrue(assets["teacher-insight-v1"]["licenseComplete"])
```

The dynamic import is required because Python module identifiers cannot be imported with normal dotted syntax when they begin with digits.

- [ ] **Step 2: Add frontend behavior tests for API-provided assets**

Extend the existing admin fixture with the three new `assets` rows and assert each display name appears as an `<option>`. Do not introduce an exported frontend asset catalog.

Add a path acceptance test to `a3-digital-human-avatar-assets.test.ts`:

```ts
it.each([
  ['teacher-insight-v1', '/a3/assets/teacher-avatar/teacher2.vrm'],
  ['teacher-practice-v1', '/a3/assets/teacher-avatar/teacher3.vrm'],
  ['teacher-foundation-v1', '/a3/assets/teacher-avatar/teacher4.vrm'],
])('accepts a project tutor asset %s', (assetId, publicPath) => {
  expect(resolveControlledAvatarAssetSelection({ assetId, publicPath })).toEqual({
    selection: { assetId, publicPath },
    fallbackUsed: false,
  });
});
```

- [ ] **Step 3: Run tests and verify existing generic code already passes**

Run:

```powershell
cd D:\Download\A3
backend\.venv\Scripts\python.exe backend\manage.py test backend.apps.system.tests.test_admin_tutors

cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run tests/a3-admin-tutors-behavior.test.ts tests/a3-digital-human-avatar-assets.test.ts
```

Expected: PASS without production component changes. If a test fails because a component hardcodes the default asset, make the smallest change in that component to consume the existing API `assets` array; do not add a second catalog.

- [ ] **Step 4: Commit the catalog and runtime regression tests**

```powershell
cd D:\Download\A3
git add backend/apps/system/tests/test_admin_tutors.py `
  OpenMAIC/tests/a3-admin-tutors-behavior.test.ts `
  OpenMAIC/tests/a3-digital-human-avatar-assets.test.ts
git commit -m "test: cover tutor avatar catalog switching"
```

### Task 4: Document assets and exclude editable sources

**Files:**
- Modify: `.gitignore`
- Modify: `OpenMAIC/public/a3/assets/teacher-avatar/README.md`

- [ ] **Step 1: Add a repository rule for VRoid source projects**

Add this under the large local source-assets section of `.gitignore`:

```gitignore
# Editable VRoid source projects are local authoring assets, not runtime files
*.vroid
```

- [ ] **Step 2: Verify all three source projects are ignored**

Run:

```powershell
git check-ignore -v `
  OpenMAIC/public/a3/assets/teacher-avatar/teacher2.vroid `
  OpenMAIC/public/a3/assets/teacher-avatar/teacher3.vroid `
  OpenMAIC/public/a3/assets/teacher-avatar/teacher4.vroid
```

Expected: each path is reported against the new `*.vroid` rule.

- [ ] **Step 3: Update the asset README**

Document the complete runtime catalog:

```markdown
Runtime models:
- `teacher.vrm`: default model for structured teaching and global fallback.
- `teacher2.vrm`: 启思导师, assigned to Socratic guidance by default.
- `teacher3.vrm`: 知行导师, assigned to practice coaching by default.
- `teacher4.vrm`: 明理导师, assigned to foundation coaching by default.

All four models are loaded on demand and share the local idle, wait, explain, and nod VRMA animations. Editable `.vroid` projects remain local and are not published in Git or production images.
```

Also state that the three new files were sanitized with `scripts/sanitize-a3-teacher-vrm.mjs`, are authored by the A3 project team, and retain project-scoped non-commercial restrictions.

- [ ] **Step 4: Commit repository policy and documentation**

```powershell
git add .gitignore OpenMAIC/public/a3/assets/teacher-avatar/README.md
git commit -m "docs: document tutor avatar catalog"
```

### Task 5: Full verification and deployment readiness

**Files:**
- Verify only; no planned production code changes.

- [ ] **Step 1: Verify no editable or unrelated files are staged**

Run:

```powershell
cd D:\Download\A3
git status --short --branch
git ls-files 'OpenMAIC/public/a3/assets/teacher-avatar/*.vroid'
```

Expected: no `.vroid` output; existing unrelated dirty files remain unstaged and untouched.

- [ ] **Step 2: Run focused backend regression**

```powershell
backend\.venv\Scripts\python.exe backend\manage.py check
backend\.venv\Scripts\python.exe backend\manage.py test `
  backend.apps.learning.tests.test_tutor_persona_operations `
  backend.apps.profiles.tests.test_tutor_preferences `
  backend.apps.system.tests.test_admin_tutors
```

Expected: Django check reports no issues and all selected tests PASS.

- [ ] **Step 3: Run focused frontend regression and type checking**

```powershell
cd D:\Download\A3\OpenMAIC
pnpm.cmd vitest run `
  tests/a3-digital-human-avatar.test.ts `
  tests/a3-digital-human-avatar-assets.test.ts `
  tests/a3-admin-tutors-behavior.test.ts `
  tests/a3-tutor-persona-selector.test.ts `
  tests/a3-openmaic-tutor-handoff.test.ts
npx.cmd tsc --noEmit
```

Expected: all focused tests PASS and TypeScript reports no errors.

- [ ] **Step 4: Inspect the final diff and asset sizes**

```powershell
cd D:\Download\A3
git diff --check origin/codex/a3-latest-integration...HEAD
Get-Item OpenMAIC\public\a3\assets\teacher-avatar\teacher[234].vrm |
  Select-Object Name, Length
git log --oneline --decorate -8
```

Expected: no whitespace errors; exactly three new runtime models are present; implementation commits are separate from unrelated local files.

- [ ] **Step 5: Deployment sequence after push and GitHub Actions build**

Production requires no new secret or environment variable. After fixed-SHA frontend and backend images are available:

```bash
cd /opt/A3
sudo docker pull "$A3_BACKEND_IMAGE"
sudo docker pull "$A3_FRONTEND_IMAGE"
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  up -d --no-build --force-recreate backend celery celery-beat frontend caddy
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T backend python manage.py migrate --noinput
```

Because the backend container startup already runs migrations in the normal production entrypoint, the explicit migrate command is a post-deployment verification and must return `No migrations to apply` or show `learning.0016_additional_tutor_avatar_assets` applied successfully.

Verify the database catalog and HTTP asset responses:

```bash
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T backend python manage.py shell -c \
  "from backend.apps.learning.models import TutorAvatarAsset; print(list(TutorAvatarAsset.objects.values_list('asset_id','display_name','status')))"
curl -I https://a3.zhuce.work/a3/assets/teacher-avatar/teacher2.vrm
curl -I https://a3.zhuce.work/a3/assets/teacher-avatar/teacher3.vrm
curl -I https://a3.zhuce.work/a3/assets/teacher-avatar/teacher4.vrm
```

Expected: four catalog rows including the default; all three asset requests return HTTP 200 with long-lived public cache headers.
