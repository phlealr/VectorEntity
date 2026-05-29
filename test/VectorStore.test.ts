/* Copyright © 2024 Seneca Project Contributors, MIT License. */

import { Client } from 'pg'
import Seneca from 'seneca'

import VectorStore, { DriverName } from '../src/VectorStore'
import VectorStoreDoc from '../src/VectorStoreDoc'
import { pgAvailable, pgUrl, setupTable, teardown } from './support/pgsetup'


function makeSeneca() {
  // system.exit override defends against seneca's death watchdog (which calls
  // process.exit after death_delay on fatal plugin errors).
  const seneca: any = Seneca({ legacy: false })
  seneca.options({ system: { exit: () => { /* swallowed */ } } })
  return seneca.test().use('promisify').use('entity')
}


describe('VectorStore plugin surface', () => {

  test('plugin + doc exports defined', () => {
    expect(VectorStore).toBeDefined()
    expect(VectorStoreDoc).toBeDefined()
  })


  test('driver registry contains opensearch', () => {
    const utils = (VectorStore as any)['utils']
    expect(utils.drivers).toBeDefined()
    expect(Object.keys(utils.drivers)).toContain('opensearch')
  })


  test('DriverName enum exposes opensearch', () => {
    expect(DriverName.Opensearch).toEqual('opensearch')
    // Whatever the enum advertises, the registry must register.
    const utils = (VectorStore as any)['utils']
    Object.values(DriverName).forEach((name) => {
      expect(Object.keys(utils.drivers)).toContain(name)
    })
  })


  test('checkDriverChoice rejects missing driver', () => {
    const utils = (VectorStore as any)['utils']
    expect(() => utils.checkDriverChoice('')).toThrow(/options\.driver is required/)
    expect(() => utils.checkDriverChoice(undefined)).toThrow(/options\.driver is required/)
  })


  test('checkDriverChoice rejects unknown driver', () => {
    const utils = (VectorStore as any)['utils']
    expect(() => utils.checkDriverChoice('qdrant')).toThrow(/unknown driver 'qdrant'/)
    expect(() => utils.checkDriverChoice('qdrant')).toThrow(/Available: opensearch/)
  })


  test('checkDriverChoice accepts opensearch', () => {
    const utils = (VectorStore as any)['utils']
    expect(() => utils.checkDriverChoice('opensearch')).not.toThrow()
  })


  test('load-plugin (opensearch via DriverName enum)', async () => {
    const seneca = makeSeneca()
      .use(VectorStore, {
        driver: DriverName.Opensearch,
        opensearch: { node: 'http://localhost:9200' },
        aws: { region: 'us-east-1' },
      })
    await seneca.ready()
    expect(seneca.export('VectorStore/native')).toBeDefined()
    await seneca.close()
  }, 22222)


  test('load-plugin (opensearch via string literal)', async () => {
    const seneca = makeSeneca()
      .use(VectorStore, {
        driver: 'opensearch',
        opensearch: { node: 'http://localhost:9200' },
        aws: { region: 'us-east-1' },
      })
    await seneca.ready()
    expect(seneca.export('VectorStore/native')).toBeDefined()
    await seneca.close()
  }, 22222)


  const describePg = pgAvailable() ? describe : describe.skip


  describePg('pgvector driver — save/load', () => {
    const url = pgAvailable() ? pgUrl() : ''
    const table = 'test_doc_chunk'
    const dim = 8
    const canon = 'foo/chunk'

    let seneca: any

    beforeAll(async () => {
      await setupTable({ url, table, dim })
      seneca = Seneca({ legacy: false })
        .test()
        .use('promisify')
        .use('entity')
        .use(VectorStore, {
          driver: DriverName.Pgvector,
          pg: { url },
          canon: { [canon]: { vector: { dim } } },
          table: { map: { [`-/${canon}`]: table } },
        })
      await seneca.ready()
    }, 30000)

    afterAll(async () => {
      if (seneca) await seneca.close()
      await teardown({ url, table })
    }, 30000)


    test('(a) save assigns id when none provided', async () => {
      const ent = await seneca.entity(canon).make$().data$({
        text: 'auto-id',
        kind: 'a',
        vector: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      }).save$()
      expect(ent.id).toBeDefined()
      expect(typeof ent.id).toBe('string')
      expect(ent.id.length).toBeGreaterThan(0)
    })


    test('(b) save respects provided id', async () => {
      const customId = 'my-custom-id-' + Date.now()
      const ent = await seneca.entity(canon).make$().data$({
        id: customId,
        text: 'custom-id',
        kind: 'b',
        vector: [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2],
      }).save$()
      expect(ent.id).toEqual(customId)
    })


    test('(c) save with dim mismatch rejects', async () => {
      await expect(
        seneca.entity(canon).make$().data$({
          text: 'wrong-dim',
          vector: [0.1, 0.2, 0.3],  // dim 3, not 8
        }).save$()
      ).rejects.toThrow(/dim mismatch/)
    })


    test('(d) save without vector rejects (driver-level)', async () => {
      await expect(
        seneca.entity(canon).make$().data$({
          text: 'no-vector',
        }).save$()
      ).rejects.toThrow(/vector is required/)
    })


    test('(e) save then load round-trip preserves scalar fields', async () => {
      const ent = await seneca.entity(canon).make$().data$({
        text: 'roundtrip',
        kind: 'e',
        count: 42,
        nested: { a: 1, b: 'two' },
        vector: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
      }).save$()

      const loaded = await seneca.entity(canon).load$(ent.id)
      expect(loaded).not.toBeNull()
      expect(loaded.text).toEqual('roundtrip')
      expect(loaded.kind).toEqual('e')
      expect(loaded.count).toEqual(42)
      expect(loaded.nested).toEqual({ a: 1, b: 'two' })
    })


    test('(f) load of unknown id returns null', async () => {
      const loaded = await seneca.entity(canon).load$('nonexistent-id-xxx')
      expect(loaded).toBeNull()
    })


    test('(g) load does not return the embedding', async () => {
      const ent = await seneca.entity(canon).make$().data$({
        text: 'no-vec-on-load',
        vector: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
      }).save$()
      const loaded = await seneca.entity(canon).load$(ent.id)
      expect(loaded).not.toBeNull()
      expect(loaded.vector).toBeUndefined()
    })


    test('(h) vector stored as pgvector literal (not pg array)', async () => {
      // Regression test: pg auto-encodes number[] as Postgres array '{...}', which is
      // the wrong type for vector columns. The driver must serialise as text '[...]'.
      const ent = await seneca.entity(canon).make$().data$({
        text: 'encoding-check',
        vector: [0.11, 0.22, 0.33, 0.44, 0.55, 0.66, 0.77, 0.88],
      }).save$()

      const client = new Client({ connectionString: url })
      await client.connect()
      try {
        // Cast embedding to text — pgvector returns its canonical text form '[v1,v2,...]'.
        const res = await client.query(
          `SELECT embedding::text AS emb_text FROM ${table} WHERE id = $1`,
          [ent.id],
        )
        expect(res.rows.length).toEqual(1)
        const embText: string = res.rows[0].emb_text
        expect(embText).toMatch(/^\[/)  // starts with [
        expect(embText).toMatch(/\]$/)  // ends with ]
        // Parse and compare values within float tolerance
        const parsed = JSON.parse(embText) as number[]
        expect(parsed.length).toEqual(8)
        expect(parsed[0]).toBeCloseTo(0.11, 4)
        expect(parsed[7]).toBeCloseTo(0.88, 4)
      } finally {
        await client.end()
      }
    })
  })


  test('utils.resolveTable', () => {
    const utils = (VectorStore as any)['utils']
    const resolveTable = utils.resolveTable
    const seneca = makeSeneca()
    const ent0 = seneca.make('foo')
    const ent1 = seneca.make('foo/bar')

    // Same cases as the original utils.resolveIndex test, but reading options.index.
    expect(resolveTable(ent0, { index: {} })).toEqual('foo')
    expect(resolveTable(ent0, { index: { exact: 'qaz' } })).toEqual('qaz')
    expect(resolveTable(ent1, { index: {} })).toEqual('foo_bar')
    expect(resolveTable(ent1, { index: { prefix: 'p0', suffix: 's0' } })).toEqual('p0_foo_bar_s0')
    expect(resolveTable(ent1, {
      index: { map: { '-/foo/bar': 'FOOBAR' }, prefix: 'p0', suffix: 's0' }
    })).toEqual('FOOBAR')

    // options.table (new name) produces the same result as options.index (legacy alias).
    expect(resolveTable(ent1, { table: { exact: 'qaz' } })).toEqual('qaz')
    expect(resolveTable(ent1, { table: { prefix: 'p0', suffix: 's0' } })).toEqual('p0_foo_bar_s0')
    expect(resolveTable(ent1, {
      table: { map: { '-/foo/bar': 'FOOBAR' } }
    })).toEqual('FOOBAR')

    // table.exact wins over index.exact
    expect(resolveTable(ent1, {
      table: { exact: 'TBL' },
      index: { exact: 'IDX' }
    })).toEqual('TBL')
  }, 22222)

})
