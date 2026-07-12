# A3 Latest Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one integration branch containing every current A3 product change plus the completed public product homepage, without losing uncommitted source, tests, migrations, assets, design evidence, or Agent configuration.

**Architecture:** Treat the original working tree as the source of the latest product functionality and commit it first on a new integration branch. Merge the homepage branch into that snapshot, resolve only the overlapping paths semantically, then verify both the homepage and the authenticated learning product before moving the review server.

**Tech Stack:** Git worktrees, Next.js 16, React 19, TypeScript, Vitest, Playwright, Django, MySQL.

---

### Task 1: Preserve the complete original working tree

**Files:**
- Create: `docs/superpowers/plans/2026-07-12-a3-latest-integration.md`
- Preserve: all current tracked and untracked project files
- Exclude: `control/celery.pidbox.exchange`
- Exclude: `control/reply.celery.pidbox.exchange`

- [ ] **Step 1: Record the pre-integration state**

Run `git status --short --branch` and retain the output in the task log. Confirm the source branch is `codex/a3-digital-human-avatar` and both Celery files remain local.

- [ ] **Step 2: Create the integration branch**

Run `git switch -c codex/a3-latest-integration`.

- [ ] **Step 3: Stage the complete project snapshot**

Stage all tracked and untracked project content except the two Celery pidbox exchange files. Inspect `git diff --cached --name-status` and confirm source, tests, migrations, assets, `.superpowers/`, `outputs/`, and `skills-lock.json` are present.

- [ ] **Step 4: Commit the recoverable snapshot**

Commit with `git commit -m "feat: preserve latest A3 product work"`. Record the commit hash; this commit is the authoritative pre-merge manifest.

### Task 2: Merge the completed homepage branch

**Files:**
- Merge source: `codex/a3-product-homepage`
- Merge target: `codex/a3-latest-integration`
- Expected overlap: 14 paths reported by the preflight comparison

- [ ] **Step 1: Merge without deleting either source branch**

Run `git merge --no-ff codex/a3-product-homepage`.

- [ ] **Step 2: Inventory conflicts**

Run `git diff --name-only --diff-filter=U`. Compare the result with the known overlap set and stop if unrelated paths conflict.

- [ ] **Step 3: Resolve frontend behavior conflicts**

For auth, coaching, digital teacher, teacher workbench, shell, and type files, retain the latest authenticated product functionality while incorporating public homepage routing, safe login return paths, homepage teacher evidence, VRM resilience, reduced-motion handling, and disposal behavior.

- [ ] **Step 4: Resolve dependency and test conflicts**

Reconcile `package.json`, `pnpm-lock.yaml`, generation scripts, and overlapping tests without dropping dependencies or assertions from either side. Regenerate the lockfile only if the semantic merge cannot be represented safely.

- [ ] **Step 5: Commit the merge**

Confirm `git diff --check` passes, then complete the merge commit.

### Task 3: Prove no original product work was lost

**Files:**
- Compare snapshot commit from Task 1 against integration `HEAD`
- Review every path changed by both sides

- [ ] **Step 1: Verify non-overlap preservation**

Compute the original snapshot paths that were not touched by the homepage branch and confirm their blob hashes are unchanged after the merge.

- [ ] **Step 2: Review every overlap**

Inspect the final diff for all overlapping paths. Confirm both the original product behavior and homepage behavior have corresponding code or tests.

- [ ] **Step 3: Check repository hygiene**

Run `git status --short --branch` and confirm the only permitted local changes are the two Celery pidbox exchange files.

### Task 4: Verify the integrated product

**Files:**
- Test: `OpenMAIC/tests/`
- Test: `OpenMAIC/e2e/tests/`
- Test: `backend/apps/**/tests/`

- [ ] **Step 1: Verify frontend static checks**

Run `npx.cmd tsc --noEmit` and `pnpm.cmd lint` from `OpenMAIC`. Expected: TypeScript exit 0; ESLint has 0 errors and only documented historical warnings.

- [ ] **Step 2: Verify focused unit coverage**

Run the homepage, authentication, coaching, classroom, knowledge graph, knowledge base, teacher workbench, and Playwright runtime Vitest files changed by either side. Expected: 0 failures.

- [ ] **Step 3: Verify backend contracts**

Run `backend\\.venv\\Scripts\\python.exe backend\\manage.py check` and `validate_demo_flow --skip-seed --strict` with the local backend environment. Expected: both exit 0.

- [ ] **Step 4: Verify browser workflows**

Run the homepage suite, route smoke, classroom, coaching, knowledge graph, and knowledge base Playwright specs against the integration checkout. Expected: 0 failures.

### Task 5: Serve the final integration checkout

**Files:**
- Runtime only; no source changes

- [ ] **Step 1: Stop the homepage-only server on port 3000**

Confirm its command line points to `D:\\Download\\A3-worktrees\\a3-product-homepage\\OpenMAIC`, then stop only that process tree.

- [ ] **Step 2: Start the integration frontend on port 3000**

Start Next.js from `D:\\Download\\A3\\OpenMAIC` in a hidden background process.

- [ ] **Step 3: Verify review URLs**

Confirm HTTP 200 for `/a3`, `/a3/classroom`, `/a3/coaching`, `/a3/knowledge-graph`, and `/a3/knowledge-base`, and confirm the process command line points to the integration checkout.

- [ ] **Step 4: Report branch disposition**

Keep both source branches and the homepage worktree intact. Report the integration branch, snapshot commit, merge commit, verification evidence, and any residual risks.
