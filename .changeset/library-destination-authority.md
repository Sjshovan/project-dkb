---
"@sjshovan/dkb-cli": patch
---

Keep native package installation, upgrades and removal bound to the selected
Library. An explicit Runtime URL requests a post-commit refresh only; it cannot
redirect the mutation or bypass the upgrade generation check. Failed refreshes
report recovery warnings without undoing verified Library changes.
