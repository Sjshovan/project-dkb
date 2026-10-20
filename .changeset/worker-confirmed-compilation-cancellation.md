---
"@sjshovan/dkb-pipeline": minor
"@sjshovan/dkb-compiler": patch
"@sjshovan/dkb-evidence-docling-llamaindex": minor
---

Add provider-owned execution recovery and worker-confirmed cancellation. Keep
the Evidence worker warm across successful jobs, require protocol 5 exact-job
acknowledgments, and retain private pending state and scratch until termination
and cleanup are confirmed. Upgrade compiler and Evidence worker images together.
