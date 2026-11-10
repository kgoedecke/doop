import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from './harness.ts'
import { startPrivateServer } from './privateServer.ts'

let fixture: Awaited<ReturnType<typeof startPrivateServer>>
let owner: Client
let mcp: McpClient
const LOCK = 735191
const SENTINEL = 'private SQL detail must never reach a caller'

beforeAll(async () => {
  fixture = await startPrivateServer()
  owner = await new Client(fixture.server).signUp('creation-owner@test.dev', 'Owner')
  const response = await owner.post('/api/agent-keys', { name: 'Creation barrier' })
  expect(response.status).toBe(200)
  const { secret } = await response.json()
  mcp = new McpClient({ name: 'creation-barrier', version: '1' })
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${fixture.server.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  )
  await fixture.db.query(`
    CREATE SEQUENCE creation_attempts;
    CREATE FUNCTION test_creation_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.name LIKE 'Barrier %' OR NEW.name LIKE 'BarrierSignup%' THEN
        PERFORM pg_advisory_xact_lock(${LOCK});
      ELSIF NEW.name LIKE 'Rejected %' OR NEW.name LIKE 'BootstrapFailure%' THEN
        PERFORM nextval('creation_attempts');
        RAISE EXCEPTION '${SENTINEL}';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_creation_barrier BEFORE INSERT ON canvases
      FOR EACH ROW EXECUTE FUNCTION test_creation_barrier();
  `)
}, 60_000)

afterAll(async () => {
  try {
    await mcp?.close()
  } finally {
    await fixture?.close()
  }
})

async function blocked() {
  await expect
    .poll(
      async () =>
        Number(
          (
            await fixture.db.query(`
    SELECT count(*) FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event = 'advisory'
  `)
          ).rows[0].count,
        ),
      { timeout: 8_000 },
    )
    .toBe(1)
}

it.each(['HTTP', 'MCP'] as const)('%s exposes no parent or response until its real INSERT commits', async (surface) => {
  const before = await (await owner.get('/api/canvases')).json()
  await fixture.db.query('SELECT pg_advisory_lock($1)', [LOCK])
  let completed = false
  const pending = (
    surface === 'HTTP'
      ? owner.post('/api/canvases', { name: `Barrier ${surface}` }).then(async (r) => {
          expect(r.status).toBe(200)
          return r.json()
        })
      : mcp.callTool({ name: 'create_canvas', arguments: { name: `Barrier ${surface}` } }).then((r) => {
          expect(r.isError).not.toBe(true)
          return r.structuredContent as { id: string }
        })
  ).finally(() => {
    completed = true
  })
  try {
    await blocked()
    expect(completed).toBe(false)
    expect(await (await owner.get('/api/canvases')).json()).toEqual(before)
    expect((await fixture.db.query('SELECT id FROM canvases WHERE name = $1', [`Barrier ${surface}`])).rows).toEqual([])
  } finally {
    await fixture.db.query('SELECT pg_advisory_unlock($1)', [LOCK])
  }
  const canvas = await pending
  expect((await fixture.db.query('SELECT id FROM canvases WHERE id = $1', [canvas.id])).rows).toHaveLength(1)
  const frame = await owner.post(`/api/canvases/${canvas.id}/frames`, {
    name: 'Committed child',
    html: '<p>durable parent</p>',
  })
  expect(frame.status).toBe(200)
  expect((await owner.get(`/api/canvases/${canvas.id}`)).status).toBe(200)
})

it('HTTP reports uncertainty without SQL details, phantom children, or resurrection after restart', async () => {
  const before = await (await owner.get('/api/canvases')).json()
  const response = await owner.post('/api/canvases', { name: 'Rejected HTTP' })
  expect(response.status).toBe(503)
  const body = await response.json()
  expect(body.outcome).toBe('unknown')
  expect(body.candidateId).toBeTruthy()
  expect(JSON.stringify(body)).not.toContain(SENTINEL)
  expect(JSON.stringify(body)).not.toContain('Rejected HTTP')
  expect(await (await owner.get('/api/canvases')).json()).toEqual(before)
  expect((await owner.get(`/api/canvases/${body.candidateId}`)).status).toBe(404)
  expect(
    (await owner.post(`/api/canvases/${body.candidateId}/frames`, { name: 'No phantom', html: '<p>x</p>' })).status,
  ).toBe(404)
  expect((await fixture.db.query('SELECT id FROM canvases WHERE id = $1', [body.candidateId])).rows).toEqual([])
  await fixture.restart()
  expect((await owner.get(`/api/canvases/${body.candidateId}`)).status).toBe(404)
  expect((await fixture.db.query('SELECT id FROM frames WHERE canvas_id = $1', [body.candidateId])).rows).toEqual([])
})

it('MCP preserves post-entry uncertainty as HTTP failure and attempts the create only once', async () => {
  const before = (await fixture.db.query('SELECT last_value FROM creation_attempts')).rows[0].last_value
  const listed = await (await owner.get('/api/canvases')).json()
  await expect(mcp.callTool({ name: 'create_canvas', arguments: { name: 'Rejected MCP' } })).rejects.toMatchObject({
    code: 503,
  })
  expect(BigInt((await fixture.db.query('SELECT last_value FROM creation_attempts')).rows[0].last_value)).toBe(
    BigInt(before) + 1n,
  )
  expect(await (await owner.get('/api/canvases')).json()).toEqual(listed)
  expect((await fixture.db.query("SELECT id FROM canvases WHERE name = 'Rejected MCP'")).rows).toEqual([])
})

it('failed optional welcome creation retains the account without a phantom document or demo', async () => {
  const account = await new Client(fixture.server).signUp('bootstrap-failure@test.dev', 'BootstrapFailure')
  expect((await account.get('/api/auth/get-session')).status).toBe(200)
  const session = await (await account.get('/api/auth/get-session')).json()
  expect(session.user.email).toBe('bootstrap-failure@test.dev')
  expect(await (await account.get('/api/canvases')).json()).toEqual([])
  expect((await fixture.db.query('SELECT id FROM canvases WHERE owner_id = $1', [session.user.id])).rows).toEqual([])
  await fixture.restart()
  expect(await (await account.get('/api/canvases')).json()).toEqual([])
})

it('signup waits for the welcome parent commit before completing its bootstrap', async () => {
  const account = new Client(fixture.server)
  await fixture.db.query('SELECT pg_advisory_lock($1)', [LOCK])
  let completed = false
  const signup = account.signUp('bootstrap-barrier@test.dev', 'BarrierSignup').finally(() => {
    completed = true
  })
  try {
    await blocked()
    expect(completed).toBe(false)
    expect((await fixture.db.query("SELECT id FROM canvases WHERE name LIKE 'BarrierSignup%'")).rows).toEqual([])
  } finally {
    await fixture.db.query('SELECT pg_advisory_unlock($1)', [LOCK])
  }
  await signup
  const canvases = await (await account.get('/api/canvases')).json()
  expect(canvases).toHaveLength(1)
  expect((await fixture.db.query('SELECT id FROM canvases WHERE id = $1', [canvases[0].id])).rows).toHaveLength(1)
})

it('startup binds no listener while seed is pending or failed, then seeds only committed children', async () => {
  fixture.server.stop({ keepData: true })
  await fixture.server.stopped
  const oldData = path.join(fixture.server.dataDir, 'data')
  await mkdir(oldData, { recursive: true })
  await writeFile(
    path.join(oldData, 'store.json'),
    JSON.stringify([
      { id: 'legacy-should-not-publish', name: 'Old unowned JSON', frames: [], createdAt: 1, updatedAt: 1 },
    ]),
  )
  await fixture.db.query(`
    TRUNCATE frames, canvases CASCADE;
    CREATE FUNCTION test_seed_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.name = 'Welcome Canvas' THEN
        PERFORM pg_advisory_xact_lock(${LOCK});
        RAISE EXCEPTION 'owned seed rejection';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_seed_barrier BEFORE INSERT ON canvases
      FOR EACH ROW EXECUTE FUNCTION test_seed_barrier();
  `)
  await fixture.db.query('SELECT pg_advisory_lock($1)', [LOCK])
  const failing = expect(fixture.restart()).rejects.toThrow('did not bind port')
  try {
    await blocked()
    await expect(fetch(`${fixture.server.base}/healthz`)).rejects.toThrow()
    expect((await fixture.db.query('SELECT id FROM frames')).rows).toEqual([])
  } finally {
    await fixture.db.query('SELECT pg_advisory_unlock($1)', [LOCK])
  }
  await failing
  expect((await fixture.db.query('SELECT id FROM canvases')).rows).toEqual([])
  expect((await fixture.db.query('SELECT id FROM frames')).rows).toEqual([])
  await fixture.db.query(`
    CREATE OR REPLACE FUNCTION test_seed_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.name = 'Welcome Canvas' THEN PERFORM pg_advisory_xact_lock(${LOCK}); END IF;
      RETURN NEW;
    END $$;
  `)
  await fixture.db.query('SELECT pg_advisory_lock($1)', [LOCK])
  const succeeding = fixture.restart()
  try {
    await blocked()
    await expect(fetch(`${fixture.server.base}/healthz`)).rejects.toThrow()
    expect((await fixture.db.query('SELECT id FROM frames')).rows).toEqual([])
  } finally {
    await fixture.db.query('SELECT pg_advisory_unlock($1)', [LOCK])
  }
  await succeeding
  expect((await fixture.db.query("SELECT id FROM canvases WHERE id='legacy-should-not-publish'")).rows).toEqual([])
  expect((await fetch(`${fixture.server.base}/healthz`)).status).toBe(200)
  await expect
    .poll(
      async () =>
        (
          await fixture.db.query(`
    SELECT f.id FROM frames f JOIN canvases c ON c.id = f.canvas_id WHERE c.name = 'Welcome Canvas'
  `)
        ).rowCount,
    )
    .toBe(2)
}, 25_000)
