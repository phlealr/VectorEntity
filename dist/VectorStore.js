"use strict";
/* Copyright (c) 2024 Seneca contributors, MIT License */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DriverName = void 0;
const gubu_1 = require("gubu");
const OpensearchDriver_1 = require("./driver/OpensearchDriver");
const { Open, Any } = gubu_1.Gubu;
// Catalogue of known drivers. Each driver chips in one entry here and one entry in the
// `drivers` registry below. TypeScript narrows `options.driver` to these names.
var DriverName;
(function (DriverName) {
    DriverName["Opensearch"] = "opensearch";
    // Pgvector = 'pgvector',  // arrives in PR2
})(DriverName || (exports.DriverName = DriverName = {}));
// Driver registry. Adding a new driver = a new file under src/driver/ + one line here
// + one entry in the `DriverName` enum above. The `Record<DriverName, ...>` shape forces
// the three to stay in sync — TypeScript errors if any enum value lacks a registry entry.
const drivers = {
    [DriverName.Opensearch]: OpensearchDriver_1.OpensearchDriver,
};
function VectorStore(options) {
    const seneca = this;
    // Synchronous validation — throws cleanly during seneca.use() before any
    // prepare hook is queued. Avoids seneca's fatal-error watchdog (which fires
    // process.exit on errors thrown from seneca.prepare).
    const DriverClass = checkDriverChoice(options.driver);
    const init = seneca.export('entity/init');
    let desc = 'VectorStore';
    let driver = null;
    const store = {
        name: 'VectorStore',
        save: function (msg, reply) {
            const ent = msg.ent;
            const canon = ent.canon$({ object: true });
            const table = resolveTable(ent, options);
            const data = ent.data$(false);
            const id = data.id;
            const vector = data.vector;
            const metadata = { ...data };
            delete metadata.id;
            delete metadata.vector;
            // Inject canon-derived fields per options.field config. No-op when field.{n}.name is ''.
            const fieldOpts = options.field || {};
            ['zone', 'base', 'name'].forEach((n) => {
                if (fieldOpts[n] &&
                    '' !== fieldOpts[n].name &&
                    null != canon[n] &&
                    '' !== canon[n]) {
                    metadata[fieldOpts[n].name] = canon[n];
                }
            });
            driver
                .upsert(table, id, vector, metadata)
                .then((res) => {
                ent.id = res.id;
                reply(ent);
            })
                .catch((err) => reply(err));
        },
        load: function (msg, reply) {
            const ent = msg.ent;
            const table = resolveTable(ent, options);
            const q = msg.q || {};
            if (null != q.id) {
                driver
                    .get(table, q.id)
                    .then((row) => {
                    if (row === null)
                        return reply(null);
                    ent.data$(row.metadata);
                    ent.id = row.id;
                    reply(ent);
                })
                    .catch((err) => reply(err));
            }
            else {
                reply();
            }
        },
        list: function (msg, reply) {
            const ent = msg.ent;
            const table = resolveTable(ent, options);
            const q = msg.q || {};
            const queryOpts = buildDriverQueryOpts(q, msg, options);
            driver
                .query(table, queryOpts)
                .then((rows) => {
                const list = rows.map((row) => {
                    const item = ent.make$().data$(row.metadata);
                    item.id = row.id;
                    if (row.score != null)
                        item.custom$ = { score: row.score };
                    return item;
                });
                reply(list);
            })
                .catch((err) => reply(err));
        },
        remove: function (msg, reply) {
            const ent = msg.ent;
            const table = resolveTable(ent, options);
            const q = msg.q || {};
            const id = q.id;
            if (null != id) {
                if (!driver.remove) {
                    return reply(new Error(`VectorStore: driver '${options.driver}' does not support remove`));
                }
                driver
                    .remove(table, id)
                    .then(() => reply(null))
                    .catch((err) => {
                    if (err && err.meta && 404 === err.meta.statusCode) {
                        return reply(null);
                    }
                    reply(err);
                });
            }
            else if (true === q.all$) {
                if (!driver.removeQuery) {
                    return reply(new Error(`VectorStore: driver '${options.driver}' does not support removeQuery`));
                }
                const queryOpts = buildDriverQueryOpts(q, msg, options);
                driver
                    .removeQuery(table, queryOpts)
                    .then(() => reply(null))
                    .catch((err) => reply(err));
            }
            else {
                reply(null);
            }
        },
        close: function (_msg, reply) {
            this.log.debug('close', desc);
            if (driver) {
                driver
                    .close()
                    .then(() => reply())
                    .catch(reply);
            }
            else {
                reply();
            }
        },
        // Legacy native accessor — surfaces the driver (and, by extension, the underlying client).
        native: function (_msg, reply) {
            reply(null, { driver });
        },
    };
    const meta = init(seneca, options, store);
    desc = meta.desc;
    seneca.prepare(async function () {
        const driverOpts = buildDriverOpts(options);
        driver = new DriverClass(driverOpts);
        await driver.connect();
    });
    return {
        name: store.name,
        tag: meta.tag,
        exportmap: {
            native: () => ({ driver }),
        },
    };
}
// Validate the chosen driver name and return its constructor. Accepts any string
// (callers from plain JS can bypass the DriverName enum). Throws synchronously with a
// clear message. Exposed via utils for direct test access.
function checkDriverChoice(name) {
    if (!name || '' === name) {
        throw new Error('VectorStore: options.driver is required');
    }
    if (!(name in drivers)) {
        throw new Error(`VectorStore: unknown driver '${name}'. Available: ${Object.keys(drivers).join(', ')}`);
    }
    return drivers[name];
}
function buildDriverOpts(options) {
    switch (options.driver) {
        case DriverName.Opensearch:
            return {
                opensearch: options.opensearch,
                aws: options.aws,
                field: options.field,
                cmd: options.cmd,
            };
        // case DriverName.Pgvector:  // PR2
        //   return { pg: options.pg, canon: options.canon }
        default:
            return options;
    }
}
function buildDriverQueryOpts(q, msg, options) {
    var _a;
    const filters = {};
    for (const k in q) {
        if (k !== 'vector' && !k.match(/\$/)) {
            filters[k] = q[k];
        }
    }
    const vectorDirective = msg.vector$ || ((_a = q.directive$) === null || _a === void 0 ? void 0 : _a.vector$);
    const out = {
        limit: msg.size$ || options.cmd.list.size,
    };
    if (Object.keys(filters).length > 0) {
        out.filters = filters;
    }
    if (vectorDirective && q.vector) {
        out.vector = q.vector;
        const kFromDirective = typeof vectorDirective === 'object' && vectorDirective !== null
            ? vectorDirective.k
            : undefined;
        out.k = kFromDirective !== null && kFromDirective !== void 0 ? kFromDirective : options.cmd.list.size;
    }
    return out;
}
// Renamed from resolveIndex. Reads options.table; falls back to options.index for backward-compat.
function resolveTable(ent, options) {
    const tableOpts = options.table || {};
    const indexOpts = options.index || {};
    if ('' !== tableOpts.exact && null != tableOpts.exact)
        return tableOpts.exact;
    if ('' !== indexOpts.exact && null != indexOpts.exact)
        return indexOpts.exact;
    const canonstr = ent.canon$({ string: true });
    const combinedMap = {
        ...(indexOpts.map || {}),
        ...(tableOpts.map || {}),
    };
    if ('' !== combinedMap[canonstr] && null != combinedMap[canonstr]) {
        return combinedMap[canonstr];
    }
    let prefix = tableOpts.prefix || indexOpts.prefix || '';
    let suffix = tableOpts.suffix || indexOpts.suffix || '';
    prefix = '' === prefix || null == prefix ? '' : prefix + '_';
    suffix = '' === suffix || null == suffix ? '' : '_' + suffix;
    const infix = ent
        .canon$({ string: true })
        .replace(/-\//g, '')
        .replace(/\//g, '_');
    return prefix + infix + suffix;
}
// Defaults: Gubu schema. `Any()` / `Open(...)` are Gubu helpers; runtime values are validated against them.
const defaults = {
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
};
Object.assign(VectorStore, {
    defaults,
    utils: { resolveTable, checkDriverChoice, drivers },
    DriverName,
});
exports.default = VectorStore;
if ('undefined' !== typeof module) {
    // CommonJS interop: callers can do either:
    //   const VectorStore = require('@seneca/vector-store')        // -> the function (DriverName attached as static)
    //   const { DriverName } = require('@seneca/vector-store')     // -> enum directly
    // Reassigning module.exports clobbers the auto-generated exports.DriverName from the
    // `export enum` declaration, so we re-attach it manually.
    module.exports = VectorStore;
    module.exports.DriverName = DriverName;
}
//# sourceMappingURL=VectorStore.js.map