export interface DriverQueryOpts {
    vector?: number[];
    k?: number;
    filters?: Record<string, any>;
    limit?: number;
}
export interface DriverQueryRow {
    id: string;
    metadata: Record<string, any>;
    score?: number;
}
export interface DriverUpsertResult {
    id: string;
}
export interface DriverGetResult {
    id: string;
    metadata: Record<string, any>;
}
export interface Driver {
    connect(): Promise<void>;
    close(): Promise<void>;
    upsert(table: string, id: string | undefined, vector: number[] | undefined, metadata: Record<string, any>): Promise<DriverUpsertResult>;
    get(table: string, id: string): Promise<DriverGetResult | null>;
    query(table: string, opts: DriverQueryOpts): Promise<DriverQueryRow[]>;
    remove?(table: string, id: string): Promise<void>;
    removeQuery?(table: string, opts: DriverQueryOpts): Promise<void>;
}
