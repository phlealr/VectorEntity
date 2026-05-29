/* Copyright © 2024 Seneca Project Contributors, MIT License. */

import Seneca from 'seneca'

import VectorStore from '../src/VectorStore'
import { pgAvailable, pgUrl, setupTable, teardown } from './support/pgsetup'


// End-to-end integration: exercise the ABSTRACTION (the Seneca entity API —
// save$/load$/list$/remove$) against a real pgvector backend. This is the layer
// the task actually asks for: "Tests that exercise the abstraction (the
// Seneca-level interface), not the underlying vendor SDK." The mock-driver suite
// proves the translation logic; this proves the whole stack wires together
// against a live database. Skips cleanly when SENECA_VECTOR_PG_URL is unset.
const describePg = pgAvailable() ? describe : describe.skip


function makeSeneca(url: string, table: string) {
  const seneca: any = Seneca({ legacy: false })
  seneca.options({ system: { exit: () => { /* swallow death watchdog */ } } })
  return seneca
    .test()
    .use('promisify')
    .use('entity')
    .use(VectorStore, {
      driver: 'pgvector',
      pg: { url },
      canon: { 'doc/chunk': { vector: { dim: 4 } } },
      table: { exact: table },
    })
}


describePg('VectorStore <-> pgvector (end-to-end via the entity API)', () => {
  const url = pgAvailable() ? pgUrl() : ''
  const table = 'test_e2e_doc_chunk'
  const dim = 4
  const canon = 'doc/chunk'

  // near cluster (apple, banana) + a far doc (car) so KNN ordering is observable.
  const apple = [1, 0, 0, 0]
  const banana = [0.99, 0.01, 0, 0]
  const car = [0, 1, 1, 1]

  let seneca: any

  beforeAll(async () => {
    await setupTable({ url, table, dim })
    seneca = makeSeneca(url, table)
    await seneca.ready()
  }, 30000)

  afterAll(async () => {
    if (seneca) await seneca.close()
    await teardown({ url, table })
  }, 30000)


  // ---- save ----

  test('save$ persists a vector + metadata and returns the entity with an id', async () => {
    const saved = await seneca.entity(canon).make$().data$({
      text: 'apple',
      cat: 'fruit',
      vector: apple,
    }).save$()

    expect(saved.id).toBeDefined()
    expect(typeof saved.id).toBe('string')
    expect(saved.text).toEqual('apple')
  })


  test('save$ with a caller-supplied id round-trips through load$', async () => {
    await seneca.entity(canon).make$().data$({
      id: 'banana-1',
      text: 'banana',
      cat: 'fruit',
      vector: banana,
    }).save$()

    await seneca.entity(canon).make$().data$({
      id: 'car-1',
      text: 'car',
      cat: 'vehicle',
      vector: car,
    }).save$()

    const loaded = await seneca.entity(canon).load$('banana-1')
    expect(loaded).not.toBeNull()
    expect(loaded.id).toEqual('banana-1')
    expect(loaded.text).toEqual('banana')
    expect(loaded.cat).toEqual('fruit')
    // the embedding is never returned by load$
    expect(loaded.vector).toBeUndefined()
  })


  test('save$ rejects a vector whose dim does not match the canon declaration', async () => {
    await expect(
      seneca.entity(canon).make$().data$({
        text: 'bad',
        vector: [1, 2, 3], // dim 3, canon expects 4
      }).save$()
    ).rejects.toThrow(/dim mismatch/)
  })


  // ---- load ----

  test('load$ of an unknown id returns null', async () => {
    const loaded = await seneca.entity(canon).load$('does-not-exist')
    expect(loaded).toBeNull()
  })


  // ---- list: similarity ----

  test('list$ similarity query returns nearest neighbours with a score', async () => {
    const hits = await seneca.entity(canon).list$({
      directive$: { vector$: { k: 3 } },
      vector: apple,
    })

    expect(hits.length).toBeGreaterThanOrEqual(3)
    // every hit carries a similarity score on custom$
    hits.forEach((h: any) => {
      expect(typeof h.custom$.score).toBe('number')
    })

    // apple (identical) ranks ahead of car (orthogonal).
    const pos = (text: string) => hits.findIndex((h: any) => h.text === text)
    expect(pos('apple')).toBeGreaterThanOrEqual(0)
    expect(pos('apple')).toBeLessThan(pos('car'))
    expect(pos('banana')).toBeLessThan(pos('car'))
  })


  test('list$ similarity query honours k as the result limit', async () => {
    const hits = await seneca.entity(canon).list$({
      directive$: { vector$: { k: 1 } },
      vector: apple,
    })
    expect(hits.length).toEqual(1)
    expect(hits[0].text).toEqual('apple')
  })


  test('list$ similarity combined with an equality filter (AND)', async () => {
    const hits = await seneca.entity(canon).list$({
      cat: 'fruit',
      directive$: { vector$: { k: 5 } },
      vector: apple,
    })
    expect(hits.length).toEqual(2)
    hits.forEach((h: any) => expect(h.cat).toEqual('fruit'))
  })


  // ---- list: filter-only ----

  test('list$ with an equality filter and no vector returns matches without a score', async () => {
    const hits = await seneca.entity(canon).list$({ cat: 'vehicle' })
    expect(hits.length).toEqual(1)
    expect(hits[0].text).toEqual('car')
    expect(hits[0].custom$?.score).toBeUndefined()
  })


  // ---- remove ----

  test('remove$ by id deletes the row', async () => {
    await seneca.entity(canon).make$().data$({
      id: 'rm-1',
      text: 'temp',
      vector: [0.5, 0.5, 0.5, 0.5],
    }).save$()
    expect(await seneca.entity(canon).load$('rm-1')).not.toBeNull()

    await seneca.entity(canon).remove$('rm-1')
    expect(await seneca.entity(canon).load$('rm-1')).toBeNull()
  })
})
