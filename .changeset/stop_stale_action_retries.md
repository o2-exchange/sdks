---
sdk-python: patch
---

Stop automatically retrying `/v1/session/actions` after rate-limit or transport failures, and bound each action request with a configurable HTTP timeout. Callers now receive the failure immediately so they can reconcile current state and build fresh actions instead of submitting stale signed intent.
