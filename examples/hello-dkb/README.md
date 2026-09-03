# Example Operations Handbook

This deliberately small package proves the first-run flow without using private
knowledge:

```powershell
dkb validate .\examples\hello-dkb
dkb build .\examples\hello-dkb --pipeline fastembed-faiss
dkb query "What is the recovery marker?"
```

Expected evidence contains `EXAMPLE-RECOVERY-42` and cites
`knowledge/incident-response.md`. The example is CC0-1.0 and safe to copy.
