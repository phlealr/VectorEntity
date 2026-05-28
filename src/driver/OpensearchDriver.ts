/* Copyright (c) 2024 Seneca contributors, MIT License */

import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws'
import { Client } from '@opensearch-project/opensearch'
import { defaultProvider } from '@aws-sdk/credential-provider-node'

import {
  Driver,
  DriverGetResult,
  DriverQueryOpts,
  DriverQueryRow,
  DriverUpsertResult,
} from './Driver'

export type OpensearchDriverOptions = {
  opensearch: { node: string }
  aws: { region: string }
  field?: { vector?: { name?: string } }
  cmd?: { list?: { size?: number } }
}

export class OpensearchDriver implements Driver {
  private opts: OpensearchDriverOptions
  private client: any = null

  constructor(opts: OpensearchDriverOptions) {
    this.opts = opts
  }

  async connect(): Promise<void> {
    this.client = new Client({
      ...AwsSigv4Signer({
        region: this.opts.aws.region,
        service: 'aoss',
        getCredentials: () => {
          const credentialsProvider = defaultProvider()
          return credentialsProvider()
        },
      }),
      node: this.opts.opensearch.node,
    })
  }

  async close(): Promise<void> {
    // OpenSearch JS client has no explicit close; nothing to do.
  }

  async upsert(
    table: string,
    id: string | undefined,
    vector: number[] | undefined,
    metadata: Record<string, any>,
  ): Promise<DriverUpsertResult> {
    const body: Record<string, any> = { ...metadata }
    if (vector !== undefined) {
      body[this.vectorFieldName()] = vector
    }
    const req: any = { index: table, body }
    if (id) req.id = id
    const res = await this.client.index(req)
    return { id: res.body._id }
  }

  async get(table: string, id: string): Promise<DriverGetResult | null> {
    try {
      const res = await this.client.get({ index: table, id })
      return { id: res.body._id, metadata: res.body._source }
    } catch (err: any) {
      if (err && err.meta && 404 === err.meta.statusCode) return null
      throw err
    }
  }

  async query(
    table: string,
    opts: DriverQueryOpts,
  ): Promise<DriverQueryRow[]> {
    const queryClause = this.buildQueryClause(opts)
    if (queryClause === null) return []

    const defaultSize = this.opts.cmd?.list?.size ?? 11
    const size = opts.vector
      ? (opts.k ?? defaultSize)
      : (opts.limit ?? defaultSize)

    const req: any = {
      index: table,
      body: {
        size,
        _source: {
          excludes: [this.vectorFieldName()].filter((n) => '' !== n),
        },
        query: queryClause,
      },
    }

    const res = await this.client.search(req)
    return res.body.hits.hits.map((entry: any) => ({
      id: entry._id,
      metadata: entry._source,
      score: entry._score,
    }))
  }

  async remove(table: string, id: string): Promise<void> {
    try {
      await this.client.delete({ index: table, id })
    } catch (err: any) {
      if (err && err.meta && 404 === err.meta.statusCode) return
      throw err
    }
  }

  async removeQuery(table: string, opts: DriverQueryOpts): Promise<void> {
    const queryClause = this.buildQueryClause(opts)
    if (queryClause === null) return

    await this.client.deleteByQuery({
      index: table,
      body: { query: queryClause },
    })
  }

  // Adapted from the original buildQuery in OpensearchStore.ts. Same shape, different inputs:
  // equality filters + optional KNN clause, AND-combined.
  private buildQueryClause(opts: DriverQueryOpts): any {
    const parts: any[] = []

    if (opts.filters) {
      for (const k in opts.filters) {
        parts.push({ match: { [k]: opts.filters[k] } })
      }
    }

    if (opts.vector) {
      const defaultSize = this.opts.cmd?.list?.size ?? 11
      parts.push({
        knn: {
          [this.vectorFieldName()]: {
            vector: opts.vector,
            k: opts.k ?? defaultSize,
          },
        },
      })
    }

    if (parts.length === 0) return null
    if (parts.length === 1) return parts[0]
    return { bool: { must: parts } }
  }

  private vectorFieldName(): string {
    return this.opts.field?.vector?.name ?? 'vector'
  }

  // Backwards-compat accessor used by the plugin's exportmap.native.
  getClient(): any {
    return this.client
  }
}
