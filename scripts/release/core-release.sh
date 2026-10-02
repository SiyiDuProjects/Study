#!/bin/sh
# Run on the configured VPS after review; credentials stay in its existing .env.
set -eu
umask 077
action=${1:?prepare|activate|rollback|inspect}
id=${2:?prepared release ID}
case "$id" in ''|*[!A-Za-z0-9_-]*) echo 'Invalid release ID' >&2; exit 2;; esac
test "${#id}" -le 100
root=/home/ubuntu/siyi/canvas
b=/home/ubuntu/siyi/backups/study-$id
archive=/tmp/study-core-$id.tar.gz
container=canvas-mcp-canvas-1
test -d "$root" && test ! -L "$root"
current_image() { docker inspect "$container" --format '{{.Image}}'; }
ready() {
  attempt=0
  while test "$attempt" -lt 30; do
    if curl -fsS http://127.0.0.1:8794/readyz >/dev/null; then return 0; fi
    attempt=$((attempt + 1)); sleep 1
  done
  return 1
}
replace_sources() {
  source_dir=$1
  label=$2
  for tree in src scripts; do
    stage="$b/staged-$label-$tree-$$"
    cp -a "$source_dir/$tree" "$stage" || return 1
    if test -d "$root/$tree"; then mv "$root/$tree" "$b/$label-$tree-$$" || return 1; fi
    mv "$stage" "$root/$tree" || return 1
  done
  for name in package.json package-lock.json tsconfig.json Dockerfile; do cp "$source_dir/$name" "$root/$name" || return 1; done
}
rollback() {
  test -f "$b/prepared"
  mkdir -p "$b/previous-source"
  tar -xzf "$b/source.tar.gz" -C "$b/previous-source"
  replace_sources "$b/previous-source" rollback
  docker tag "$(cat "$b/previous-image")" canvas-mcp-service:local
  (cd "$root" && sudo docker compose -f docker-compose.example.yml up -d --no-build canvas)
  ready
  echo 'Core previous image restored; current database preserved. Coordinate Record rollback separately.'
}
case "$action" in
inspect)
  printf 'image=%s\n' "$(current_image)"
  curl -fsS http://127.0.0.1:8794/readyz
  ;;
prepare)
  expected=${3:?expected live image}
  digest=${4:?archive SHA256}
  test "$(current_image)" = "$expected"
  test ! -e "$b"
  printf '%s  %s\n' "$digest" "$archive" | sha256sum -c - >/dev/null
  # Candidate tar must be rooted in the reviewed Core source, with no links/secrets.
  python3 - "$archive" <<'PY'
import pathlib, sys, tarfile
allowed={'src','scripts','test','package.json','package-lock.json','tsconfig.json','Dockerfile','.dockerignore'}
with tarfile.open(sys.argv[1]) as archive:
    for member in archive.getmembers():
        path=pathlib.PurePosixPath(member.name)
        assert not path.is_absolute() and '..' not in path.parts
        assert not member.issym() and not member.islnk()
        if path.parts: assert path.parts[0] in allowed
        assert not any(p.startswith('.env') for p in path.parts)
PY
  mkdir -p "$b/candidate"
  sudo cp "$root/.env" "$b/core.env"
  sudo chown "$(id -u):$(id -g)" "$b/core.env"
  chmod 600 "$b/core.env"
  cp "$root/docker-compose.example.yml" "$b/compose.yml"
  tar -czf "$b/source.tar.gz" -C "$root" src scripts package.json package-lock.json tsconfig.json Dockerfile
  docker tag "$expected" "canvas-mcp-service:before-$id"
  docker exec "$container" node -e 'const D=require("better-sqlite3");const d=new D(process.env.DATABASE_PATH,{readonly:true});if(d.pragma("integrity_check",{simple:true})!=="ok")throw Error("Source integrity failed");d.backup("/tmp/study-full-release.sqlite").then(()=>{d.close();const b=new D("/tmp/study-full-release.sqlite",{readonly:true});if(b.pragma("integrity_check",{simple:true})!=="ok")throw Error("Backup integrity failed");console.log(JSON.stringify({integrity:"ok",schema:b.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version}));b.close()})'
  docker exec "$container" cat /tmp/study-full-release.sqlite > "$b/core.sqlite"
  tar -xzf "$archive" -C "$b/candidate"
  cp "$archive" "$b/core-source.tar.gz"
  docker build -t "canvas-mcp-service:$id" "$b/candidate"
  # Candidate starts on a copy. Previous image then reads candidate-updated data.
  for variant in candidate previous; do
    mkdir "$b/test-$variant"
    if test "$variant" = candidate; then cp "$b/core.sqlite" "$b/test-$variant/canvas.sqlite";
    else sudo cp "$b/test-candidate/rollback.sqlite" "$b/test-$variant/canvas.sqlite"; fi
    sudo chown -R 1000:1000 "$b/test-$variant"
    image="canvas-mcp-service:$id"
    if test "$variant" = previous; then image="canvas-mcp-service:before-$id"; fi
    name="study-check-$id-$variant"
    sudo docker run -d --name "$name" --env-file "$b/core.env" -e STUDY_BACKGROUND_JOBS=off -e DATABASE_PATH=/data/canvas.sqlite -e PORT=8794 -v "$b/test-$variant:/data" --read-only --tmpfs /tmp "$image" >/dev/null
    good=false
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if docker exec "$name" node -e 'fetch("http://127.0.0.1:8794/readyz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then good=true; break; fi
      sleep 1
    done
    if test "$variant" = candidate && test "$good" = true; then
      docker exec "$name" node -e 'const D=require("better-sqlite3");const d=new D(process.env.DATABASE_PATH,{readonly:true});d.backup("/data/rollback.sqlite").then(()=>d.close())'
    fi
    docker stop "$name" >/dev/null
    docker rm "$name" >/dev/null
    test "$good" = true
    printf '%s image boots on copied SQLite\n' "$variant"
  done
  # Default remains unchanged. The opt-in permits only the inspected additive v8
  # ownership change; the previous image has already booted against the new DB.
  schema_policy=${5:-unchanged}
  # SQLite WAL readers need writable space for temporary sidecars; DB mounts stay read-only.
  docker run --rm --network none --read-only --user 1000:1000 --cap-drop ALL --tmpfs /checks:mode=1777 \
    -v "$b/core.sqlite:/checks/before.sqlite:ro" -v "$b/test-candidate/rollback.sqlite:/checks/after.sqlite:ro" \
    --entrypoint node "canvas-mcp-service:$id" scripts/verify-schema-compat.mjs /checks/before.sqlite /checks/after.sqlite "$schema_policy"
  printf '%s\n' "$schema_policy" > "$b/schema-policy"
  printf '%s\n' "$expected" > "$b/previous-image"
  docker image inspect "canvas-mcp-service:$id" --format '{{.Id}}' > "$b/candidate-image"
  cp "$0" "$b/core-release.sh"
  touch "$b/prepared"
  printf 'Prepared %s; production unchanged\n' "$b"
  ;;
activate)
  test -f "$b/prepared"
  test "$(current_image)" = "$(cat "$b/previous-image")"
  activate_core() {
    replace_sources "$b/candidate" activation || return 1
    docker tag "$(cat "$b/candidate-image")" canvas-mcp-service:local || return 1
    (cd "$root" && sudo docker compose -f docker-compose.example.yml up -d --no-build canvas) || return 1
    ready || return 1
    curl -fsS https://study.siyidu.com/readyz >/dev/null || return 1
    test "$(current_image)" = "$(cat "$b/candidate-image")" || return 1
  }
  if ! activate_core; then rollback; exit 1; fi
  touch "$b/activated"
  printf 'Core activated image=%s\n' "$(current_image)"
  ;;
rollback) rollback ;;
*) echo 'Use prepare, activate, rollback or inspect' >&2; exit 2 ;;
esac
