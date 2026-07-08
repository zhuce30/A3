# A3 Classroom Product Upgrade Design

## Goal

Upgrade `/a3/classroom` from a sparse three-column chat screen into a production-style A3 learning classroom while keeping every visible action tied to an existing backend API, OpenMAIC artifact, or A3 route.

## Design

The page becomes a classroom cockpit. The center column is the primary lesson space: current goal, progress, verified AI dialogue, quick prompts, typed questions, and saved-note feedback. The left rail summarizes the active learning path, OpenMAIC resource-pack classroom evidence, and multi-agent roles. The right rail keeps evidence and action close to the lesson: knowledge-base citations, recommended exercises, and next-step routes.

No new mock capability is added. Existing calls remain the source of truth: `GET /api/learning/classroom/`, `GET /api/resources/packs/`, `GET /api/learning/classroom/history/`, `POST /api/a3/coaching/respond`, `POST /api/learning/classroom/history/`, and `POST /api/engagement/favorites/create/`.

## UX Rules

Buttons must either call a real API, navigate to a real A3 route, open a real OpenMAIC classroom URL, or be disabled with visible context. Empty states must route the learner to the next valid action, such as generating resource-pack classrooms from `/a3/recommendations` or uploading knowledge-base materials from `/a3/knowledge-base`.
