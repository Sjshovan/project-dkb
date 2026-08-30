# DKB Console surface brief

## Responsive shell

At 320–767px, the top bar shows DKB, the current Library, and aggregate health.
Bottom navigation exposes Overview, Libraries, Runtimes, Registries, and More;
More contains Stacks, Activity, appearance, and Console settings. Touch targets
are at least 44px and form controls remain at least 16px.

At 768px and above, the bottom navigation becomes a collapsible left sidebar.
A compact context bar shows default Library, Runtime, Registry, Stack, active
pipeline, and current operations. Tables may be sorted and filtered. Detail is
shown beside a list when space permits and as a dedicated page when it does not.

## Information architecture

- **Overview:** defaults, attention queue, health, installed knowledge, builds,
  and recent activity.
- **Libraries:** host Libraries; detail owns installed DKBs, Collections,
  dependencies, pipelines, builds, storage, and provenance. A DKB detail page
  has Overview, Contents, Builds, Provenance, and Integrity sections. A
  Collection uses Overview, Members, Provenance, and Integrity. Contents use a
  bounded directory browser and escaped, inert preview; active content is never
  rendered. Integrity is refreshed only when the user runs Verify and exposes
  check-level recovery context.
- **Runtimes:** endpoints, Library association, version, health, and available
  local controls.
- **Registries:** endpoints, authentication state, health, Library usage, and
  package search. Server administration stays in the Registry application.
- **Stacks:** known local stacks, targets, services, health, start/stop, logs,
  backup, restore, and doctor.
- **Activity:** live and recent operations, warnings, result, recovery, and
  cancellation where the underlying command supports it.

Opening a resource never mutates defaults. Default selection and destructive
actions are visually separated. Tables transform into labeled summary rows on
mobile rather than scrolling horizontally.

## Reference data

Visual development uses the real host inventory shape: multiple Libraries,
Registries, Runtimes, and Stacks with a mix of ready, known, missing, degraded,
and offline states. No fabricated usage, popularity, or reliability claims are
shown.
