import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('owns fixture acquisition before Docker and preserves unrelated resources and uncertain recovery state', async () => {
  const result = await promisify(execFile)('python3', ['tests/fixtures/private_storage_lifecycle.py'], {
    timeout: 20_000,
  })
  expect(result.stderr).toContain('Ran 8 tests')
  expect(result.stderr).toContain('OK')
})
