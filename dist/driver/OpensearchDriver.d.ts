import { Driver, DriverGetResult, DriverQueryOpts, DriverQueryRow, DriverUpsertResult } from './Driver';
export type OpensearchDriverOptions = {
    opensearch: {
        node: string;
    };
    aws: {
        region: string;
    };
    field?: {
        vector?: {
            name?: string;
        };
    };
    cmd?: {
        list?: {
            size?: number;
        };
    };
};
export declare class OpensearchDriver implements Driver {
    private opts;
    private client;
    constructor(opts: OpensearchDriverOptions);
    connect(): Promise<void>;
    close(): Promise<void>;
    upsert(table: string, id: string | undefined, vector: number[] | undefined, metadata: Record<string, any>): Promise<DriverUpsertResult>;
    get(table: string, id: string): Promise<DriverGetResult | null>;
    query(table: string, opts: DriverQueryOpts): Promise<DriverQueryRow[]>;
    remove(table: string, id: string): Promise<void>;
    removeQuery(table: string, opts: DriverQueryOpts): Promise<void>;
    private buildQueryClause;
    private vectorFieldName;
    getClient(): any;
}
