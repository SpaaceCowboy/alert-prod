import type { AxiosInstance, AxiosResponse } from 'axios';
import { VendorApi } from './base.js';

export interface B2BrokerBalance { currency: string; balance: string; [key: string]: unknown }
export interface B2BrokerTransaction { id: string; status?: string; [key: string]: unknown }
export interface B2BrokerWithdrawal { currency: string; amount: string; address: string }

export class B2BrokerApi extends VendorApi {
  public constructor(client: AxiosInstance) { super(client); }
  getBalance(currency: string): Promise<AxiosResponse<B2BrokerBalance>> {
    return this.request('b2broker.balance.get', { method: 'GET', url: `/balances/${encodeURIComponent(currency)}` });
  }
  getTransaction(transactionId: string): Promise<AxiosResponse<B2BrokerTransaction>> {
    return this.request('b2broker.transaction.get', { method: 'GET', url: `/transactions/${encodeURIComponent(transactionId)}` });
  }
  createWithdrawal(body: B2BrokerWithdrawal, idempotencyKey?: string): Promise<AxiosResponse<B2BrokerTransaction>> {
    return this.request('b2broker.withdrawal.create', { method: 'POST', url: '/withdrawals', data: body, headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined });
  }
}
