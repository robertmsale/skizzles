# Consuming repository manifest

A consuming Git repository commits `.codex-container-lab.yaml`. Exactly one lifecycle mode is required.

## Compose mode

```yaml
compose:
  files:
    - compose.yaml
    - compose.dev.yaml
  command_service: app
runtime:
  workspace: /workspace
  shell: [/bin/bash, -lc]
ports:
  web:
    service: app
    target: 3000
    scheme: http
environment:
  - OPTIONAL_PUBLIC_REGISTRY
secret_environment: []
```

`files` are passed to Compose in order and remain rooted at the consuming repository, so relative build contexts, env files, configs, and bind mounts preserve normal Compose behavior. The command service must already be long-running. The generated override mounts the isolated clone at `runtime.workspace`, sets `init`, adds management labels, and adds random `127.0.0.1` publications for declared ports.

### Environment forwarding and Compose secret sources

`environment` is the explicit command-service forwarding allowlist. Its list-form names are passed to Compose as-is, so Compose resolves each name from the invoking CLI process environment when the service starts. It is not a general-purpose project environment block, and the values are not written to the lab manifest or other durable state.

`secret_environment` is a separate, optional allowlist for project-owned Compose top-level secret sources. The lab does not generate secret definitions; the project's Compose model may define a source with the shape `{ environment: VAR }`:

```yaml
environment:
  - OPTIONAL_PUBLIC_REGISTRY
secret_environment:
  - OPTIONAL_DATABASE_URL
```

At create/provision time, every allowlisted name must be present in the invoking CLI's own environment, and every environment-backed source in the normalized Compose model must be allowlisted. Secret names, not values, are persisted. Values are injected only for the Compose config/up operation; they never appear in generated YAML, argv, durable state, metadata, findings, errors, or public output. A name cannot occur in both `environment` and `secret_environment`; overlapping names are rejected. A no-interpolation normalized model is checked for declared source-name references in plaintext service environment definitions, and Compose diagnostics are replaced with fixed redacted errors before they can cross the CLI boundary.

## Dockerfile shorthand

```yaml
dockerfile:
  path: Dockerfile
  context: .
  service: lab
runtime:
  workspace: /workspace
  shell: [/bin/bash, -lc]
ports: {}
environment: []
secret_environment: []
```

The engine generates one internal Compose service with the build definition and a durable foreground command, then applies the same override/lifecycle path as Compose mode.

## Image shorthand

```yaml
image:
  name: ubuntu:24.04
  service: lab
runtime:
  workspace: /workspace
  shell: [/bin/bash, -lc]
ports: {}
environment: []
secret_environment: []
```

The selected image must satisfy the compatibility contract: a normal distro, configured shell, `setsid`, writable workspace, and usable long-running command service. Distroless images do not satisfy this contract.

All project paths must be relative and remain inside the repository. Container workspace and shell executable paths must be normalized absolute paths. Both environment fields accept variable names only; `environment` forwards the names to the command service, while `secret_environment` authorizes project-owned Compose top-level sources. Secret values are ephemeral and never persisted in lab metadata.
