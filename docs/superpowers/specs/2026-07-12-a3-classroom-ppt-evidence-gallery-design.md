# A3 Classroom PPT Evidence Gallery Design

## Goal

Restore the PPT evidence gallery on `/a3/classroom` without reverting the current three-column `ClassroomViewRedesign` layout. The active classroom must render claim-to-citation mappings as a visual PPT gallery and retain a text fallback when a preview asset is unavailable.

## Current Regression

`/a3/classroom` now renders `ClassroomViewRedesign`, but the redesigned verification block only renders `citations.slice(0, 2)`. The latest real classroom payload contains six citations and eight mapped claims; the first two citations have no `previewUrl`, while every mapped claim points to a citation with a valid preview. The old `ClassroomView` still contains `EvidenceGallery` and `groupClaimsByCitation`, but it is no longer routed.

The existing citation-preview contract test reads only `classroom-view.tsx`, so it passes while the active route lacks the gallery.

## Chosen Approach

Use a minimal in-place migration:

- Port the old evidence grouping and gallery behavior into `ClassroomViewRedesign`.
- Preserve the current history column, central classroom conversation, right-side practice/action panel, and all current interactions.
- Do not switch the route back to `ClassroomView`.
- Do not extract a shared cross-version component in this change. The old view is inactive, and a shared refactor would increase risk without improving the active product path.

## Component Behavior

The redesigned `VerificationBadge` will:

1. Select claims that contain a citation mapping.
2. Group claims by citation identity using `previewUrl`, title, location, and source type.
3. Render `EvidenceGallery` when mapped claims exist.
4. Fall back to the existing citation list only when no mapped claims exist.

The gallery will provide:

- One active evidence panel with an `object-contain` PPT/page image.
- Source title, origin, type, location, and similarity score.
- A horizontally scrollable thumbnail strip when multiple evidence groups exist.
- The verified claims supported by the selected evidence.
- A collapsed section for additional claims beyond the first three.
- A text evidence fallback when `previewUrl` is missing.
- A visible `preview unavailable` state when the image request fails, rather than removing the evidence block.

The gallery stays inside the assistant message column. It uses the available central-column width and does not alter the outer three-column grid. On narrow screens, the main image remains width-constrained and thumbnails scroll horizontally without expanding the message bubble.

## Copy And Accessibility

All new visible labels use the existing `ClassroomCopy` locale contract for Chinese and English. Preview links open the original evidence in a new tab. Thumbnail buttons expose selected state with `aria-pressed`, and the thumbnail list has a localized accessible label.

## Data Flow

```text
POST /api/a3/coaching/respond
-> citations[] + claims[].citation
-> ClassroomViewRedesign ChatMessage
-> VerificationBadge
-> groupClaimsByCitation
-> EvidenceGallery
-> resolveA3Endpoint(previewUrl)
-> Django knowledge-base preview endpoint
```

No backend contract changes are required. Existing history normalization continues preserving both `citations` and `claims`, so restored sessions use the same gallery path.

## Testing

### Contract Test

Update the classroom citation-preview test so it:

- Reads `app/a3/classroom/page.tsx` and verifies the route uses `ClassroomViewRedesign`.
- Reads `classroom-view-redesign.tsx`, not the inactive old view.
- Requires claim grouping, evidence gallery, hero preview, thumbnails, text fallback, image failure fallback, and endpoint resolution in the active component.

The updated test must fail before the migration and pass afterward.

### End-To-End Test

Add a Playwright test that uses the real local stack:

- Seed the reproducible demo data and ensure the repository PPTX fixture has completed multimodal indexing.
- Log in through the real A3 authentication flow.
- Submit a classroom question that retrieves the indexed PPT evidence.
- Do not mock `/api/a3/coaching/respond`, the knowledge-base search, or preview assets.
- Assert that the claim-citation gallery appears in the active redesigned classroom.
- Assert that at least one PPT thumbnail is visible.
- Capture the thumbnail response and require HTTP 200 with an `image/*` content type.
- Select another thumbnail when multiple sources exist and verify the active evidence changes without leaving the page.

The test may be guarded by an explicit real-stack environment variable if the regular Playwright suite cannot guarantee indexed PPT assets. A skipped run must state the missing prerequisite; it must never replace real evidence with a mock.

## Verification

Run:

```powershell
cd OpenMAIC
pnpm.cmd vitest run tests/a3-classroom-citation-preview.test.ts
npx.cmd playwright test e2e/tests/a3-classroom-ppt-evidence.spec.ts --project=chromium
npx.cmd tsc --noEmit
pnpm.cmd lint
```

The final browser check must confirm the three-column layout remains active and the PPT gallery appears inside an assistant response.

## Non-Goals

- No backend response schema changes.
- No return to the old classroom page.
- No mock PPT success state.
- No redesign of classroom navigation, practice, history, or OpenMAIC artifact controls.
