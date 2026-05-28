/* Copyright © 2024 Seneca Project Contributors, MIT License. */

require('dotenv').config({ path: '.env.local' })


import Seneca from 'seneca'

import VectorStoreDoc from '../src/VectorStoreDoc'
import VectorStore from '../src/VectorStore'


const OPENSEARCH_NODE = process.env.SENECA_OPENSEARCH_TEST_NODE
const OPENSEARCH_INDEX = process.env.SENECA_OPENSEARCH_TEST_INDEX
const opensearchAvailable = Boolean(OPENSEARCH_NODE && OPENSEARCH_INDEX)
const describeOpensearch = opensearchAvailable ? describe : describe.skip


describe('OpensearchDriver (via VectorStore)', () => {
  test('plugin defined', () => {
    expect(VectorStore).toBeDefined()
    expect(VectorStoreDoc).toBeDefined()
  })


  test('utils.resolveTable', () => {
    const utils = (VectorStore as any)['utils']
    const resolveTable = utils.resolveTable
    const seneca = makeSenecaBase()
    const ent0 = seneca.make('foo')
    const ent1 = seneca.make('foo/bar')

    expect(resolveTable(ent0, { index: {} })).toEqual('foo')
    expect(resolveTable(ent0, { index: { exact: 'qaz' } })).toEqual('qaz')

    expect(resolveTable(ent1, { index: {} })).toEqual('foo_bar')
    expect(resolveTable(ent1, { index: { prefix: 'p0', suffix: 's0' } })).toEqual('p0_foo_bar_s0')
    expect(resolveTable(ent1, {
      index: { map: { '-/foo/bar': 'FOOBAR' }, prefix: 'p0', suffix: 's0' }
    }))
      .toEqual('FOOBAR')

    // table alias produces the same result as index
    expect(resolveTable(ent1, { table: { exact: 'qaz' } })).toEqual('qaz')
    expect(resolveTable(ent1, { table: { prefix: 'p0', suffix: 's0' } })).toEqual('p0_foo_bar_s0')
    expect(resolveTable(ent1, {
      table: { map: { '-/foo/bar': 'FOOBAR' } }
    })).toEqual('FOOBAR')
  }, 22222)


  describeOpensearch('against live AWS OpenSearch', () => {
    test('load-plugin', async () => {
      const seneca = makeSeneca()
      await seneca.ready()
      expect(seneca.export('VectorStore/native')).toBeDefined()
      await seneca.close()
    })


    test('insert-remove', async () => {
      const seneca = await makeSeneca()
      await seneca.ready()


      // no query params means no results
      const list0 = await seneca.entity('foo/chunk').list$()
      expect(0 === list0.length)

      const list1 = await seneca.entity('foo/chunk').list$({ test: 'insert-remove' })

      let ent0: any

      if (0 === list1.length) {
        ent0 = await seneca.entity('foo/chunk')
          .make$()
          .data$({
            test: 'insert-remove',
            text: 't01',
            vector: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
            directive$: { vector$: true },
          })
          .save$()
        expect(ent0).toMatchObject({ test: 'insert-remove' })
        await new Promise((r) => setTimeout(r, 2222))
      }
      else {
        ent0 = list1[0]
      }

      await seneca.entity('foo/chunk').remove$(ent0.id)

      await new Promise((r) => setTimeout(r, 2222))

      const list2 = await seneca.entity('foo/chunk').list$({ test: 'insert-remove' })
      expect(list2.filter((n: any) => n.id === ent0.id)).toEqual([])

      await seneca.close()
    }, 22222)


    test('vector-cat', async () => {
      const seneca = await makeSeneca()
      await seneca.ready()

      const list1 = await seneca.entity('foo/chunk').list$({ test: 'vector-cat' })

      if (!list1.find((n: any) => 'code0' === n.code)) {
        await seneca.entity('foo/chunk')
          .make$()
          .data$({
            code: 'code0',
            test: 'vector-cat',
            text: 't01',
            vector: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
            directive$: { vector$: true },
          })
          .save$()
      }

      if (!list1.find((n: any) => 'code1' === n.code)) {
        await seneca.entity('foo/chunk')
          .make$()
          .data$({
            code: 'code1',
            test: 'vector-cat',
            text: 't01',
            vector: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
            directive$: { vector$: true },
          })
          .save$()
      }

      await new Promise((r) => setTimeout(r, 2222))

      const list2 = await seneca.entity('foo/chunk').list$({
        directive$: { vector$: { k: 2 } },
        vector: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
      })
      expect(1 < list2.length).toEqual(true)

      const list3 = await seneca.entity('foo/chunk').list$({
        directive$: { vector$: { k: 2 } },
        vector: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
        code: 'code0'
      })
      expect(list3.length).toEqual(1)

      await seneca.close()
    }, 22222)
  })

})


function makeSenecaBase() {
  // Seneca without the VectorStore plugin — used for tests that only need ent.canon$().
  return Seneca({ legacy: false })
    .test()
    .use('promisify')
    .use('entity')
}


function makeSeneca() {
  return Seneca({ legacy: false })
    .test()
    .use('promisify')
    .use('entity')
    .use(VectorStore, {
      driver: 'opensearch',
      map: {
        'foo/chunk': '*'
      },
      index: {
        exact: OPENSEARCH_INDEX,
      },
      opensearch: {
        node: OPENSEARCH_NODE,
      }
    })
}


const index_test01 = {
  "mappings": {
    "properties": {
      "text": { "type": "text" },
      "vector": {
        "type": "knn_vector",
        "dimension": 8, // 1536,
        "method": {
          "engine": "nmslib",
          "space_type": "cosinesimil",
          "name": "hnsw",
          "parameters": { "ef_construction": 512, "m": 16 }
        }
      }
    }
  },
  "settings": {
    "index": {
      "number_of_shards": 2,
      "knn.algo_param": { "ef_search": 512 },
      "knn": true
    }
  }
}
