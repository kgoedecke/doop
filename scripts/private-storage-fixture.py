#!/usr/bin/env python3
"""Owned, non-root, pinned private S3 fixture. Prints no credentials."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

IMAGE = 'dxflrs/garage:v2.5.0@sha256:677e5b758e4425a325b811c425c026bf35a4bf42f7ddbaa773de3f4fd779a5a5'
LABEL = 'io.openbot.private-storage-fixture'


def docker(*args, timeout=10):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.PIPE, timeout=timeout).strip()


def private_file(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())


def save_state(runtime, state):
    """Publish protected ownership before an external creation can start."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=runtime, prefix='.ownership-', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(json.dumps(state))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, runtime / 'state.json')
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def stop(runtime):
    state = json.loads((runtime / 'state.json').read_text())
    name, owner = state['name'], state['owner']
    phase = state['phase']
    if phase not in ['not_started', 'pending', 'created', 'removed']:
        raise RuntimeError('unknown fixture ownership state')
    if phase not in ['not_started', 'removed']:
        ids = docker('ps', '--all', '--quiet', '--no-trunc',
                     '--filter', 'label=' + LABEL + '=' + owner,
                     '--filter', 'name=^/' + name + '$').splitlines()
        if not ids and phase == 'pending':
            # A timed-out create can still be in flight at the daemon. Never
            # erase its intent merely because the candidate is not visible yet.
            raise RuntimeError('fixture creation outcome unconfirmed; recovery state retained')
        for container in ids:
            actual_owner = docker('inspect', '--format', '{{index .Config.Labels "' + LABEL + '"}}', container)
            actual_name = docker('inspect', '--format', '{{.Name}}', container).removeprefix('/')
            if actual_owner != owner or actual_name != name:
                raise RuntimeError('fixture ownership mismatch; recovery state retained')
            docker('stop', '--time', '5', container)
            docker('rm', container)
        # This is the cleanup acknowledgment. A failed query or publication
        # retains the original protected intent for a later owned reconciliation.
        remaining = docker('ps', '--all', '--quiet', '--no-trunc',
                           '--filter', 'label=' + LABEL + '=' + owner,
                           '--filter', 'name=^/' + name + '$').splitlines()
        if remaining:
            raise RuntimeError('fixture cleanup unconfirmed; recovery state retained')
    save_state(runtime, {**state, 'phase': 'removed'})
    print(json.dumps({'stopped': True, 'runtime': str(runtime)}))


def start(runtime):
    runtime = runtime.resolve()
    runtime.mkdir(mode=0o700)  # Never adopt, overwrite or remove an existing directory.
    owner = secrets.token_hex(12)
    state = {'name': 'doop-private-s3-' + owner, 'owner': owner, 'image': IMAGE, 'phase': 'not_started'}
    # No Docker operation, even inspection/pull, precedes this durable intent.
    save_state(runtime, state)
    try:
        key, secret, rpc = 'GK' + secrets.token_hex(16), secrets.token_hex(32), secrets.token_hex(32)
        bucket = 'doop-test-' + owner
        uid = os.getuid() or 65532
        gid = os.getgid() if os.getuid() else 65532
        config = runtime / 'garage.toml'
        private_file(config, 'metadata_dir="/data/meta"\ndata_dir="/data/blobs"\ndb_engine="sqlite"\nreplication_factor=1\nrpc_bind_addr="127.0.0.1:3901"\nrpc_public_addr="127.0.0.1:3901"\nrpc_secret="' + rpc + '"\n[s3_api]\ns3_region="garage"\napi_bind_addr="0.0.0.0:3900"\n')
        if not os.getuid():
            os.chown(config, uid, gid)
        settings = runtime / 'garage.env'
        private_file(settings, 'GARAGE_DEFAULT_ACCESS_KEY=' + key + '\nGARAGE_DEFAULT_SECRET_KEY=' + secret + '\nGARAGE_DEFAULT_BUCKET=' + bucket + '\n')
        try:
            docker('image', 'inspect', '--format', '{{.Id}}', IMAGE)
        except subprocess.CalledProcessError:
            docker('pull', IMAGE, timeout=45)
        state = {**state, 'phase': 'pending'}
        save_state(runtime, state)
        container = docker('run', '--detach', '--init', '--name', state['name'],
                           '--label', LABEL + '=' + owner, '--user', str(uid) + ':' + str(gid),
                           '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                           '--pids-limit=128', '--memory=384m', '--cpus=1',
                           '--tmpfs', '/data:rw,nosuid,noexec,size=256m,uid=' + str(uid) + ',gid=' + str(gid) + ',mode=0700',
                           '--tmpfs', '/tmp:rw,nosuid,noexec,size=32m',
                           '--mount', 'type=bind,src=' + str(config) + ',dst=/etc/garage.toml,readonly',
                           '--env-file', str(settings), '--publish', '127.0.0.1::3900',
                           '--entrypoint', '/garage', IMAGE, 'server', '--single-node', '--default-bucket')
        state = {**state, 'phase': 'created'}
        save_state(runtime, state)
        ports = json.loads(docker('inspect', '--format', '{{json (index .NetworkSettings.Ports "3900/tcp")}}', container))
        if len(ports) != 1 or ports[0]['HostIp'] != '127.0.0.1':
            raise RuntimeError('fixture must bind only loopback')
        endpoint = 'http://127.0.0.1:' + ports[0]['HostPort']
        deadline = time.monotonic() + 30
        while True:
            try:
                urllib.request.urlopen(endpoint + '/' + bucket + '/missing', timeout=1)
                raise RuntimeError('anonymous fixture request unexpectedly succeeded')
            except urllib.error.HTTPError as error:
                if error.code == 403:
                    break
            except (urllib.error.URLError, OSError):
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError('private fixture failed readiness')
            time.sleep(0.05)
        private_file(runtime / 'sdk.json', json.dumps({'endpoint': endpoint, 'bucket': bucket, 'key': key, 'secret': secret}))
        print(json.dumps({'ready': True, 'endpoint': endpoint, 'runtime': str(runtime), 'image': IMAGE, 'user': str(uid) + ':' + str(gid)}))
    except BaseException:
        stop(runtime)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'stop'])
    parser.add_argument('--runtime-dir', required=True, type=Path)
    args = parser.parse_args()
    runtime = args.runtime_dir.absolute()
    if runtime.is_symlink():
        raise RuntimeError('fixture path must not be a symlink')
    (start if args.action == 'start' else stop)(runtime)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Docker/service failures can contain config/credentials; report only a safe operation.
        print('private storage fixture failed; Docker and its owned runtime directory are required; unconfirmed recovery state is retained', file=sys.stderr)
        sys.exit(1)
