# A3 Learning Summary Markdown Design

## Goal

Add a production A3 report feature that lets a learner type one sentence, generates a Markdown summary from real learning data, stores every generated document, and renders the history inside `/a3/report`.

## Architecture

The backend owns generation and persistence. A new `LearningSummaryDocument` table stores one Markdown document per generation, scoped to the authenticated user. The generator is rule-based for the first version and reads `LearningEvent`, the current study plan, assessment report data, learner profile weak points, and recent coaching sessions. This keeps the interface stable for a later LLM implementation without making the first version depend on provider keys.

The frontend only calls the real Django API through the existing A3 client. `/a3/report` loads the summary history, lets the user submit an intent sentence, renders the latest document with the existing `A3Markdown` component, and keeps previous documents selectable.

## Interfaces

- `GET /api/learning/report-summaries/`
  - Returns current user's summary document history.
- `POST /api/learning/report-summaries/`
  - Body: `{ "prompt": "总结我今天学了什么" }`
  - Creates a Markdown document and returns it plus the refreshed history.
- `GET /api/learning/report-summaries/<id>/`
  - Returns one document if it belongs to the current user.

## Naming

Documents use date-based names with same-day sequence numbers:

- `2026-07-10-今日学习总结.md`
- `2026-07-10-今日学习总结-02.md`
- `2026-07-10-错题复盘总结.md`

## Safety

The API requires login and never exposes another user's documents. User prompt length is capped. Markdown is generated server-side from stored learning data; the existing renderer escapes unsupported HTML and does not execute script.
