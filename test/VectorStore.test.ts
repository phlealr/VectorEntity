/* Copyright © 2024 Seneca Project Contributors, MIT License. */

import Seneca from 'seneca'

import VectorStore, { DriverName } from '../src/VectorStore'
import VectorStoreDoc from '../src/VectorStoreDoc'


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
