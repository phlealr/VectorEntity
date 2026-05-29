/* Copyright (c) 2024 Seneca contributors, MIT License */

import { randomUUID } from 'crypto'

import { Pool, PoolConfig } from 'pg'

import {
  Driver,
  DriverGetResult,
  DriverQueryOpts,
  DriverQueryRow,
  DriverUpsertResult,
} from './Driver'


// pg cannot parametrise identifiers (table names) — we interpolate them into the SQL
// directly, so we constrain the shape to a strict identifier regex up front. Any
// table name reaching the driver must match. SQL injection lives here if this slips.
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function assertIdentifier(label: string, value: string): void {
  if (!IDENT_RE.test(value)) {
    throw new Error(
      `PgvectorDriver: invalid ${label} '${value}' — must match ${IDENT_RE}`,
    )
  }
}


// Vector literal for pgvector. pg encodes number[] as a Postgres array '{...}' by default,
// which is the wrong type for a vector column. Always serialise explicitly.
function encodeVector(vector: number[]): string {
  return '[' + vector.join(',') + ']'
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
      throw new Error('PgvectorDriver.upsert: vector is required (pgvector does not allow null embeddings)')
    }
    assertVector(vector)

    // pgvector requires an id (primary key). Generate one if the caller didn't supply one.
    // This is a per-driver concern — the OpenSearch driver delegates id generation to
    // the OpenSearch server, so the plugin doesn't pre-generate.
    const resolvedId = id ?? randomUUID()

    const sql =
      `INSERT INTO ${table}(id, embedding, metadata) VALUES ($1, $2, $3) ` +
      `ON CONFLICT (id) DO UPDATE SET embedding=EXCLUDED.embedding, metadata=EXCLUDED.metadata ` +
      `RETURNING id`

    const res = await this.requirePool().query(sql, [
      resolvedId,
      encodeVector(vector),
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
    _table: string,
    _opts: DriverQueryOpts,
  ): Promise<DriverQueryRow[]> {
    throw new Error('PgvectorDriver.query: not implemented (PR3.T1)')
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
