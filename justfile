set shell := ["bash", "-cu"]

# Show available recipes and examples.
default:
    @just --list

alias i := install
alias s := serve
alias a := agent

# Install project dependencies.
install:
    npm install

# Run the bot. Usage: `just serve`.
serve:
    mkdir -p logs; \
    npm run bot

# Open a Pi interactive session using this repository's agent workspace.
agent:
    mkdir -p agent/.pi/sessions; \
    PI_CODING_AGENT_DIR="$PWD/agent/.pi" \
    PI_CODING_AGENT_SESSION_DIR="$PWD/agent/.pi/sessions" \
    pi --name "Defect Bot assistant"

# Run manual test suite, including live natural-language tests.
test:
    npm run test
    npm run test:live

# Run only live natural-language tests against Pi SDK manually.
test-live:
    npm run test:live
