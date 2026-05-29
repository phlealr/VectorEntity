/* Copyright © 2024 Seneca Project Contributors, MIT License. */

import Seneca from 'seneca'

import VectorStore, { DriverName } from '../src/VectorStore'
import VectorStoreDoc from '../src/VectorStoreDoc'
import { MockDriver, MockDriverNoRemove } from './support/MockDriver'


function makeSeneca() {
  // system.exit override defends against seneca's death watchdog (which calls
  // process.exit after death_delay on fatal plugin errors).
  const seneca: any = Seneca({ legacy: false })
  seneca.options({ system: { exit: () => { /* swallowed */ } } })
  return seneca.test().use('promisify').use('entity')
}


// ---------------------------------------------------------------------------
// Plugin surface — exports, driver registry, option validation, table resolve.
// No backend involved.
// ---------------------------------------------------------------------------

describe('VectorStore plugin surface', () => {

  test('plugin + doc exports defined', () => {
    expect(VectorStore).toBeDefined()
    expect(VectorStoreDoc).toBeDefined()
  })


  test('driver registry contains opensearch + pgvector', () => {
    const utils = (VectorStore as any)['utils']
    expect(utils.drivers).toBeDefined()
    expect(Object.keys(utils.drivers)).toContain('opensearch')
    expect(Object.keys(utils.drivers)).toContain('pgvector')
  })


  test('DriverName enum entries are all registered', () => {
    expect(DriverName.Opensearch).toEqual('opensearch')
    expect(DriverName.Pgvector).toEqual('pgvector')
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
    expect(() => utils.checkDriverChoice('weaviate')).toThrow(/unknown driver 'weaviate'/)
  })


  test('checkDriverChoice accepts registered drivers', () => {
    const utils = (VectorStore as any)['utils']
    expect(() => utils.checkDriverChoice('opensearch')).not.toThrow()
    expect(() => utils.checkDriverChoice('pgvector')).not.toThrow()
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


// ---------------------------------------------------------------------------
// Translation layer — the plugin's actual job. Verified with a MockDriver:
// we receive Seneca inputs correctly, translate them to Driver calls correctly,
// and map Driver results back into Seneca's entity shape. No real DB.
// ---------------------------------------------------------------------------

describe('VectorStore translation (mock driver)', () => {
  const canon = 'foo/chunk'
  const table = 'mock_table'
  const dim = 4

  beforeAll(() => {
    // Register the mocks in the plugin's driver registry.
    const utils = (VectorStore as any)['utils']
    utils.drivers.mock = MockDriver
    utils.drivers.mocknoremove = MockDriverNoRemove
  })

  beforeEach(() => {
    MockDriver.reset()
    MockDriverNoRemove.reset()
  })

  async function loadMock(driverName: string = 'mock') {
    const seneca = makeSeneca().use(VectorStore, {
      driver: driverName,
      canon: { [canon]: { vector: { dim } } },
      table: { map: { [`-/${canon}`]: table } },
    })
    await seneca.ready()
    return seneca
  }


  // ---- save ----

  test('save translates entity → upsert(table, id, vector, metadata)', async () => {
    const seneca = await loadMock()
    const mock = MockDriver.last()

    const saved = await seneca.entity(canon).make$().data$({
      text: 'hello',
      rank: 5,
      vector: [0.1, 0.2, 0.3, 0.4],
    }).save$()

    const call = mock.lastCall('upsert')
    expect(call).toBeDefined()
    const [t, id, vector, metadata] = call!.args

    // Correct table resolution.
    expect(t).toEqual(table)
    // No id provided by caller → passes undefined through (driver/seneca decides).
    expect(id).toBeUndefined()
    // Vector forwarded verbatim.
    expect(vector).toEqual([0.1, 0.2, 0.3, 0.4])
    // Metadata carries scalar fields but NOT id or vector.
    expect(metadata.text).toEqual('hello')
    expect(metadata.rank).toEqual(5)
    expect(metadata.vector).toBeUndefined()
    expect(metadata.id).toBeUndefined()

    // Response id comes from the driver result.
    expect(saved.id).toEqual('mock-generated-id')

    await seneca.close()
  })


  test('save forwards a caller-provided id to upsert', async () => {
    const seneca = await loadMock()
    const mock = MockDriver.last()

    await seneca.entity(canon).make$().data$({
      id: 'given-id',
      text: 't',
      vector: [1, 2, 3, 4],
    }).save$()

    const [, id] = mock.lastCall('upsert')!.args
    expect(id).toEqual('given-id')

    await seneca.close()
  })


  test('save rejects on per-canon dim mismatch without calling the driver', async () => {
    const seneca = await loadMock()
    const mock = MockDriver.last()

    await expect(
      seneca.entity(canon).make$().data$({
        text: 't',
        vector: [1, 2, 3], // dim 3, canon expects 4
      }).save$()
    ).rejects.toThrow(/dim mismatch/)

    expect(mock.callsOf('upsert').length).toEqual(0)

    await seneca.close()
  })


  test('save forwards undefined vector (the driver decides whether to reject)', async () => {
    const seneca = await loadMock()
    const mock = MockDriver.last()

    await seneca.entity(canon).make$().data$({ text: 'no-vec' }).save$()

    const [, , vector] = mock.lastCall('upsert')!.args
    expect(vector).toBeUndefined()

    await seneca.close()
  })


  // ---- load ----

  test('load translates id → get(table, id) and maps metadata back', async () => {
    const seneca = await loadMock()
    const mock = MockDriver.last()
    mock.getResult = { id: 'row-1', metadata: { text: 'hi', n: 2 } }

    const loaded = await seneca.entity(canon).load$('row-1')

    const call = mock.lastCall('get')
    expect(call!.args).toEqual([table, 'row-1'])
    expect(loaded.id).toEqual('row-1')
    expect(loaded.text).toEqual('hi')
    expect(loaded.n).toEqual(2)

    await seneca.close()
  })


  test('load returns null when the driver finds nothing', async () => {
    const seneca = await loadMock()
    const mock = MockDriver.last()
    mock.getResult = null

    const loaded = await seneca.entity(canon).load$('missing')
    expect(loaded).toBeNull()

    await seneca.close()
  })


  test('load without an id does not call the driver', async () => {
    const seneca = await loadMock()
    const mock = MockDriver.last()

    await seneca.entity(canon).load$({ text: 'no-id-here' })
    expect(mock.callsOf('get').length).toEqual(0)

    await seneca.close()
  })


  // ---- list: KNN ----

  test('list with vector$ {k} → query with vector + k, maps custom$.score', async () => {
    const seneca = await loadMock()
    const mock = MockDriver.last()
    mock.queryResult = [
      { id: 'a', metadata: { text: 'A' }, score: 0.9 },
      { id: 'b', metadata: { text: 'B' }, score: 0.8 },
    ]

    const list = await seneca.entity(canon).list$({
      directive$: { vector$: { k: 2 } },
      vector: [0.1, 0.2, 0.3, 0.4],
    })

    const [t, opts] = mock.lastCall('query')!.args
    expect(t).toEqual(table)
    expect(opts.vector).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(opts.k).toEqual(2)

    expect(list.length).toEqual(2)
    expect(list[0].id).toEqual('a')
    expect(list[0].text).toEqual('A')
    expect(list[0].custom$.score).toEqual(0.9)
    expect(list[1].custom$.score).toEqual(0.8)

    await seneca.close()
  })


  test('list with vector$ boolean → k defaults to cmd.list.size (11)', async () => {
    const seneca = await loadMock()
    const mock = MockDriver.last()

    await seneca.entity(canon).list$({
      directive$: { vector$: true },
      vector: [0.1, 0.2, 0.3, 0.4],
    })

    const [, opts] = mock.lastCall('query')!.args
    expect(opts.vector).toEqual([0.1, 0.2, 0.3, 0.4])
    expect(opts.k).toEqual(11)

    await seneca.close()
  })


  // ---- list: filters ----

  test('list with equality fields → query with filters, no score on results', async () => {
    const seneca = await loadMock()
    const mock = MockDriver.last()
    mock.queryResult = [{ id: 'c', metadata: { code: 'x', text: 'C' } }] // no score

    const list = await seneca.entity(canon).list$({ code: 'x' })

    const [, opts] = mock.lastCall('query')!.args
    expect(opts.filters).toEqual({ code: 'x' })
    expect(opts.vector).toBeUndefined()

    expect(list.length).toEqual(1)
    expect(list[0].code).toEqual('x')
    // No score set: custom$ stays the entity's built-in (a function), never our {score}.
    expect(list[0].custom$?.score).toBeUndefined()

    await seneca.close()
  })


  test('list partitions filters: skips "vector" and $-suffixed keys', async () => {
    const seneca = await loadMock()
    const mock = MockDriver.last()

    await seneca.entity(canon).list$({
      code: 'x',
      kind: 'y',
      vector: [0.1, 0.2, 0.3, 0.4],
      directive$: { vector$: true },
    })

    const [, opts] = mock.lastCall('query')!.args
    expect(opts.filters).toEqual({ code: 'x', kind: 'y' })
    expect(opts.vector).toEqual([0.1, 0.2, 0.3, 0.4])
    // 'vector' and 'directive$' must not leak into filters.
    expect(opts.filters.vector).toBeUndefined()
    expect(opts.filters.directive$).toBeUndefined()

    await seneca.close()
  })


  test('empty query → query called with neither vector nor filters → []', async () => {
    const seneca = await loadMock()
    const mock = MockDriver.last()
    mock.queryResult = []

    const list = await seneca.entity(canon).list$()

    const [, opts] = mock.lastCall('query')!.args
    expect(opts.vector).toBeUndefined()
    expect(opts.filters).toBeUndefined()
    expect(list).toEqual([])

    await seneca.close()
  })


  // ---- remove ----

  test('remove translates id → driver.remove(table, id)', async () => {
    const seneca = await loadMock()
    const mock = MockDriver.last()

    await seneca.entity(canon).remove$('rm-1')

    const call = mock.lastCall('remove')
    expect(call!.args).toEqual([table, 'rm-1'])

    await seneca.close()
  })


  test('remove with all$ translates to driver.removeQuery(table, {filters})', async () => {
    const seneca = await loadMock()
    const mock = MockDriver.last()

    await seneca.entity(canon).remove$({ all$: true, code: 'x' })

    const call = mock.lastCall('removeQuery')
    expect(call).toBeDefined()
    const [t, opts] = call!.args
    expect(t).toEqual(table)
    expect(opts.filters).toEqual({ code: 'x' })

    await seneca.close()
  })


  test('remove (by id) errors when the driver does not support remove', async () => {
    const seneca = await loadMock('mocknoremove')

    await expect(
      seneca.entity(canon).remove$('rm-1')
    ).rejects.toThrow(/does not support remove/)

    await seneca.close()
  })


  test('remove (all$) errors when the driver does not support removeQuery', async () => {
    const seneca = await loadMock('mocknoremove')

    await expect(
      seneca.entity(canon).remove$({ all$: true, code: 'x' })
    ).rejects.toThrow(/does not support removeQuery/)

    await seneca.close()
  })

})
