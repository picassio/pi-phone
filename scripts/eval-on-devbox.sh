#!/usr/bin/env bash
# One eval run on the devbox with a subscription's short-lived token (PP-476). Run on the phone, where the token is a
# pi-phone secret the owner approved on a secret_save card; name it on the command line so the app passes it:
#
#   EVAL_ANTHROPIC_TOKEN="$EVAL_ANTHROPIC_TOKEN" scripts/eval-on-devbox.sh scripts/prompt-eval.ts --compare origin/master
#   scripts/eval-on-devbox.sh scripts/prompt-eval.ts --compare origin/master --dry-run     (the count only, no token)
#
# The token goes over pi-ssh on stdin, never in an argument or a file: on the devbox it lives in the eval's environment
# alone, and the eval runs with a temporary HOME and TMPDIR (its auth.json is in there), removed when it ends however it
# ends. Evals never run on OpenRouter: the eval refuses it. The tree it runs is the devbox's ~/tmp/pi15 (--dir to change
# it, relative to the devbox's home): bring the change there first.
set -euo pipefail

host=tuanlh-devbox-01
dir=tmp/pi15
node_bin=/home/ubuntu/.local/share/mise/installs/node/26.12.0/bin

if [ "${1:-}" = "--dir" ]; then
    dir=$2
    shift 2
fi

if [ $# -eq 0 ]; then
    echo "usage: scripts/eval-on-devbox.sh [--dir tmp/pi15] scripts/prompt-eval.ts [its options]" >&2
    exit 64
fi

token=${EVAL_ANTHROPIC_TOKEN:-}
dry_run=no

for arg in "$@"; do
    if [ "$arg" = "--dry-run" ]; then
        dry_run=yes
    fi
done

if [ "$dry_run" = yes ]; then
    token=
elif [ -z "$token" ]; then
    echo "eval-on-devbox: EVAL_ANTHROPIC_TOKEN is needed: ask the owner to approve a subscription token (secret_save), then name it: EVAL_ANTHROPIC_TOKEN=\"\$EVAL_ANTHROPIC_TOKEN\" $0 …" >&2
    exit 1
fi

# On the devbox: the token from the first line of stdin, a temporary home removed on any exit, the eval, its status.
remote='set -eu; dir=$1; shift; IFS= read -r token || true; tmp=$(mktemp -d); trap '\''rm -rf "$tmp"'\'' EXIT; trap '\''exit 130'\'' HUP INT TERM; mkdir "$tmp/tmp"; cd "$dir"; export PATH="'"$node_bin"':$PATH"; if [ -n "$token" ]; then export EVAL_ANTHROPIC_TOKEN="$token"; fi; unset token; status=0; HOME="$tmp" TMPDIR="$tmp/tmp" node "$@" || status=$?; exit "$status"'

printf '%s\n' "$token" | pi-ssh "$host" "bash -c $(printf '%q' "$remote") eval-on-devbox $(printf '%q ' "$dir" "$@")"
