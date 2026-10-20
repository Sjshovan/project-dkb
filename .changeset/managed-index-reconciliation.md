---
"@sjshovan/dkb-runtime": minor
"@sjshovan/dkb-pipeline": minor
"@sjshovan/dkb-index-meilisearch": patch
"@sjshovan/dkb-cli": patch
---

Record managed imports before external side effects and reconcile removed package
versions after Runtime activation. Keep installed releases and inactive spaces,
retry failed cleanup from durable Runtime receipts, and surface maintenance
warnings without misreporting a current activation as stale. Managed API v3
providers now declare a credential-free backing-store identity; cleanup rejects
recipe, option, or resolved-store drift instead of deleting through another service.
