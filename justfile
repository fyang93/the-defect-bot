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

# Update the Pi CLI, project packages, and SDK once per local calendar day.
update-pi:
    #!/usr/bin/env bash
    set -u
    mkdir -p tmp
    exec 9>tmp/.pi-update.lock
    flock -n 9 || exit 0
    today=$(date +%F)
    [[ "$(cat tmp/.pi-last-update 2>/dev/null || true)" == "$today" ]] && exit 0
    cp package.json tmp/.pi-package.json.bak
    cp package-lock.json tmp/.pi-package-lock.json.bak
    if (cd agent && pi update --all) \
      && npm install @earendil-works/pi-ai@latest @earendil-works/pi-coding-agent@latest \
      && npm run check && npm test; then
        printf '%s\n' "$today" > tmp/.pi-last-update
    else
        echo "Pi update failed validation; restoring the previous SDK version." >&2
        mv tmp/.pi-package.json.bak package.json
        mv tmp/.pi-package-lock.json.bak package-lock.json
        npm install
    fi
    rm -f tmp/.pi-package.json.bak tmp/.pi-package-lock.json.bak

# Run the bot, refresh Pi after 04:00 local time daily, and restart on success.
serve:
    #!/usr/bin/env bash
    set -u
    mkdir -p logs
    just update-pi
    serve_pid=$$
    restart=0
    stopping=0
    bot=""
    (while sleep 1h; do
        (( 10#$(date +%H) < 4 )) && continue
        before=$(cat tmp/.pi-last-update 2>/dev/null || true)
        just update-pi
        after=$(cat tmp/.pi-last-update 2>/dev/null || true)
        [[ "$after" != "$before" ]] && kill -HUP "$serve_pid"
    done) & updater=$!
    trap 'restart=1; [[ -n "$bot" ]] && kill -TERM "$bot" 2>/dev/null || true' HUP
    trap 'stopping=1; kill "$updater" 2>/dev/null || true; [[ -n "$bot" ]] && kill -TERM "$bot" 2>/dev/null || true' INT TERM
    trap 'kill "$updater" 2>/dev/null || true' EXIT
    while (( ! stopping )); do
        restart=0
        npm run bot & bot=$!
        wait "$bot"
        status=$?
        bot=""
        (( restart )) && continue
        exit "$status"
    done

# Open the project Pi assistant workspace interactively.
agent:
    cd agent && pi

# Run manual test suite, including live natural-language tests.
test:
    npm run test
    npm run test:live

# Run only live natural-language tests against Pi SDK manually.
test-live:
    npm run test:live
