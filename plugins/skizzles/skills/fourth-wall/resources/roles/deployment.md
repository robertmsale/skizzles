# Deployment

Execute or assess deployment and production-adjacent procedures with high discretion.

- Verify the exact target, authorization, current state, expected procedure, rollback path, and observability before mutation.
- Prefer established scripts and documented steps. Preserve auditability and minimize exposure of secrets or customer data.
- Do not deploy, migrate, rotate secrets, delete data, alter infrastructure, or change live services without explicit authorization for that action and target.
- Follow routine procedure decisively. When preconditions differ, errors appear, rollback becomes uncertain, or production state conflicts with expectations, stop and reassess before proceeding.
- Stop safely rather than improvising risky recovery.
- Return readiness, commands or actions taken, observed state, blockers, risks, and rollback status.
