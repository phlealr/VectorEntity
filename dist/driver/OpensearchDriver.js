"use strict";
/* Copyright (c) 2024 Seneca contributors, MIT License */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpensearchDriver = void 0;
const aws_1 = require("@opensearch-project/opensearch/aws");
const opensearch_1 = require("@opensearch-project/opensearch");
const credential_provider_node_1 = require("@aws-sdk/credential-provider-node");
class OpensearchDriver {
    constructor(opts) {
        this.client = null;
        this.opts = opts;
    }
    async connect() {
        this.client = new opensearch_1.Client({
            ...(0, aws_1.AwsSigv4Signer)({
                region: this.opts.aws.region,
                service: 'aoss',
                getCredentials: () => {
                    const credentialsProvider = (0, credential_provider_node_1.defaultProvider)();
                    return credentialsProvider();
                },
            }),
            node: this.opts.opensearch.node,
        });
    }
    async close() {
        // OpenSearch JS client has no explicit close; nothing to do.
    }
    async upsert(table, id, vector, metadata) {
        const body = { ...metadata };
        if (vector !== undefined) {
            body[this.vectorFieldName()] = vector;
        }
        const req = { index: table, body };
        if (id)
            req.id = id;
        const res = await this.client.index(req);
        return { id: res.body._id };
    }
    async get(table, id) {
        try {
            const res = await this.client.get({ index: table, id });
            return { id: res.body._id, metadata: res.body._source };
        }
        catch (err) {
            if (err && err.meta && 404 === err.meta.statusCode)
                return null;
            throw err;
        }
    }
    async query(table, opts) {
        var _a, _b, _c, _d, _e;
        const queryClause = this.buildQueryClause(opts);
        if (queryClause === null)
            return [];
        const defaultSize = (_c = (_b = (_a = this.opts.cmd) === null || _a === void 0 ? void 0 : _a.list) === null || _b === void 0 ? void 0 : _b.size) !== null && _c !== void 0 ? _c : 11;
        const size = opts.vector
            ? ((_d = opts.k) !== null && _d !== void 0 ? _d : defaultSize)
            : ((_e = opts.limit) !== null && _e !== void 0 ? _e : defaultSize);
        const req = {
            index: table,
            body: {
                size,
                _source: {
                    excludes: [this.vectorFieldName()].filter((n) => '' !== n),
                },
                query: queryClause,
            },
        };
        const res = await this.client.search(req);
        return res.body.hits.hits.map((entry) => ({
            id: entry._id,
            metadata: entry._source,
            score: entry._score,
        }));
    }
    async remove(table, id) {
        try {
            await this.client.delete({ index: table, id });
        }
        catch (err) {
            if (err && err.meta && 404 === err.meta.statusCode)
                return;
            throw err;
        }
    }
    async removeQuery(table, opts) {
        const queryClause = this.buildQueryClause(opts);
        if (queryClause === null)
            return;
        await this.client.deleteByQuery({
            index: table,
            body: { query: queryClause },
        });
    }
    // Adapted from the original buildQuery in OpensearchStore.ts. Same shape, different inputs:
    // equality filters + optional KNN clause, AND-combined.
    buildQueryClause(opts) {
        var _a, _b, _c, _d;
        const parts = [];
        if (opts.filters) {
            for (const k in opts.filters) {
                parts.push({ match: { [k]: opts.filters[k] } });
            }
        }
        if (opts.vector) {
            const defaultSize = (_c = (_b = (_a = this.opts.cmd) === null || _a === void 0 ? void 0 : _a.list) === null || _b === void 0 ? void 0 : _b.size) !== null && _c !== void 0 ? _c : 11;
            parts.push({
                knn: {
                    [this.vectorFieldName()]: {
                        vector: opts.vector,
                        k: (_d = opts.k) !== null && _d !== void 0 ? _d : defaultSize,
                    },
                },
            });
        }
        if (parts.length === 0)
            return null;
        if (parts.length === 1)
            return parts[0];
        return { bool: { must: parts } };
    }
    vectorFieldName() {
        var _a, _b, _c;
        return (_c = (_b = (_a = this.opts.field) === null || _a === void 0 ? void 0 : _a.vector) === null || _b === void 0 ? void 0 : _b.name) !== null && _c !== void 0 ? _c : 'vector';
    }
    // Backwards-compat accessor used by the plugin's exportmap.native.
    getClient() {
        return this.client;
    }
}
exports.OpensearchDriver = OpensearchDriver;
//# sourceMappingURL=OpensearchDriver.js.map