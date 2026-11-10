"""Failure injection against the actual CLI owner; Docker/network are controlled leaves."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

SOURCE = Path(__file__).resolve().parents[2] / 'scripts' / 'private-storage-fixture.py'


class FixtureLifecycle(unittest.TestCase):
    def scenario(self, failure=None):
        module = {'__name__': 'fixture_under_test', '__file__': str(SOURCE)}
        exec(compile(SOURCE.read_text(), str(SOURCE), 'exec'), module)
        daemon = {'calls': [], 'containers': {'foreign': {'name': 'unrelated', 'owner': 'somebody-else'}}, 'stopped': []}
        original_save = module['save_state']
        state_failed = False

        def save(runtime, state):
            nonlocal state_failed
            if failure == 'first-state-write' and not state_failed:
                state_failed = True
                raise OSError('controlled first ownership publication failure')
            if failure == 'created-state-write' and state['phase'] == 'created' and not state_failed:
                state_failed = True
                raise OSError('controlled post-create publication failure')
            return original_save(runtime, state)

        def docker(*args, **kwargs):
            daemon['calls'].append(args[0])
            if args[0] in ['image', 'pull']:
                return 'pinned-image'
            if args[0] == 'run':
                name = args[args.index('--name') + 1]
                owner = args[args.index('--label') + 1].split('=', 1)[1]
                self.assertEqual(json.loads((runtime / 'state.json').read_text())['phase'], 'pending')
                daemon['containers']['same-label-other-name'] = {'name': 'another-fixture', 'owner': owner}
                if failure == 'uncertain-not-visible':
                    raise subprocess.TimeoutExpired(['docker', 'run'], 10)
                daemon['containers']['owned'] = {'name': name, 'owner': owner}
                if failure in ['lost-run-result', 'cleanup-fails']:
                    raise subprocess.TimeoutExpired(['docker', 'run'], 10)
                if failure == 'failed-run-result':
                    raise subprocess.CalledProcessError(125, ['docker', 'run'])
                return 'owned'
            if args[0] == 'ps':
                filters = [args[i + 1] for i, value in enumerate(args) if value == '--filter']
                owner = next(v.split('=', 2)[2] for v in filters if v.startswith('label='))
                pattern = next(v.split('=', 1)[1] for v in filters if v.startswith('name='))
                return '\n'.join(cid for cid, row in daemon['containers'].items()
                                 if row['owner'] == owner and pattern == '^/' + row['name'] + '$')
            if args[0] == 'inspect':
                if 'NetworkSettings' in args[2]:
                    if failure == 'readiness-inspect':
                        raise RuntimeError('controlled readiness failure')
                    return json.dumps([{'HostIp': '127.0.0.1', 'HostPort': '12345'}])
                row = daemon['containers'][args[-1]]
                return '/' + row['name'] if args[2] == '{{.Name}}' else row['owner']
            if args[0] == 'stop':
                if failure == 'cleanup-fails':
                    raise OSError('controlled Docker cleanup failure')
                daemon['stopped'].append(args[-1])
                return args[-1]
            if args[0] == 'rm':
                del daemon['containers'][args[-1]]
                return args[-1]
            raise AssertionError(args)

        module.update(docker=docker, save_state=save)
        with tempfile.TemporaryDirectory(prefix='doop-fixture-model-') as parent:
            runtime = Path(parent) / 'runtime'
            error = None
            with patch('urllib.request.urlopen', side_effect=urllib.error.HTTPError('http://fixture.invalid', 403, 'Forbidden', None, None)), contextlib.redirect_stdout(io.StringIO()):
                try:
                    module['start'](runtime)
                except (OSError, RuntimeError, subprocess.SubprocessError) as caught:
                    error = caught
                if failure is None:
                    self.assertIsNone(error)
                    self.assertIn('owned', daemon['containers'])
                    module['stop'](runtime)
                    module['stop'](runtime)  # Confirmed cleanup is repeatable.
            state_path = runtime / 'state.json'
            if failure == 'first-state-write':
                self.assertIsInstance(error, OSError)
                self.assertEqual(daemon['calls'], [])
                self.assertNotIn('owned', daemon['containers'])
            elif failure in ['cleanup-fails', 'uncertain-not-visible']:
                self.assertIsNotNone(error)
                self.assertTrue(state_path.exists())
                self.assertEqual(state_path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(json.loads(state_path.read_text())['phase'], 'pending')
                if failure == 'cleanup-fails':
                    self.assertIn('owned', daemon['containers'])
            else:
                self.assertNotIn('owned', daemon['containers'])
                self.assertEqual(json.loads(state_path.read_text())['phase'], 'removed')
                self.assertEqual(daemon['stopped'], ['owned'])
            self.assertIn('foreign', daemon['containers'])
            if 'run' in daemon['calls']:
                self.assertIn('same-label-other-name', daemon['containers'])

    def test_lost_run_result_after_container_creation(self): self.scenario('lost-run-result')
    def test_failed_run_result_after_container_creation(self): self.scenario('failed-run-result')
    def test_first_ownership_publication_failure_prevents_all_external_work(self): self.scenario('first-state-write')
    def test_post_create_state_write_failure_reconciles_from_prior_intent(self): self.scenario('created-state-write')
    def test_readiness_failure_cleanup_control(self): self.scenario('readiness-inspect')
    def test_cleanup_failure_preserves_protected_recovery_intent(self): self.scenario('cleanup-fails')
    def test_unknown_inflight_creation_is_not_declared_absent(self): self.scenario('uncertain-not-visible')
    def test_success_and_repeated_stop_preserve_unrelated_containers(self): self.scenario()


if __name__ == '__main__':
    unittest.main(verbosity=2)
