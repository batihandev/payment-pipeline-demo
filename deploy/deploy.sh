#!/usr/bin/env bash
# Deploys one image tag of the demo stack with near-zero downtime:
#   deploy/deploy.sh <tag>
# 1. pull the app and migrate images while the running stack keeps serving;
# 2. migrate (expand-only), stopping with the running stack untouched on failure;
# 3. start a second API on the new tag and wait for its health check; only then
#    give it the network alias api-live, which the tunnel targets, and stop the
#    old one; a new API that never turns healthy is removed and the old one stays;
# 4. recreate the tracker, then the buyer, stop-then-start (each must run once
#    and keep running without a restart);
# 5. record the deployed and previous tags in .deploy-state and IMAGE_TAG in the
#    settings file;
# 6. remove this repository's images other than the current and previous tags,
#    then every dangling image.
# Postgres, Redis and the tunnel are recreated only when their own config changes.
# Rolling back is a deploy of the previous tag. DEPLOY_ENV_FILE selects another
# settings file than .env beside this script.
set -euo pipefail

if [[ $# -ne 1 || ! $1 =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$ ]]; then
  echo "usage: deploy.sh <image tag>" >&2
  exit 2
fi
readonly tag=$1
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly here
readonly env_file=${DEPLOY_ENV_FILE:-$here/.env}
readonly state_file=$here/.deploy-state
readonly health_timeout=90
readonly live_alias=api-live

if [[ ! -f $env_file ]]; then
  echo "deploy.sh: settings file not found: $env_file" >&2
  exit 1
fi

exec 9>"$here/.deploy-lock"
if ! flock -n 9; then
  echo "deploy.sh: another deploy is running" >&2
  exit 1
fi

# The shell value wins over the settings file, so every compose call uses the new tag.
export IMAGE_TAG=$tag

compose() {
  docker compose --project-directory "$here" -f "$here/compose.yaml" \
    --env-file "$env_file" "$@"
}
step() { printf '==> %s\n' "$*"; }
fail() {
  printf 'deploy.sh: %s\n' "$*" >&2
  exit 1
}
state() { sed -n "s/^$1=//p" "$state_file" 2>/dev/null || true; }

# Waits until the container's health check passes; fails early when it reports
# unhealthy or the container stops.
wait_healthy() {
  local id=$1 deadline=$((SECONDS + health_timeout)) status
  while ((SECONDS < deadline)); do
    status=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id")
    case $status in
      'running healthy') return 0 ;;
      *unhealthy | exited* | dead*) return 1 ;;
    esac
    sleep 2
  done
  return 1
}

# Checks a worker twice after its update: it must run, with no restart since it
# was created or since before the update when compose left it as it was.
worker_stays_up() {
  local worker=$1 before_id=$2 before_restarts=$3 id expected
  for wait in 5 5; do
    sleep "$wait"
    id=$(compose ps -q "$worker")
    [[ -n $id ]] || return 1
    expected=0
    [[ $id == "$before_id" ]] && expected=$before_restarts
    [[ $(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$id") == "running $expected" ]] || return 1
  done
}

previous_current=$(state current)
step "Deploying $tag (running: ${previous_current:-none})"

# A failed config read would leave the list empty, and "compose up" with no
# service names would start the whole stack.
services=$(compose config --services)
mapfile -t infra < <(grep -xE 'postgres|redis|cloudflared' <<<"$services")
if ((${#infra[@]} < 2)); then
  fail "compose config lists ${#infra[@]} of postgres, redis and cloudflared, expected at least 2; check compose.yaml and the settings file"
fi

step 'Pulling the app and migrate images'
compose pull --quiet api
compose --profile migrate pull --quiet migrate

# Starts the stack's own services on a first deploy; a no-op afterwards unless
# their config changed. The tunnel runs only when its profile is enabled.
step "Ensuring ${infra[*]} are up"
compose up -d --wait --quiet-pull "${infra[@]}"

step 'Migrating the database'
if ! compose run --rm -T migrate; then
  fail "migration failed; the running stack is unchanged"
fi

step 'Starting the new API beside the running one'
mapfile -t old_api < <(compose ps -aq api)
compose up -d --no-deps --no-recreate --scale "api=$((${#old_api[@]} + 1))" api
new_api=''
while read -r id; do
  [[ " ${old_api[*]} " == *" $id "* ]] || new_api=$id
done < <(compose ps -aq api)
[[ -n $new_api ]] || fail 'the new API container did not start'

step "Waiting up to ${health_timeout}s for the new API to turn healthy"
if ! wait_healthy "$new_api"; then
  echo '--- last log lines of the new API ---' >&2
  docker logs --tail 30 "$new_api" >&2 || true
  docker stop "$new_api" >/dev/null || true
  docker rm -f "$new_api" >/dev/null || true
  fail "the API on $tag never turned healthy; it was removed and the previous API keeps serving"
fi

# Compose would give an alias in compose.yaml to every replica, healthy or not,
# so the alias is added here. A container takes a new alias only on connect;
# the reconnect keeps the aliases compose gave it, such as the service name.
network=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$new_api")
step "Routing $live_alias to the new API"
alias_args=(--alias "$live_alias")
while read -r name; do
  if [[ -n $name ]]; then alias_args+=(--alias "$name"); fi
done < <(docker inspect -f "{{range (index .NetworkSettings.Networks \"$network\").Aliases}}{{println .}}{{end}}" "$new_api")
docker network disconnect "$network" "$new_api"
docker network connect "${alias_args[@]}" "$network" "$new_api"

# Docker keeps a stopping container in DNS until it exits, but its closed port
# refuses at once, and the tunnel then tries the next address.
if ((${#old_api[@]} > 0)); then
  step "Stopping the previous API (${#old_api[@]} container(s))"
  docker stop "${old_api[@]}" >/dev/null
  docker rm "${old_api[@]}" >/dev/null
fi
compose up -d --no-deps --no-recreate --scale api=1 api

for worker in tracker buyer; do
  step "Updating the $worker (stop, then start, when its image or config changed)"
  before_id=$(compose ps -q "$worker")
  before_restarts=0
  [[ -n $before_id ]] && before_restarts=$(docker inspect -f '{{.RestartCount}}' "$before_id")
  compose up -d --no-deps "$worker"
  if ! worker_stays_up "$worker" "$before_id" "$before_restarts"; then
    fail "the $worker on $tag is not running or restarted; the API already runs $tag, roll back with: deploy.sh ${previous_current:-<previous tag>}"
  fi
done

previous=$(state previous)
[[ -n $previous_current && $previous_current != "$tag" ]] && previous=$previous_current
step "Recording $tag (previous: ${previous:-none})"
printf 'current=%s\nprevious=%s\n' "$tag" "$previous" >"$state_file.tmp"
mv "$state_file.tmp" "$state_file"
if grep -q '^IMAGE_TAG=' "$env_file"; then
  sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$tag/" "$env_file"
else
  printf 'IMAGE_TAG=%s\n' "$tag" >>"$env_file"
fi

step 'Removing images other than the current and previous tags'
image_ref=$(docker inspect -f '{{.Config.Image}}' "$new_api")
repository=${image_ref%:*}
keep=" $tag $tag-migrate "
[[ -n $previous ]] && keep+="$previous $previous-migrate "
while read -r image_tag; do
  [[ $image_tag == '<none>' || $keep == *" $image_tag "* ]] && continue
  docker image rm "$repository:$image_tag" >/dev/null || echo "kept $image_tag: still in use"
done < <(docker image ls "$repository" --format '{{.Tag}}')
# Replaced Postgres, Redis and tunnel images become dangling, as do untagged app images.
docker image prune -f >/dev/null

step "Deployed $tag"
