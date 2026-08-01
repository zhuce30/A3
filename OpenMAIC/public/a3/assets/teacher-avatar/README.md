# A3 Teacher Avatar Assets

Source: VRoid Studio self-created model.

Runtime catalog:
- `teacher.vrm`: default avatar for structured teaching and the global fallback.
- `teacher2.vrm`: 启思导师, the default avatar for Socratic guidance.
- `teacher3.vrm`: 知行导师, the default avatar for practice coaching.
- `teacher4.vrm`: 明理导师, the default avatar for foundation coaching.
- All models are loaded on demand and share the `idle.vrma`, `wait.vrma`, `explain.vrma`, and `nod.vrma` animations.

Source and runtime files:
- Editable `.vroid` projects are local authoring assets. They are not published in Git or production images; the pre-existing tracked `teacher.vroid` is retained only for repository history and reproducibility.
- `idle.vrma`: runtime VRM Animation idle pose loaded by `/a3/coaching`.
- `wait.vrma`: generated wait/listening loop for the realtime coaching teacher.
- `explain.vrma`: generated explaining loop for assistant speech playback.
- `nod.vrma`: generated nod/listening acknowledgement loop.
- `../../../../scripts/generate-a3-idle-vrma.mjs`: reproducible generator for the self-created VRMA animations.
- `../../../../scripts/sanitize-a3-teacher-vrm.mjs`: reproducible GLB metadata and thumbnail sanitizer.

Project use:
- Used as the local VRM digital teacher for A3 realtime face-to-face coaching.
- Licensed only for the A3 demo, competition, and product prototype use approved inside this repository.
- `teacher.vrm` is about 16.5 MB after sanitation. Product surfaces must load the renderer with a dynamic import and start rendering only when its viewport is near or on screen; do not add it to a first-viewport static import graph.

Sanitation:
- Run `node OpenMAIC/scripts/sanitize-a3-teacher-vrm.mjs` from the repository root, or `node scripts/sanitize-a3-teacher-vrm.mjs` from `OpenMAIC`.
- The three new runtime files, `teacher2.vrm`, `teacher3.vrm`, and `teacher4.vrm`, were sanitized by `scripts/sanitize-a3-teacher-vrm.mjs` before publication.
- The script removes personal contact metadata, normalizes the author to `A3 project team`, applies project-scoped non-commercial permissions, and removes the unreferenced embedded metadata thumbnail.
- The script preserves non-JSON GLB data except for the thumbnail's exclusive aligned BIN range, updates affected indexes and offsets, and is byte-for-byte idempotent.

License notes:
- Model creator: A3 project team.
- Sanitized VRM 1.0 metadata limits use to separately licensed people, disallows redistribution and modification, and retains credit and safety restrictions.
- Idle animation creator/source: A3 project team, generated with `OpenMAIC/scripts/generate-a3-idle-vrma.mjs` on 2026-07-10.
- Action animation creator/source: A3 project team, generated with `OpenMAIC/scripts/generate-a3-idle-vrma.mjs` on 2026-07-10.
- Third-party marketplace assets: none recorded.
- Do not add local absolute paths, API keys, signed URLs, or model download exposure to this directory or its documentation.
- Recheck license terms before redistributing this model outside the A3 project.
