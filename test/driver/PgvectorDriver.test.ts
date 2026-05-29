/* Copyright © 2024 Seneca Project Contributors, MIT License. */

import { Client } from 'pg'

import { PgvectorDriver } from '../../src/driver/PgvectorDriver'
import { pgAvailable, pgUrl, setupTable, teardown } from '../support/pgsetup'


// Driver-level integration tests: exercise the SQL / pgvector behaviour directly,
// WITHOUT Seneca in the loop. This is where "we use the driver's API correctly and
// produce the right shapes" is verified. Skips cleanly when SENECA_VECTOR_PG_URL unset.
const describePg = pgAvailable() ? describe : describe.skip


describePg('PgvectorDriver (direct, against pgvector)', () => {
  const url = pgAvailable() ? pgUrl() : ''
  const table = 'test_driver_query'
  const dim = 4

  // near cluster (a,b) + a far doc (c) so KNN ordering / filtering is observable.
  const near = [1, 0, 0, 0]
  const near2 = [0.99, 0.01, 0, 0]
  const far = [0, 1, 1, 1]

  let driver: PgvectorDriver

  beforeAll(async () => {
    await setupTable({ url, table, dim })
    driver = new PgvectorDriver({ pg: { url } })
    await driver.connect()

    await driver.upsert(table, 'a', near, { code: 'a', category: 'x' })
    await driver.upsert(table, 'b', near2, { code: 'b', category: 'x' })
    await driver.upsert(table, 'c', far, { code: 'a', category: 'y' })
  }, 30000)

  afterAll(async () => {
    if (driver) await driver.close()
    await teardown({ url, table })
  }, 30000)


  // ---- upsert / get ----

  test('upsert + get round-trips metadata (without the embedding)', async () => {
    await driver.upsert(table, 'rt', [0.5, 0.5, 0.5, 0.5], { code: 'z', n: 7 })
    const row = await driver.get(table, 'rt')
    expect(row).not.toBeNull()
    expect(row!.id).toEqual('rt')
    expect(row!.metadata.code).toEqual('z')
    expect(row!.metadata.n).toEqual(7)
    // get never selects the embedding column
    expect((row!.metadata as any).embedding).toBeUndefined()
  })


  test('upsert generates an id when none given', async () => {
    const res = await driver.upsert(table, undefined, [0.1, 0.1, 0.1, 0.1], { code: 'gen' })
    expect(typeof res.id).toBe('string')
    expect(res.id.length).toBeGreaterThan(0)
    const row = await driver.get(table, res.id)
    expect(row!.metadata.code).toEqual('gen')
  })


  test('upsert on conflict updates embedding + metadata', async () => {
    await driver.upsert(table, 'dup', [1, 0, 0, 0], { v: 1 })
    await driver.upsert(table, 'dup', [0, 1, 0, 0], { v: 2 })
    const row = await driver.get(table, 'dup')
    expect(row!.metadata.v).toEqual(2)
  })


  test('get of an unknown id returns null', async () => {
    const row = await driver.get(table, 'nope')
    expect(row).toBeNull()
  })


  test('vector is stored as a pgvector literal, not a Postgres array', async () => {
    await driver.upsert(table, 'enc', [0.11, 0.22, 0.33, 0.44], {})
    const client = new Client({ connectionString: url })
    await client.connect()
    try {
      const res = await client.query(
        `SELECT embedding::text AS emb_text FROM ${table} WHERE id = $1`,
        ['enc'],
      )
      const embText: string = res.rows[0].emb_text
      expect(embText).toMatch(/^\[/)
      expect(embText).toMatch(/\]$/)
      const parsed = JSON.parse(embText) as number[]
      expect(parsed.length).toEqual(4)
      expect(parsed[0]).toBeCloseTo(0.11, 4)
      expect(parsed[3]).toBeCloseTo(0.44, 4)
    } finally {
      await client.end()
    }
  })


  // ---- query: KNN ----

  test('KNN query orders by cosine similarity and scores in [0,1]', async () => {
    // Full scan (k large enough to include every seeded row, regardless of how many
    // other tests have inserted into the shared table).
    const rows = await driver.query(table, { vector: near, k: 100 })
    expect(rows.length).toBeGreaterThanOrEqual(3)

    rows.forEach((r) => {
      expect(typeof r.score).toBe('number')
      expect(r.score!).toBeGreaterThanOrEqual(-0.0001)
      expect(r.score!).toBeLessThanOrEqual(1.0001)
    })

    // Scores are descending (best match first). HNSW is an approximate index and
    // float rounding can reorder near-ties by a hair, so allow a small epsilon.
    const EPS = 1e-6
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].score!).toBeGreaterThanOrEqual(rows[i].score! - EPS)
    }

    // 'a' (identical to the query) and 'b' (near) rank ahead of 'c' (orthogonal).
    const pos = (id: string) => rows.findIndex((r) => r.id === id)
    expect(pos('a')).toBeGreaterThanOrEqual(0)
    expect(pos('a')).toBeLessThan(pos('c'))
    expect(pos('b')).toBeLessThan(pos('c'))
  })


  test('KNN with identical vector yields top score ~1.0', async () => {
    const rows = await driver.query(table, { vector: near, k: 1 })
    expect(rows.length).toEqual(1)
    expect(rows[0].id).toEqual('a')
    expect(rows[0].score!).toBeGreaterThan(0.99)
  })


  test('KNN respects k as the limit', async () => {
    const rows = await driver.query(table, { vector: near, k: 2 })
    expect(rows.length).toEqual(2)
  })


  test('KNN + equality filter returns only the matching subset, ordered', async () => {
    const rows = await driver.query(table, { vector: near, k: 5, filters: { category: 'x' } })
    expect(rows.length).toEqual(2)
    rows.forEach((r) => expect(['a', 'b']).toContain(r.id))
    expect(rows[0].score!).toBeGreaterThanOrEqual(rows[1].score!)
  })


  // ---- query: filter-only ----

  test('filter-only query returns matches without a score', async () => {
    const rows = await driver.query(table, { filters: { category: 'y' } })
    expect(rows.length).toEqual(1)
    expect(rows[0].id).toEqual('c')
    expect(rows[0].score).toBeUndefined()
  })


  test('filter-only query honours the limit', async () => {
    const rows = await driver.query(table, { filters: { category: 'x' }, limit: 1 })
    expect(rows.length).toEqual(1)
  })


  test('query with neither vector nor filters returns []', async () => {
    const rows = await driver.query(table, {})
    expect(rows).toEqual([])
  })


  // ---- remove / removeQuery ----

  test('remove deletes a row by id', async () => {
    await driver.upsert(table, 'del-me', [0.2, 0.2, 0.2, 0.2], { code: 'del' })
    expect(await driver.get(table, 'del-me')).not.toBeNull()

    await driver.remove(table, 'del-me')
    expect(await driver.get(table, 'del-me')).toBeNull()
  })


  test('remove of an unknown id is a no-op (no throw)', async () => {
    await expect(driver.remove(table, 'never-existed')).resolves.toBeUndefined()
  })


  test('removeQuery deletes the matching subset by filter', async () => {
    await driver.upsert(table, 'z1', [0.3, 0.3, 0.3, 0.3], { category: 'zdel' })
    await driver.upsert(table, 'z2', [0.4, 0.4, 0.4, 0.4], { category: 'zdel' })
    expect((await driver.query(table, { filters: { category: 'zdel' } })).length).toEqual(2)

    await driver.removeQuery(table, { filters: { category: 'zdel' } })

    expect((await driver.query(table, { filters: { category: 'zdel' } })).length).toEqual(0)
    // unrelated rows survive
    expect(await driver.get(table, 'a')).not.toBeNull()
  })


  // ---- guards / validation ----

  test('upsert rejects a missing vector', async () => {
    await expect(
      driver.upsert(table, 'x', undefined as any, {}),
    ).rejects.toThrow(/vector is required/)
  })


  test('upsert rejects a non-finite vector', async () => {
    await expect(
      driver.upsert(table, 'x', [1, 2, NaN, 4], {}),
    ).rejects.toThrow(/finite number/)
  })


  test('query rejects an oversized k', async () => {
    await expect(
      driver.query(table, { vector: near, k: 5000 }),
    ).rejects.toThrow(/exceeds max/)
  })


  test('a malicious table name is rejected (identifier guard)', async () => {
    await expect(
      driver.get('test; DROP TABLE users; --', 'id'),
    ).rejects.toThrow(/invalid table/)
  })


  test('a malicious filter key is rejected (identifier guard)', async () => {
    await expect(
      driver.query(table, { filters: { "x'; DROP TABLE y; --": 'v' } }),
    ).rejects.toThrow(/invalid filter key/)
  })
})
