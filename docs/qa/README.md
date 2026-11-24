# Captain QA

| File | Purpose |
|---|---|
| `acceptance-spine.sh` | Runs `docs/ACCEPTANCE.md` A1–A8 and B9, B10, B12, B13 against a live API and prints expected vs actual. B11 (opname) is Sprint 2. |
| `QA-LOG.md` | Hand-run results after each merge, with the real figures. |

```bash
# start the API on :8080 first, then:
API_BASE=http://127.0.0.1:8080/v1 ./docs/qa/acceptance-spine.sh
# section E against the seeded demo tenant:
API_BASE=http://127.0.0.1:8080/v1 STAFF_EMAIL=staff@demo.test STAFF_PASSWORD='<seed password>' \
  ./docs/qa/acceptance-spine.sh
```

Exit code is the number of failed checks. Every run creates a new tenant and never deletes
data that another run created.