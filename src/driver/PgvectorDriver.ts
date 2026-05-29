/* Copyright (c) 2024 Seneca contributors, MIT License */

import { randomUUID } from 'crypto'

import { Pool, PoolConfig } from 'pg'
import pgvector from 'pgvector'

import {
  Driver,
  DriverGetResult,
  DriverQueryOpts,
  DriverQueryRow,
  DriverUpsertResult,
} from './Driver'


// pg cannot parametrise identifiers (table names, jsonb keys) — they are interpolated
// into the SQL directly, so they must match a strict identifier regex first. SQL
// injection lives here if this slips.
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function assertIdentifier(label: string, value: string): void {
  if (!IDENT_RE.test(value)) {
    throw new Error(
      `PgvectorDriver: invalid ${label} '${value}' — must match ${IDENT_RE}`,
    )
  }
}


// Upper bound on KNN k — guards against accidental huge scans.
const MAX_K = 1000
const DEFAULT_LIMIT = 11


// Coerce a caller-supplied limit (e.g. Seneca's size$) to a sane positive integer.
function normaliseLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_LIMIT
  const n = Math.floor(Number(limit))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(n, MAX_K)
}


function assertVector(vector: unknown): asserts vector is number[] {
  if (!Array.isArray(vector)) {
    throw new Error('PgvectorDriver: vector must be a number[]')
  }
  if (vector.length === 0) {
    throw new Error('PgvectorDriver: vector must be non-empty')
  }
  for (let i = 0; i < vector.length; i++) {
    if (typeof vector[i] !== 'number' || !Number.isFinite(vector[i])) {
      throw new Error(
        `PgvectorDriver: vector[${i}] is not a finite number (got ${typeof vector[i]})`,
      )
    }
  }
}


// Build an AND-combined equality WHERE clause over jsonb metadata fields. Equality is
// text-typed (metadata->>'key' = $N) — a documented v0 limitation: numeric filters on
// values stored as JSON numbers won't match. Param indexes start at startIdx.
function buildWhere(
  filters: Record<string, any> | undefined,
  startIdx: number,
): { sql: string; params: any[] } {
  if (!filters) return { sql: '', params: [] }
  const keys = Object.keys(filters)
  if (keys.length === 0) return { sql: '', params: [] }

  const clauses: string[] = []
  const params: any[] = []
  let idx = startIdx
  for (const key of keys) {
    assertIdentifier('filter key', key)
    clauses.push(`metadata->>'${key}' = $${idx}`)
    params.push(String(filters[key]))
    idx++
  }
  return { sql: ' WHERE ' + clauses.join(' AND '), params }
}


export type PgvectorDriverOptions = {
  pg: {
    url: string
    pool?: PoolConfig
  }
}


export class PgvectorDriver implements Driver {
  private opts: PgvectorDriverOptions
  private pool: Pool | null = null

  constructor(opts: PgvectorDriverOptions) {
    this.opts = opts
    if (!opts?.pg?.url || '' === opts.pg.url) {
      throw new Error('PgvectorDriver: options.pg.url is required')
    }
  }

  async connect(): Promise<void> {
    this.pool = new Pool({
      connectionString: this.opts.pg.url,
      ...(this.opts.pg.pool || {}),
    })
    // Sanity ping — fails fast if the URL is wrong or the server is unreachable.
    // NOTE: no pgvector type parser is registered — none of our queries select the
    // embedding column back (get/query return metadata only), so decoding is never
    // needed. Encoding still goes through pgvector.toSql() in upsert/query.
    await this.pool.query('SELECT 1')
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end()
      this.pool = null
    }
  }

  async upsert(
    table: string,
    id: string | undefined,
    vector: number[] | undefined,
    metadata: Record<string, any>,
  ): Promise<DriverUpsertResult> {
    assertIdentifier('table', table)
    if (vector === undefined) {
      throw new Error(
        'PgvectorDriver.upsert: vector is required (pgvector does not allow null embeddings)',
      )
    }
    assertVector(vector)

    // pgvector requires an id (primary key). Generate one if the caller didn't supply
    // one — a per-driver concern (the OpenSearch driver delegates id generation to the
    // server instead).
    const resolvedId = id ?? randomUUID()

    const sql =
      `INSERT INTO ${table}(id, embedding, metadata) VALUES ($1, $2, $3) ` +
      `ON CONFLICT (id) DO UPDATE SET embedding=EXCLUDED.embedding, metadata=EXCLUDED.metadata ` +
      `RETURNING id`

    const res = await this.requirePool().query(sql, [
      resolvedId,
      pgvector.toSql(vector),
      metadata,
    ])
    return { id: res.rows[0].id }
  }

  async get(table: string, id: string): Promise<DriverGetResult | null> {
    assertIdentifier('table', table)
    const res = await this.requirePool().query(
      `SELECT id, metadata FROM ${table} WHERE id = $1 LIMIT 1`,
      [id],
    )
    if (res.rows.length === 0) return null
    return { id: res.rows[0].id, metadata: res.rows[0].metadata }
  }

  async query(
    table: string,
    opts: DriverQueryOpts,
  ): Promise<DriverQueryRow[]> {
    assertIdentifier('table', table)

    // (a) KNN similarity (optionally combined with equality filters).
    if (opts.vector) {
      assertVector(opts.vector)
      const k = opts.k ?? DEFAULT_LIMIT
      if (!Number.isInteger(k) || k <= 0) {
        throw new Error(`PgvectorDriver.query: invalid k ${k}`)
      }
      if (k > MAX_K) {
        throw new Error(`PgvectorDriver.query: k ${k} exceeds max ${MAX_K}`)
      }

      // $1 is the query vector (reused in SELECT score + ORDER BY); filters start at
      // $2; the LIMIT is the final parameter.
      const where = buildWhere(opts.filters, 2)
      const limitIdx = 2 + where.params.length
      const sql =
        `SELECT id, metadata, 1 - (embedding <=> $1) AS score FROM ${table}` +
        where.sql +
        ` ORDER BY embedding <=> $1 LIMIT $${limitIdx}`

      const res = await this.requirePool().query(sql, [
        pgvector.toSql(opts.vector),
        ...where.params,
        k,
      ])
      return res.rows.map((r: any) => ({
        id: r.id,
        metadata: r.metadata,
        score: r.score == null ? undefined : Number(r.score),
      }))
    }

    // (b) Filter-only — no score, no ordering by similarity.
    if (opts.filters && Object.keys(opts.filters).length > 0) {
      const limit = normaliseLimit(opts.limit)
      const where = buildWhere(opts.filters, 1)
      const limitIdx = 1 + where.params.length
      const sql =
        `SELECT id, metadata FROM ${table}` + where.sql + ` LIMIT $${limitIdx}`
      const res = await this.requirePool().query(sql, [...where.params, limit])
      return res.rows.map((r: any) => ({ id: r.id, metadata: r.metadata }))
    }

    // (c) Neither vector nor filters — empty result.
    return []
  }

  async remove(table: string, id: string): Promise<void> {
    assertIdentifier('table', table)
    await this.requirePool().query(
      `DELETE FROM ${table} WHERE id = $1`,
      [id],
    )
  }

  // Delete by equality filters (the all$ path). With no filters this deletes every
  // row in the table — that is the caller's explicit all$:true intent.
  async removeQuery(table: string, opts: DriverQueryOpts): Promise<void> {
    assertIdentifier('table', table)
    const where = buildWhere(opts.filters, 1)
    await this.requirePool().query(`DELETE FROM ${table}` + where.sql, where.params)
  }

  // Backwards-compat accessor for the plugin's exportmap.native.
  getPool(): Pool | null {
    return this.pool
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error('PgvectorDriver: connect() has not been called')
    }
    return this.pool
  }
}
