---
"@sjshovan/dkb-library": patch
---

Bound archive extraction by expanded payload bytes, entry count, and a conservative
destination free-space budget before admitting file writes. Reject unknown capacity
and preserve caller-owned staging cleanup, without a second decompression pass.
