![Seneca](http://senecajs.org/files/assets/seneca-logo.png)
> A [Seneca.js][] data storage plugin.

# @seneca/vector-store
[![npm version][npm-badge]][npm-url]
[![Build](https://github.com/senecajs/VectorEntity/actions/workflows/build.yml/badge.svg)](https://github.com/senecajs/VectorEntity/actions/workflows/build.yml)
[![Dependency Status][david-badge]][david-url]
[![Maintainability](https://api.codeclimate.com/v1/badges/e2cdcc5415161cb378b0/maintainability)](https://codeclimate.com/github/senecajs/VectorEntity/maintainability)
[![DeepScan grade](https://deepscan.io/api/teams/5016/projects/17225/branches/388415/badge/grade.svg)](https://deepscan.io/dashboard#view=project&tid=5016&pid=17225&bid=388415)
[![Coveralls][BadgeCoveralls]][Coveralls]



| ![Voxgig](https://www.voxgig.com/res/img/vgt01r.png) | This open source module is sponsored and supported by [Voxgig](https://www.voxgig.com). |
|---|---|


## Description

This module is a plugin for the Seneca framework. It provides a
*vector* storage engine that hides a vector database behind the standard
set of data storage action patterns. Application code looks the same
regardless of which vector database sits behind it — exactly the same
`save$` / `load$` / `list$` / `remove$` calls work whether the backend is
OpenSearch or pgvector.

The Seneca framework provides an [ActiveRecord-style data storage API][].
Normally each supported database is its own plugin (`seneca-postgres-store`,
`seneca-mongo-store`, ...) and the backend is implicit in the plugin name.
This plugin inverts that: it is a single plugin, and the caller selects the
backend with a `driver: '<name>'` option. Vendor-specific concerns (indexes
/ tables, query DSL, score format) live in a swappable **Driver**.

Adding support for a new vector database (Qdrant, Pinecone, Weaviate, ...)
is a new Driver file plus one line in the registry — not a fork.

This plugin builds on the [seneca-entity][seneca-entity-url] plugin, which
provides the entity API.

If you're using this module, and need help, you can:

- Post a [github issue][],
- Tweet to [@senecajs][],
- Ask on the [Gitter][gitter-url].

If you are new to Seneca in general, please take a look at [senecajs.org][]. We have everything from
tutorials to sample apps to help get you up and running quickly.


## Code examples

For code samples, please see the [tests][VectorStore-tests] for this plugin.

### Seneca compatibility
Supports Seneca versions **3.x** and above.

### Drivers

| Driver | Backend | Config namespace |
|--------|---------|------------------|
| `opensearch` | AWS OpenSearch Serverless | `opensearch: { node }`, `aws: { region }` |
| `pgvector` | pgvector on Postgres | `pg: { url }` |

The `driver` option is **required** and must name a registered driver.
Driver-specific configuration lives under a key matching the driver name.

## Install

```sh
npm install seneca
npm install @seneca/vector-store
```

You'll need the [seneca](http://github.com/senecajs/seneca) toolkit to use this module - it's just a plugin.

## Quick Example

```js
const Seneca = require('seneca')

const seneca = Seneca()
  .use('promisify')
  .use('entity')
  .use('@seneca/vector-store', {
    driver: 'pgvector',
    pg: { url: 'postgres://postgres:postgres@localhost:5432/postgres' },
    canon: { 'doc/chunk': { vector: { dim: 1536 } } },
  })

await seneca.ready()

// Store an embedding.
const chunk = await seneca.entity('doc/chunk')
  .make$()
  .data$({
    text: 'hello world',
    vector: [/* 1536 floats */],
  })
  .save$()

// Find the nearest neighbours.
const hits = await seneca.entity('doc/chunk').list$({
  directive$: { vector$: { k: 5 } },
  vector: [/* 1536 floats */],
})
// each hit carries a similarity score on custom$.score
```

## Usage

You use this module through the standard Seneca entity API. The only
vector-specific additions are the `vector` field on save and the
`directive$: { vector$: ... }` qualifier on similarity queries:

```js
const entity = seneca.entity('doc/chunk')

// save: include a `vector` field (the embedding)
entity.make$().data$({ text: '...', vector: [...] }).save$()

// load by id (the embedding is NOT returned)
entity.load$(id)

// similarity search (k nearest neighbours)
entity.list$({ directive$: { vector$: { k: 5 } }, vector: [...] })

// equality filter (no vector)
entity.list$({ code: 'abc' })

// remove by id
entity.remove$(id)
```

The vector field name is `vector`. The embedding is stored alongside the
other fields but is never returned by `load$`/`list$` (only the metadata
and, for similarity queries, the score).

### Query Support

A subset of the Seneca query format is supported, plus vector similarity:

- `.list$({f1:v1, f2:v2, ...})` — equality filter, `f1==v1 AND f2==v2, ...`.

- `.list$({ directive$: { vector$: true }, vector: [...] })` — k nearest
  neighbours; `k` defaults to `options.cmd.list.size` (11).

- `.list$({ directive$: { vector$: { k: N } }, vector: [...] })` — k nearest
  neighbours, returning `N` results.

- `.list$({ f1:v1, directive$: { vector$: { k: N } }, vector: [...] })` —
  similarity **combined** with an equality filter (AND).

- `.list$({ f1:v1 }, { size$: N })` — equality filter limited to `N` results.

Similarity results carry the score on `custom$.score`. For pgvector this is
`1 - cosine_distance` (1.0 = identical), in the range `[0, 1]` for normalized
embeddings.

Per-canon vector dimensions are declared in the plugin options under `canon`,
e.g. `canon: { 'doc/chunk': { vector: { dim: 1536 } } }`. A save whose vector
length does not match the declared dimension is rejected.

#### Out of scope

Operator filters (`gt$`, `lt$`, `in$`), `sort$` / `skip$` / `fields$`, the
`native$` escape hatch, and non-cosine metrics are not supported.

### Driver setup

#### pgvector

The plugin does not manage schema. Create the table once (the [pgvector][]
extension must be available):

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE doc_chunk (
  id text PRIMARY KEY,
  embedding vector(1536) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX doc_chunk_emb_idx
  ON doc_chunk USING hnsw (embedding vector_cosine_ops);
```

Everything except `id` and the embedding is stored in `metadata` (jsonb).
The canon → table mapping follows the same rules as `resolveTable`
(`table.exact` > `table.map['-/zone/base/name']` > `prefix + canon + suffix`).
Equality filters are text-typed (`metadata->>'key' = ...`), so filtering on
values stored as JSON numbers will not match — store filterable fields as
strings.

#### opensearch

```js
seneca.use('@seneca/vector-store', {
  driver: 'opensearch',
  opensearch: { node: process.env.OPENSEARCH_NODE },
  aws: { region: 'us-east-1' },
  index: { exact: 'my-index' },
})
```

Uses `AwsSigv4Signer` with the `aoss` service; AWS credentials come from the
default provider chain.

### Driver differences

Drivers are not identical:

| Behaviour | opensearch | pgvector |
|-----------|-----------|----------|
| Save without `vector` | accepted (no embedding written) | rejected |
| `load$` returns the embedding | no (excluded from `_source`) | no |
| `remove$` (by id and `all$`) | yes | yes |
| KNN score | OpenSearch `_score` | `1 - cosine_distance` ∈ [0, 1] |

### Native Driver

The active driver is available via the plugin export:

```js
const { driver } = seneca.export('VectorStore/native')
```

## Contributing
The [Senecajs org][] encourages open participation. If you feel you can help in any way, be it with
documentation, examples, extra testing, or new features please get in touch.

## Test

A local Postgres with pgvector is provided via Docker Compose for the
pgvector driver tests:

```sh
docker compose up -d
export SENECA_VECTOR_PG_URL=postgres://postgres:postgres@localhost:5432/postgres
npm test
```

The translation-layer tests (mock driver) run without any backend. The
pgvector integration tests skip unless `SENECA_VECTOR_PG_URL` is set; the
OpenSearch tests skip unless `SENECA_OPENSEARCH_TEST_NODE` /
`SENECA_OPENSEARCH_TEST_INDEX` are set.

## License
Copyright (c) 2024 Richard Rodger and other contributors.
Licensed under [MIT][].

[MIT]: ./LICENSE
[npm-badge]: https://badge.fury.io/js/@seneca%2Fvector-store.svg
[npm-url]: https://badge.fury.io/js/@seneca/vector-store
[Senecajs org]: https://github.com/senecajs/
[Seneca.js]: https://www.npmjs.com/package/seneca
[@senecajs]: http://twitter.com/senecajs
[senecajs.org]: http://senecajs.org/
[gitter-badge]: https://badges.gitter.im/Join%20Chat.svg
[gitter-url]: https://gitter.im/senecajs/seneca
[github issue]: https://github.com/senecajs/VectorEntity/issues
[ActiveRecord-style data storage API]:http://senecajs.org/tutorials/understanding-data-entities.html
[david-badge]: https://david-dm.org/senecajs/VectorEntity.svg
[david-url]: https://david-dm.org/senecajs/VectorEntity
[Coveralls]: https://coveralls.io/github/senecajs/VectorEntity?branch=main
[BadgeCoveralls]: https://coveralls.io/repos/github/senecajs/VectorEntity/badge.svg?branch=main
[seneca-entity-url]: https://github.com/senecajs/seneca-entity
[VectorStore-tests]: https://github.com/senecajs/VectorEntity/tree/main/test
[pgvector]: https://github.com/pgvector/pgvector
