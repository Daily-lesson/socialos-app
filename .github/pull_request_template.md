<!--
  PR template. Fill in each section; delete guidance comments.
  Keep the title imperative and scoped, e.g. "fix: stop placeholder keys 401-ing requests".
-->

## Summary

<!-- What does this PR do, in 1–3 sentences? -->

## Why / context

<!-- The problem, bug, or user-facing symptom this addresses. Link the issue if any. -->

Closes #

## Changes

<!-- Bullet the notable changes. Note the area of the codebase each one touches. -->

-

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change (migration / behavior change)
- [ ] Docs / tooling only

## Testing

<!-- How did you verify this? Commands + what you observed. -->

- [ ] Typecheck / lint passes
- [ ] Automated tests pass
- [ ] Build succeeds
- [ ] Manually exercised the affected flow (describe below)

<!-- Notes on manual verification: -->

## Database / config impact

<!-- Delete if N/A. -->

- [ ] Adds or changes a database migration (no applied migration edited)
- [ ] Requires new / changed environment variables (list them — names only, no secrets)
- [ ] Affects auth / session / access control

## Screenshots

<!-- For UI changes: before / after. Delete if N/A. -->

## Checklist

- [ ] Scoped to one concern; unrelated changes split out
- [ ] No secrets, tokens, or internal hostnames in the diff
- [ ] Updated docs (README / CLAUDE.md) if a route / page / module was added or moved
