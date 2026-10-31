#!/bin/bash
# Synthetic service E2E. Source the real service, then inject host boundaries. No Docker daemon,
# mount, root operation, real account, or live OpenBot instance is used inside this fixture.
set -euo pipefail
source "$1/docker/instances/openbot-instance"

fixture=$(mktemp -d /tmp/openbot-backup-stop.XXXXXX)
trap 'rm -rf -- "$fixture"' EXIT
HERE=$fixture/config
DATA=$fixture/instances
LOCKS=$fixture/locks
mkdir -p "$HERE" "$LOCKS"

# The process stays unprivileged. Only the script's root guard and host adapters are replaced.
id() { echo 0; }
mountpoint() { return 0; }
data_owner() { echo "$(command id -u):$(command id -g)"; }
as_owner() { "$@"; }

docker() {
  case $1 in
    info) echo '[]' ;;
    inspect)
      case $3 in
        '{{.State.Running}}') cat "$fixture/state" ;;
        '{{.State.ExitCode}}') echo "$stop_exit" ;;
        '{{.Config.Image}}') echo 'synthetic/openbot:1.0.0' ;;
        '{{.Image}}') echo 'sha256:synthetic' ;;
        '{{index .Config.Labels "org.opencontainers.image.version"}}') echo '1.0.0' ;;
        *) return 91 ;;
      esac
      ;;
    stop) echo stop >>"$fixture/events"; echo false >"$fixture/state" ;;
    start) echo start >>"$fixture/events"; echo true >"$fixture/state" ;;
    *) return 92 ;;
  esac
}

tar() {
  [ "$copy_fails" = false ] || return 73
  command tar "$@"
}

# SQLite/archive verification has its own full E2E. This boundary records its call and can fail
# after the real backup is committed, to check that verification cannot restart the source.
verify_locked() {
  echo verify >>"$fixture/events"
  [ "$verify_fails" = false ]
}

reset_case() {
  rm -rf -- "$DATA" "$fixture/backups"
  mkdir -p "$DATA/main/data/.config/OpenBot" "$DATA/main/data/.local/share/keyrings" \
    "$DATA/main/data/.config/openbot-container" "$DATA/main/data/Workspace"
  printf 'synthetic database bytes\n' >"$DATA/main/data/.config/OpenBot/openbot.db"
  printf 'synthetic keyring bytes\n' >"$DATA/main/data/.local/share/keyrings/login.keyring"
  printf 'synthetic password\n' >"$DATA/main/data/.config/openbot-container/keyring-password"
  printf 'synthetic workspace bytes\n' >"$DATA/main/data/Workspace/file.txt"
  printf 'OPENBOT_BACKUP_DIR=%s/backups\nOPENBOT_BACKUP_KEEP=7\n' "$fixture" >"$HERE/main.env"
  echo true >"$fixture/state"
  : >"$fixture/events"
  copy_fails=false
  verify_fails=false
  stop_exit=0
}

run_backup() {
  set +e
  (set -e; backup main "$@") >"$fixture/stdout" 2>"$fixture/stderr"
  result=$?
  set -e
}

pass() { printf 'PASS %s\n' "$1"; }
assert_stopped() {
  [ "$(cat "$fixture/state")" = false ]
  ! grep -q '^start$' "$fixture/events"
}
assert_no_partial() {
  [ -z "$(find "$fixture/backups" -name '*.partial' -print)" ]
}

reset_case
run_backup --keep-stopped --verify
[ "$result" -eq 0 ]
assert_stopped
[ "$(cat "$fixture/events")" = $'stop\nverify' ]
backup_folder=$(find "$fixture/backups/main" -mindepth 1 -maxdepth 1 -type d)
grep -q '"keptStopped": true' "$backup_folder/manifest.json"
(cd "$backup_folder" && sha256sum --check --quiet --strict SHA256SUMS)
mkdir "$fixture/unpacked"
archive=$(json_value "$backup_folder/manifest.json" archive)
decompress "$archive" "$backup_folder/$archive" | command tar -xf - -C "$fixture/unpacked"
cmp "$DATA/main/data/Workspace/file.txt" "$fixture/unpacked/Workspace/file.txt"
cmp "$DATA/main/data/.local/share/keyrings/login.keyring" "$fixture/unpacked/.local/share/keyrings/login.keyring"
assert_no_partial
pass kept-stopped-success

reset_case
run_backup --verify --keep-stopped
[ "$result" -eq 0 ]
assert_stopped
pass option-order

reset_case
run_backup --keep-stopped
[ "$result" -eq 0 ]
assert_stopped
[ "$(cat "$fixture/events")" = stop ]
pass kept-stopped-without-verify

reset_case
echo false >"$fixture/state"
stop_exit=137
run_backup --keep-stopped --verify
[ "$result" -eq 0 ]
assert_stopped
[ "$(cat "$fixture/events")" = verify ]
grep -q '"stopExitCode": null' "$fixture"/backups/main/*/manifest.json
pass already-stopped

reset_case
copy_fails=true
run_backup --keep-stopped
[ "$result" -ne 0 ]
assert_stopped
assert_no_partial
[ -z "$(find "$fixture/backups" -name manifest.json -print)" ]
grep -q '"result": "failed"' "$DATA/main/backup-status/backup-attempt.json"
pass copy-failure-stays-stopped

reset_case
verify_fails=true
run_backup --keep-stopped --verify
[ "$result" -ne 0 ]
assert_stopped
[ "$(cat "$fixture/events")" = $'stop\nverify' ]
[ -n "$(find "$fixture/backups" -name manifest.json -print)" ]
pass verification-failure-stays-stopped

reset_case
stop_exit=137
run_backup --keep-stopped --verify
[ "$result" -ne 0 ]
assert_stopped
assert_no_partial
[ -z "$(find "$fixture/backups" -name manifest.json -print)" ]
grep -q 'no migration backup was made' "$fixture/stderr"
pass unclean-stop-refused

reset_case
rm "$DATA/main/data/.config/openbot-container/keyring-password"
run_backup --keep-stopped
[ "$result" -ne 0 ]
[ "$(cat "$fixture/state")" = true ]
[ ! -s "$fixture/events" ]
pass preflight-failure-keeps-running-state

reset_case
run_backup --unknown-option
[ "$result" -ne 0 ]
[ ! -s "$fixture/events" ]
pass unknown-option-refused

reset_case
run_backup --verify
[ "$result" -eq 0 ]
[ "$(cat "$fixture/state")" = true ]
[ "$(cat "$fixture/events")" = $'stop\nstart\nverify' ]
grep -q '"keptStopped": false' "$fixture"/backups/main/*/manifest.json
pass default-restarts

reset_case
copy_fails=true
run_backup
[ "$result" -ne 0 ]
[ "$(cat "$fixture/state")" = true ]
[ "$(cat "$fixture/events")" = $'stop\nstart' ]
assert_no_partial
pass default-failure-restarts

reset_case
stop_exit=137
run_backup
[ "$result" -eq 0 ]
[ "$(cat "$fixture/state")" = true ]
grep -q 'SQLite keeps the last complete transaction' "$fixture/stderr"
pass default-unclean-stop-keeps-existing-policy
