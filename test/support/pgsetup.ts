/* Copyright (c) 2024 Seneca contributors, MIT License */

import { Client } from 'pg'


const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/


function assertIdent(label: string, value: string): void {
  if (!IDENT_RE.test(value)) {
    throw new Error(`pgsetup: invalid ${label} '${value}'`)
  }
}


// pgvector tests only run when SENECA_VECTOR_PG_URL is set. CI sets it to the
// docker-compose pgvector service; local devs export it after `docker compose up -d`.
// Without the env var, the conditional describe blocks should skip cleanly.
export function pgAvailable(): boolean {
  const url = process.env.SENECA_VECTOR_PG_URL
  return Boolean(url && url.length > 0)
}


export function pgUrl(): string {
  const url = process.env.SENECA_VECTOR_PG_URL
  if (!url) {
    throw new Error('pgsetup: SENECA_VECTOR_PG_URL is not set')
  }
  return url
}


// Build a fresh table with the pgvector extension + HNSW cosine index. Matches the
// DDL documented in the plan: id (pk) + embedding (vector(dim)) + metadata (jsonb).
export async function setupTable(spec: {
  url: string
  table: string
  dim: number
}): Promise<void> {
  assertIdent('table', spec.table)
  if (!Number.isInteger(spec.dim) || spec.dim <= 0) {
    throw new Error(`pgsetup: invalid dim ${spec.dim}`)
  }

  const client = new Client({ connectionString: spec.url })
  await client.connect()
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector')
    await client.query(`DROP TABLE IF EXISTS ${spec.table}`)
    await client.query(
      `CREATE TABLE ${spec.table} (
         id text PRIMARY KEY,
         embedding vector(${spec.dim}) NOT NULL,
         metadata jsonb NOT NULL DEFAULT '{}'
       )`,
    )
    await client.query(
      `CREATE INDEX ${spec.table}_emb_idx ON ${spec.table} USING hnsw (embedding vector_cosine_ops)`,
    )
  } finally {
    await client.end()
  }
}


export async function teardown(spec: {
  url: string
  table: string
}): Promise<void> {
  assertIdent('table', spec.table)
  const client = new Client({ connectionString: spec.url })
  await client.connect()
  try {
    await client.query(`DROP TABLE IF EXISTS ${spec.table}`)
  } finally {
    await client.end()
  }
}
