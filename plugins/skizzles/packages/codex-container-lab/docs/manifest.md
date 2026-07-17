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
```

`files` are passed to Compose in order and remain rooted at the consuming repository, so relative build contexts, env files, configs, and bind mounts preserve normal Compose behavior. The command service must already be long-running. The generated override mounts the isolated clone at `runtime.workspace`, sets `init`, adds management labels, and adds random `127.0.0.1` publications for declared ports.

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
```

The selected image must satisfy the compatibility contract: a normal distro, configured shell, `setsid`, writable workspace, and usable long-running command service. Distroless images do not satisfy this contract.

All project paths must be relative and remain inside the repository. Container workspace and shell executable paths must be normalized absolute paths. Environment forwarding accepts variable names only; values come from the attached CLI environment and are never persisted in lab metadata.
