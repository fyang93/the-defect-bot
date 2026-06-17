set shell := ["bash", "-cu"]

# Show available recipes and examples.
default:
    @just --list

alias i := install
alias s := serve

# Install project dependencies.
install:
    npm install

# Run the bot. Usage: `just serve`.
serve:
    mkdir -p logs; \
    npm run bot

# Run manual test suite, including live natural-language tests.
test:
    npm run test
    npm run test:live

# Run only live natural-language tests against Pi SDK manually.
test-live:
    npm run test:live
