import { Driver } from './driver/Driver';
export declare enum DriverName {
    Opensearch = "opensearch"
}
type Options = {
    debug: boolean;
    driver: DriverName | `${DriverName}`;
    map?: any;
    canon?: any;
    table: {
        prefix: string;
        suffix: string;
        map: Record<string, string>;
        exact: string;
    };
    index?: {
        prefix?: string;
        suffix?: string;
        map?: Record<string, string>;
        exact?: string;
    };
    field: {
        zone: {
            name: string;
        };
        base: {
            name: string;
        };
        name: {
            name: string;
        };
        vector: {
            name: string;
        };
    };
    cmd: {
        list: {
            size: number;
        };
    };
    opensearch: any;
    aws: any;
    pg: any;
};
export type VectorStoreOptions = Partial<Options>;
declare function VectorStore(this: any, options: Options): {
    name: string;
    tag: any;
    exportmap: {
        native: () => {
            driver: Driver | null;
        };
    };
};
export default VectorStore;
