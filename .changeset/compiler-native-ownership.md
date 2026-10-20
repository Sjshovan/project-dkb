---
"@sjshovan/dkb-library": patch
"@sjshovan/dkb-compiler": patch
---

Use native same-storage ownership for compilation instead of reclaiming aged
directory locks. Preserve unresolved previous-version guards and reject shared
Windows/Docker mounts. Cancel queued work without taking ownership, retain an
admitted compiler's lease through provider cleanup, and preserve worker-stop
uncertainty when secondary lease cleanup fails.

Avoid PowerShell cold-start overhead on Windows when the built-in read-only
drive-metadata probe is available. Preserve the same fixed/ready/NTFS requirement,
independent .NET verification on probe unavailability, and fail-closed rejection.

Resolve the recipe and execute a compile through one job-scoped provider host.
Revalidate code and recipe inputs before promotion or cache reuse, and dispose
on success, cancellation, or failure without masking the original failure.
