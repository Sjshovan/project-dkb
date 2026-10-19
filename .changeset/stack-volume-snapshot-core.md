---
"@sjshovan/dkb-cli": patch
---

Connect recorded Docker-volume backups to bounded binary streaming and the
owner-side snapshot worker, preserving Linux ownership and contained links
without opening live Docker databases on Windows. Refuse existing output paths
and verify the complete stream before archive promotion. Empty-staging restore
preserves exact file modes despite extraction umasks; full Stack recovery still
requires topology promotion, so volume-backed upgrades remain blocked rather
than claiming an available rollback. Use exclusively owned archive staging,
preserve racing destinations, and set Linux file permissions before publication.
Originals are never replaced by this worker.
