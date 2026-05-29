/* Copyright (c) 2024 Seneca contributors, MIT License */

import { Gubu } from 'gubu'

import { Driver, DriverQueryOpts } from './driver/Driver'
import { OpensearchDriver } from './driver/OpensearchDriver'
import { PgvectorDriver } from './driver/PgvectorDriver'

const { Open, Any } = Gubu


// Catalogue of known drivers. Each driver chips in one entry here and one entry in the
// `drivers` registry below. TypeScript narrows `options.driver` to these names.
export enum DriverName {
  Opensearch = 'opensearch',
  Pgvector = 'pgvector',
}


type Options = {
  debug: boolean
  driver: DriverName | `${DriverName}`
  map?: any
  canon?: any
  table: {
    prefix: string
    suffix: string
    map: Record<string, string>
    exact: string
  }
  index?: {
    prefix?: string
    suffix?: string
    map?: Record<string, string>
    exact?: string
  }
  field: {
    zone: { name: string }
    base: { name: string }
    name: { name: string }
    vector: { name: string }
  }
  cmd: {
    list: { size: number }
  }
  opensearch: any
  aws: any
  pg: any
}

export type VectorStoreOptions = Partial<Options>

// Driver registry. Adding a new driver = a new file under src/driver/ + one line here
// + one entry in the `DriverName` enum above. The `Record<DriverName, ...>` shape forces
// the three to stay in sync — TypeScript errors if any enum value lacks a registry entry.
const drivers: Record<DriverName, new (opts: any) => Driver> = {
  [DriverName.Opensearch]: OpensearchDriver,
  [DriverName.Pgvector]: PgvectorDriver,
}

function VectorStore(this: any, options: Options) {
  const seneca: any = this

  // Synchronous validation — throws cleanly during seneca.use() before any
  // prepare hook is queued. Avoids seneca's fatal-error watchdog (which fires
  // process.exit on errors thrown from seneca.prepare).
  const DriverClass = checkDriverChoice(options.driver)

  const init = seneca.export('entity/init')

  let desc: any = 'VectorStore'

  // The driver instance is created eagerly (a pure constructor call — no I/O). The
  // connection is opened from the `init:<store.name>` action registered below — the
  // canonical Seneca store pattern (cf. seneca-postgres-store): Seneca runs the init
  // action during ready(), after the store is registered and before any store message
  // is routed, so the connection is live by the time save/load/list run. We do NOT use
  // a seneca-promisify `prepare` hook: opening the connection there makes the store's
  // `close` fire spuriously during plugin init (tearing the connection back down).
  const driver: Driver = new DriverClass(buildDriverOpts(options))

  const store = {
    name: 'VectorStore',

    save: function (this: any, msg: any, reply: any) {
      const ent = msg.ent
      const canon = ent.canon$({ object: true })
      const canonstr: string = ent.canon$({ string: true })
      const table = resolveTable(ent, options)

      const data = ent.data$(false)
      const id = data.id
      const vector = data.vector
      const metadata: Record<string, any> = { ...data }
      delete metadata.id
      delete metadata.vector

      // Per-canon dim validation. options.canon accepts either the full canon string
      // ('-/foo/chunk') or the base/name shorthand ('foo/chunk') as a key.
      const dim = lookupCanonDim(options.canon, canonstr)
      if (dim != null && vector !== undefined) {
        if (!Array.isArray(vector)) {
          return reply(
            new Error(
              `VectorStore: vector must be a number[] for ${canonstr}`,
            ),
          )
        }
        if (vector.length !== dim) {
          return reply(
            new Error(
              `VectorStore: vector dim mismatch for ${canonstr} — expected ${dim}, got ${vector.length}`,
            ),
          )
        }
      }

      // Inject canon-derived fields per options.field config. No-op when field.{n}.name is ''.
      const fieldOpts: any = options.field || {}
      ;(['zone', 'base', 'name'] as const).forEach((n) => {
        if (
          fieldOpts[n] &&
          '' !== fieldOpts[n].name &&
          null != canon[n] &&
          '' !== canon[n]
        ) {
          metadata[fieldOpts[n].name] = canon[n]
        }
      })

      driver
        .upsert(table, id, vector, metadata)
        .then((res) => {
          ent.id = res.id
          reply(ent)
        })
        .catch((err: any) => reply(err))
    },

    load: function (this: any, msg: any, reply: any) {
      const ent = msg.ent
      const table = resolveTable(ent, options)
      const q = msg.q || {}

      if (null != q.id) {
        driver
          .get(table, q.id)
          .then((row) => {
            if (row === null) return reply(null)
            ent.data$(row.metadata)
            ent.id = row.id
            reply(ent)
          })
          .catch((err: any) => reply(err))
      } else {
        reply()
      }
    },

    list: function (this: any, msg: any, reply: any) {
      const ent = msg.ent
      const table = resolveTable(ent, options)
      const q = msg.q || {}

      const queryOpts = buildDriverQueryOpts(q, msg, options)

      driver
        .query(table, queryOpts)
        .then((rows) => {
          const list = rows.map((row) => {
            const item = ent.make$().data$(row.metadata)
            item.id = row.id
            if (row.score != null) item.custom$ = { score: row.score }
            return item
          })
          reply(list)
        })
        .catch((err: any) => reply(err))
    },

    remove: function (this: any, msg: any, reply: any) {
      const ent = msg.ent
      const table = resolveTable(ent, options)
      const q = msg.q || {}
      const id = q.id

      if (null != id) {
        driver
          .remove(table, id)
          .then(() => reply(null))
          .catch((err: any) => {
            if (err && err.meta && 404 === err.meta.statusCode) {
              return reply(null)
            }
            reply(err)
          })
      } else if (true === q.all$) {
        const queryOpts = buildDriverQueryOpts(q, msg, options)
        driver
          .removeQuery(table, queryOpts)
          .then(() => reply(null))
          .catch((err: any) => reply(err))
      } else {
        reply(null)
      }
    },

    close: function (this: any, _msg: any, reply: any) {
      this.log.debug('close', desc)
      driver
        .close()
        .then(() => reply())
        .catch(reply)
    },

    // Legacy native accessor — surfaces the driver (and, by extension, the underlying client).
    native: function (this: any, _msg: any, reply: any) {
      reply(null, { driver })
    },
  }

  const meta = init(seneca, options, store)
  desc = meta.desc

  // Open the connection from the store init action — the same pattern as
  // seneca-postgres-store: `seneca.add({init: store.name, tag: meta.tag}, ...)`.
  // Seneca runs it during ready(), after the store is registered and before any store
  // message is routed, so the connection is live before the first save/load/list.
  // Shutdown is handled by the store's `close` cmd (driver.close → pool.end()).
  seneca.add({ init: store.name, tag: meta.tag }, function (
    this: any,
    _msg: any,
    done: any,
  ) {
    driver
      .connect()
      .then(() => done())
      .catch(done)
  })

  return {
    name: store.name,
    tag: meta.tag,
    exportmap: {
      native: () => ({ driver }),
    },
  }
}

// Validate the chosen driver name and return its constructor. Accepts any string
// (callers from plain JS can bypass the DriverName enum). Throws synchronously with a
// clear message. Exposed via utils for direct test access.
function checkDriverChoice(name: string): new (opts: any) => Driver {
  if (!name || '' === name) {
    throw new Error('VectorStore: options.driver is required')
  }
  if (!(name in drivers)) {
    throw new Error(
      `VectorStore: unknown driver '${name}'. Available: ${Object.keys(drivers).join(', ')}`,
    )
  }
  return drivers[name as DriverName]
}


function buildDriverOpts(options: Options): any {
  switch (options.driver) {
    case DriverName.Opensearch:
      return {
        opensearch: options.opensearch,
        aws: options.aws,
        field: options.field,
        cmd: options.cmd,
      }
    case DriverName.Pgvector:
      return {
        pg: options.pg,
      }
    default:
      return options
  }
}

function buildDriverQueryOpts(
  q: any,
  msg: any,
  options: Options,
): DriverQueryOpts {
  const filters: Record<string, any> = {}
  for (const k in q) {
    if (k !== 'vector' && !k.match(/\$/)) {
      filters[k] = q[k]
    }
  }

  const vectorDirective = msg.vector$ || q.directive$?.vector$
  const out: DriverQueryOpts = {
    limit: msg.size$ || options.cmd.list.size,
  }
  if (Object.keys(filters).length > 0) {
    out.filters = filters
  }
  if (vectorDirective && q.vector) {
    out.vector = q.vector
    const kFromDirective =
      typeof vectorDirective === 'object' && vectorDirective !== null
        ? vectorDirective.k
        : undefined
    out.k = kFromDirective ?? options.cmd.list.size
  }
  return out
}

// Look up a per-canon vector dim, accepting either the full canon string ('-/foo/chunk')
// or the base/name shorthand ('foo/chunk') as a key in options.canon.
function lookupCanonDim(canonOpts: any, canonstr: string): number | null {
  if (!canonOpts || 'object' !== typeof canonOpts) return null
  const shorthand = canonstr.replace(/^-\//, '')
  const entry = canonOpts[canonstr] ?? canonOpts[shorthand]
  if (!entry || !entry.vector || typeof entry.vector.dim !== 'number') return null
  return entry.vector.dim
}


// Renamed from resolveIndex. Reads options.table; falls back to options.index for backward-compat.
function resolveTable(ent: any, options: Options): string {
  const tableOpts: any = options.table || {}
  const indexOpts: any = options.index || {}

  if ('' !== tableOpts.exact && null != tableOpts.exact) return tableOpts.exact
  if ('' !== indexOpts.exact && null != indexOpts.exact) return indexOpts.exact

  const canonstr = ent.canon$({ string: true })
  const combinedMap: Record<string, string> = {
    ...(indexOpts.map || {}),
    ...(tableOpts.map || {}),
  }
  if ('' !== combinedMap[canonstr] && null != combinedMap[canonstr]) {
    return combinedMap[canonstr]
  }

  let prefix = tableOpts.prefix || indexOpts.prefix || ''
  let suffix = tableOpts.suffix || indexOpts.suffix || ''

  prefix = '' === prefix || null == prefix ? '' : prefix + '_'
  suffix = '' === suffix || null == suffix ? '' : '_' + suffix

  const infix = ent
    .canon$({ string: true })
    .replace(/-\//g, '')
    .replace(/\//g, '_')

  return prefix + infix + suffix
}

// Defaults: Gubu schema. `Any()` / `Open(...)` are Gubu helpers; runtime values are validated against them.
const defaults: any = {
  debug: false,
  driver: '',
  map: Any(),
  canon: Any(),
  table: {
    prefix: '',
    suffix: '',
    map: {},
    exact: '',
  },
  index: {
    prefix: '',
    suffix: '',
    map: {},
    exact: '',
  },
  field: {
    zone: { name: 'zone' },
    base: { name: 'base' },
    name: { name: 'name' },
    vector: { name: 'vector' },
  },
  cmd: {
    list: {
      size: 11,
    },
  },
  opensearch: Open({
    node: 'NODE-URL',
  }),
  aws: Open({
    region: 'us-east-1',
  }),
  pg: Open({
    url: '',
  }),
}

Object.assign(VectorStore, {
  defaults,
  utils: { resolveTable, checkDriverChoice, drivers },
  DriverName,
})

export default VectorStore

if ('undefined' !== typeof module) {
  // CommonJS interop: callers can do either:
  //   const VectorStore = require('@seneca/vector-store')        // -> the function (DriverName attached as static)
  //   const { DriverName } = require('@seneca/vector-store')     // -> enum directly
  // Reassigning module.exports clobbers the auto-generated exports.DriverName from the
  // `export enum` declaration, so we re-attach it manually.
  module.exports = VectorStore
  module.exports.DriverName = DriverName
}
