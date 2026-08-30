# DKB Console Design System

The Console inherits the Registry's established product language and adapts it
to a denser operational surface. Filament is an information-design reference,
not a dependency or a visual clone.

## Foundation

- **Typography:** Instrument Sans for interface copy, labels, headings, and data.
- **Identity:** DKB indigo `#3147ff` for primary actions, focus, selection, and
  current identity. The dark-mode accent is `#9aa6ff`.
- **Light surfaces:** ink `#101017`, cream `#fbf7ed`, vellum `#efe7d4`, white,
  and border `#d8cfbd`.
- **Dark surfaces:** `#08080d`, `#101017`, `#171723`, border `#303044`, and
  cream foreground `#fbf7ed`.
- **Shape:** 10px controls, 12px panels, and full pills only for compact status.
- **Focus:** a visible 2px indigo ring with offset on every keyboard target.
- **Motion:** 150–220ms state transitions; none when reduced motion is requested.

## Component vocabulary

Accessible Reka primitives support dialogs, drawers, menus, tabs, selects, and
tooltips. DKB interface components own button, field, badge, table, empty,
loading, error, recovery, and operation patterns. Resource components then
compose Library, Runtime, Registry, Stack, package, pipeline, build, and
provenance information. Pages do not invent local control styles.

## Density and hierarchy

Desktop uses a collapsible ink sidebar, a compact context bar, dense tables, and
side inspection panels. Mobile uses a compact top bar, five-item bottom
navigation, structured resource rows, full-screen detail routes, and sticky
confirmation controls. The two layouts share one information model; mobile is
not a compressed desktop table.

## Content and states

Actions use the operator's language: Set as default, Authenticate, Retry check,
Stop, Forget, Uninstall, Delete. Status distinguishes known from checked and
offline from invalid. Every list ships loading skeletons, useful empty states,
degraded explanations, and exact recovery actions. No status relies on color
alone.

## Excluded Registry patterns

The Console does not reuse the Registry's 3D backgrounds, marketing heroes,
editorial scroll effects, animated demonstrations, decorative terminals, grid
effects, or public-catalog promotion.
