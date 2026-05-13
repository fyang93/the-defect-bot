set shell := ["bash", "-cu"]

# Show available recipes and examples.
default:
    @just --list

alias i := install
alias s := serve

# Install project dependencies.
install:
    npm install

# Start a fresh project-local OpenCode server, then run the bot. Usage: `just serve`.
serve:
    mkdir -p logs; \
    self=$$; \
    pids=$(pgrep -f 'node_modules/.bin/opencode serve --port 4096|npm exec -- opencode serve --port 4096|npx --no-install opencode serve --port 4096' | grep -vx "$self" || true); \
    for pid in $pids; do \
        kill "$pid" 2>/dev/null || true; \
    done; \
    npm exec -- opencode serve --port 4096 > logs/opencode-server.log 2>&1 & \
    opencode_pid=$!; \
    trap 'kill "$opencode_pid" 2>/dev/null || true' EXIT; \
    sleep 2; \
    npm run bot

# Run manual test suite, including live natural-language tests.
test:
    npm run test
    npm run test:live

# Run only live natural-language tests against OpenCode manually.
test-live:
    npm run test:live
