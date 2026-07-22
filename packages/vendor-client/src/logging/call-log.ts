import { Pool, type QueryResult } from 'pg';
import type { VendorCallRecord} from '../types.js';

export interface Querable {
    query(text: string, values: readonly unknown[]): Promise<QueryResult>;
}

let defaultPool: Pool | undefined;

const getDefaultPool = (): Pool => {
    if (!defaultPool) {
        
    }
}