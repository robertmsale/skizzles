set dotenv-load := false

[private]
default: help

# List the source-checkout workflows.
help:
    #!/bin/sh
    set -eu
    cd {{ quote(justfile_directory()) }}
    just --justfile {{ quote(justfile_directory() + "/justfile") }} --list

# Install frozen dependencies and validate the complete generated-plugin boundary.
setup:
    #!/bin/sh
    set -eu
    cd {{ quote(justfile_directory()) }}
    bun install --frozen-lockfile
    just --justfile {{ quote(justfile_directory() + "/justfile") }} package

# Run the complete generated-plugin boundary in its required order.
package:
    #!/bin/sh
    set -eu
    cd {{ quote(justfile_directory()) }}
    bun run typecheck
    bun test
    bun run plugin:check
    bun run plugin:build
    bun run plugin:check

# Show help for the checkout-local generic Container Lab launcher.
lab-help:
    #!/bin/sh
    set -eu
    cd {{ quote(justfile_directory()) }}
    bun skills/codex-container-lab/scripts/codex-container-lab --help

# Preview installation of checkout skills into an explicit Codex home.
skills-install-preview codex_home transfer="link":
    #!/bin/sh
    set -eu
    case {{ quote(codex_home) }} in
        /*) ;;
        *) echo "codex_home must be an absolute path" >&2; exit 2 ;;
    esac
    case {{ quote(transfer) }} in
        link|copy) ;;
        *) echo "transfer must be link or copy" >&2; exit 2 ;;
    esac
    cd {{ quote(justfile_directory()) }}
    bun run packages/skizzles-installer/src/cli.ts install --source-root {{ quote(justfile_directory()) }} --codex-home {{ quote(codex_home) }} --surface skills --transfer {{ quote(transfer) }} --dry-run

# Apply installation of checkout skills into an explicit Codex home.
skills-install-apply codex_home transfer="link":
    #!/bin/sh
    set -eu
    case {{ quote(codex_home) }} in
        /*) ;;
        *) echo "codex_home must be an absolute path" >&2; exit 2 ;;
    esac
    case {{ quote(transfer) }} in
        link|copy) ;;
        *) echo "transfer must be link or copy" >&2; exit 2 ;;
    esac
    cd {{ quote(justfile_directory()) }}
    bun run packages/skizzles-installer/src/cli.ts install --source-root {{ quote(justfile_directory()) }} --codex-home {{ quote(codex_home) }} --surface skills --transfer {{ quote(transfer) }}

# Preview installation of the checkout harness into an explicit home.
harness-install-preview home transfer="link":
    #!/bin/sh
    set -eu
    case {{ quote(home) }} in
        /*) ;;
        *) echo "home must be an absolute path" >&2; exit 2 ;;
    esac
    case {{ quote(transfer) }} in
        link|copy) ;;
        *) echo "transfer must be link or copy" >&2; exit 2 ;;
    esac
    cd {{ quote(justfile_directory()) }}
    bun run packages/skizzles-installer/src/cli.ts install --source-root {{ quote(justfile_directory()) }} --home {{ quote(home) }} --surface harness --transfer {{ quote(transfer) }} --dry-run

# Apply installation of the checkout harness into an explicit home.
harness-install-apply home transfer="link":
    #!/bin/sh
    set -eu
    case {{ quote(home) }} in
        /*) ;;
        *) echo "home must be an absolute path" >&2; exit 2 ;;
    esac
    case {{ quote(transfer) }} in
        link|copy) ;;
        *) echo "transfer must be link or copy" >&2; exit 2 ;;
    esac
    cd {{ quote(justfile_directory()) }}
    bun run packages/skizzles-installer/src/cli.ts install --source-root {{ quote(justfile_directory()) }} --home {{ quote(home) }} --surface harness --transfer {{ quote(transfer) }}

# Inspect installation state for explicit harness and Codex homes.
install-doctor home codex_home:
    #!/bin/sh
    set -eu
    case {{ quote(home) }} in
        /*) ;;
        *) echo "home must be an absolute path" >&2; exit 2 ;;
    esac
    case {{ quote(codex_home) }} in
        /*) ;;
        *) echo "codex_home must be an absolute path" >&2; exit 2 ;;
    esac
    cd {{ quote(justfile_directory()) }}
    bun run packages/skizzles-installer/src/cli.ts doctor --home {{ quote(home) }} --codex-home {{ quote(codex_home) }}

# Preview removal of checkout skills from an explicit Codex home.
skills-uninstall-preview codex_home:
    #!/bin/sh
    set -eu
    case {{ quote(codex_home) }} in
        /*) ;;
        *) echo "codex_home must be an absolute path" >&2; exit 2 ;;
    esac
    cd {{ quote(justfile_directory()) }}
    bun run packages/skizzles-installer/src/cli.ts uninstall --surface skills --codex-home {{ quote(codex_home) }} --dry-run

# Apply removal of checkout skills from an explicit Codex home.
skills-uninstall-apply codex_home:
    #!/bin/sh
    set -eu
    case {{ quote(codex_home) }} in
        /*) ;;
        *) echo "codex_home must be an absolute path" >&2; exit 2 ;;
    esac
    cd {{ quote(justfile_directory()) }}
    bun run packages/skizzles-installer/src/cli.ts uninstall --surface skills --codex-home {{ quote(codex_home) }}

# Preview removal of the checkout harness from an explicit home.
harness-uninstall-preview home:
    #!/bin/sh
    set -eu
    case {{ quote(home) }} in
        /*) ;;
        *) echo "home must be an absolute path" >&2; exit 2 ;;
    esac
    cd {{ quote(justfile_directory()) }}
    bun run packages/skizzles-installer/src/cli.ts uninstall --surface harness --home {{ quote(home) }} --dry-run

# Apply removal of the checkout harness from an explicit home.
harness-uninstall-apply home:
    #!/bin/sh
    set -eu
    case {{ quote(home) }} in
        /*) ;;
        *) echo "home must be an absolute path" >&2; exit 2 ;;
    esac
    cd {{ quote(justfile_directory()) }}
    bun run packages/skizzles-installer/src/cli.ts uninstall --surface harness --home {{ quote(home) }}

# Preview Codex configuration for explicit mode and instruction choices.
configure-preview codex_home orchestration instructions codex_binary=env("CODEX_BIN", "codex"):
    #!/bin/sh
    set -eu
    case {{ quote(codex_home) }} in
        /*) ;;
        *) echo "codex_home must be an absolute path" >&2; exit 2 ;;
    esac
    case {{ quote(orchestration) }} in
        aggressive|passive) ;;
        *) echo "orchestration must be aggressive or passive" >&2; exit 2 ;;
    esac
    case {{ quote(instructions) }} in
        native|skizzles) ;;
        *) echo "instructions must be native or skizzles" >&2; exit 2 ;;
    esac
    codex_bin="$(command -v {{ quote(codex_binary) }})" || { echo "Codex binary not found: {{ quote(codex_binary) }}" >&2; exit 2; }
    codex_bin="$(realpath "$codex_bin")" || { echo "Codex binary could not be resolved: {{ quote(codex_binary) }}" >&2; exit 2; }
    [ -x "$codex_bin" ] || { echo "Codex binary is not executable: $codex_bin" >&2; exit 2; }
    cd {{ quote(justfile_directory()) }}
    if [ {{ quote(instructions) }} = skizzles ]; then
        bun run packages/skizzles-installer/src/cli.ts configure --codex-home {{ quote(codex_home) }} --codex-binary "$codex_bin" --orchestration {{ quote(orchestration) }} --instructions {{ quote(instructions) }} --source-root {{ quote(justfile_directory()) }} --dry-run
    else
        bun run packages/skizzles-installer/src/cli.ts configure --codex-home {{ quote(codex_home) }} --codex-binary "$codex_bin" --orchestration {{ quote(orchestration) }} --instructions {{ quote(instructions) }} --dry-run
    fi

# Apply Codex configuration for explicit mode and instruction choices.
configure-apply codex_home orchestration instructions codex_binary=env("CODEX_BIN", "codex"):
    #!/bin/sh
    set -eu
    case {{ quote(codex_home) }} in
        /*) ;;
        *) echo "codex_home must be an absolute path" >&2; exit 2 ;;
    esac
    case {{ quote(orchestration) }} in
        aggressive|passive) ;;
        *) echo "orchestration must be aggressive or passive" >&2; exit 2 ;;
    esac
    case {{ quote(instructions) }} in
        native|skizzles) ;;
        *) echo "instructions must be native or skizzles" >&2; exit 2 ;;
    esac
    codex_bin="$(command -v {{ quote(codex_binary) }})" || { echo "Codex binary not found: {{ quote(codex_binary) }}" >&2; exit 2; }
    codex_bin="$(realpath "$codex_bin")" || { echo "Codex binary could not be resolved: {{ quote(codex_binary) }}" >&2; exit 2; }
    [ -x "$codex_bin" ] || { echo "Codex binary is not executable: $codex_bin" >&2; exit 2; }
    cd {{ quote(justfile_directory()) }}
    if [ {{ quote(instructions) }} = skizzles ]; then
        bun run packages/skizzles-installer/src/cli.ts configure --codex-home {{ quote(codex_home) }} --codex-binary "$codex_bin" --orchestration {{ quote(orchestration) }} --instructions {{ quote(instructions) }} --source-root {{ quote(justfile_directory()) }}
    else
        bun run packages/skizzles-installer/src/cli.ts configure --codex-home {{ quote(codex_home) }} --codex-binary "$codex_bin" --orchestration {{ quote(orchestration) }} --instructions {{ quote(instructions) }}
    fi

# Preview removal of Codex configuration for an explicit Codex home.
unconfigure-preview codex_home codex_binary=env("CODEX_BIN", "codex"):
    #!/bin/sh
    set -eu
    case {{ quote(codex_home) }} in
        /*) ;;
        *) echo "codex_home must be an absolute path" >&2; exit 2 ;;
    esac
    codex_bin="$(command -v {{ quote(codex_binary) }})" || { echo "Codex binary not found: {{ quote(codex_binary) }}" >&2; exit 2; }
    codex_bin="$(realpath "$codex_bin")" || { echo "Codex binary could not be resolved: {{ quote(codex_binary) }}" >&2; exit 2; }
    [ -x "$codex_bin" ] || { echo "Codex binary is not executable: $codex_bin" >&2; exit 2; }
    cd {{ quote(justfile_directory()) }}
    bun run packages/skizzles-installer/src/cli.ts unconfigure --codex-home {{ quote(codex_home) }} --codex-binary "$codex_bin" --dry-run

# Apply removal of Codex configuration for an explicit Codex home.
unconfigure-apply codex_home codex_binary=env("CODEX_BIN", "codex"):
    #!/bin/sh
    set -eu
    case {{ quote(codex_home) }} in
        /*) ;;
        *) echo "codex_home must be an absolute path" >&2; exit 2 ;;
    esac
    codex_bin="$(command -v {{ quote(codex_binary) }})" || { echo "Codex binary not found: {{ quote(codex_binary) }}" >&2; exit 2; }
    codex_bin="$(realpath "$codex_bin")" || { echo "Codex binary could not be resolved: {{ quote(codex_binary) }}" >&2; exit 2; }
    [ -x "$codex_bin" ] || { echo "Codex binary is not executable: $codex_bin" >&2; exit 2; }
    cd {{ quote(justfile_directory()) }}
    bun run packages/skizzles-installer/src/cli.ts unconfigure --codex-home {{ quote(codex_home) }} --codex-binary "$codex_bin"
