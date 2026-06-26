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

# Open the project Pi assistant workspace interactively.
agent:
    cd agent && PI_CODING_AGENT_DIR=.pi PI_CODING_AGENT_SESSION_DIR=.pi/sessions pi --no-context-files --append-system-prompt "$$(cat AGENTS.md)"

# Run manual test suite, including live natural-language tests.
test:
    npm run test
    npm run test:live

# Run only live natural-language tests against Pi SDK manually.
test-live:
    npm run test:live
