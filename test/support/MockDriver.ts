/* Copyright (c) 2024 Seneca contributors, MIT License */

import { Driver, DriverGetResult, DriverQueryOpts, DriverQueryRow, DriverUpsertResult } from '../../src/driver/Driver'


export type MockCall = { method: string; args: any[] }


// A Driver that records every call and returns caller-configured canned data. Used to
// test the VectorStore plugin's translation layer (Seneca entity API <-> Driver
// interface) without any real database or vendor SDK.
//
// Instances register themselves in MockDriver.instances on construction (the plugin
// builds the driver inside seneca.prepare, so the test grabs MockDriver.last() after
// seneca.ready() to inspect calls / set canned results).
export class MockDriver implements Driver {
  static instances: MockDriver[] = []

  static last(): MockDriver {
    return MockDriver.instances[MockDriver.instances.length - 1]
  }

  static reset(): void {
    MockDriver.instances = []
  }

  calls: MockCall[] = []
  connected = false
  closed = false

  // Canned results — set these on the instance before invoking the entity op.
  upsertResult: DriverUpsertResult | null = null
  getResult: DriverGetResult | null = null
  queryResult: DriverQueryRow[] = []

  constructor(public opts: any) {
    MockDriver.instances.push(this)
  }

  async connect(): Promise<void> {
    this.connected = true
    this.calls.push({ method: 'connect', args: [] })
  }

  async close(): Promise<void> {
    this.closed = true
    this.calls.push({ method: 'close', args: [] })
  }

  async upsert(
    table: string,
    id: string | undefined,
    vector: number[] | undefined,
    metadata: Record<string, any>,
  ): Promise<DriverUpsertResult> {
    this.calls.push({ method: 'upsert', args: [table, id, vector, metadata] })
    return this.upsertResult ?? { id: id ?? 'mock-generated-id' }
  }

  async get(table: string, id: string): Promise<DriverGetResult | null> {
    this.calls.push({ method: 'get', args: [table, id] })
    return this.getResult
  }

  async query(table: string, opts: DriverQueryOpts): Promise<DriverQueryRow[]> {
    this.calls.push({ method: 'query', args: [table, opts] })
    return this.queryResult
  }

  async remove(table: string, id: string): Promise<void> {
    this.calls.push({ method: 'remove', args: [table, id] })
  }

  async removeQuery(table: string, opts: DriverQueryOpts): Promise<void> {
    this.calls.push({ method: 'removeQuery', args: [table, opts] })
  }

  // --- inspection helpers ---

  callsOf(method: string): MockCall[] {
    return this.calls.filter((c) => c.method === method)
  }

  lastCall(method: string): MockCall | undefined {
    const matching = this.callsOf(method)
    return matching[matching.length - 1]
  }
}


// Variant without remove/removeQuery — used to test the plugin's "driver does not
// support remove" error path.
export class MockDriverNoRemove implements Driver {
  static instances: MockDriverNoRemove[] = []
  static last(): MockDriverNoRemove {
    return MockDriverNoRemove.instances[MockDriverNoRemove.instances.length - 1]
  }
  static reset(): void {
    MockDriverNoRemove.instances = []
  }

  calls: MockCall[] = []

  constructor(public opts: any) {
    MockDriverNoRemove.instances.push(this)
  }
  async connect(): Promise<void> { this.calls.push({ method: 'connect', args: [] }) }
  async close(): Promise<void> { this.calls.push({ method: 'close', args: [] }) }
  async upsert(): Promise<DriverUpsertResult> { return { id: 'x' } }
  async get(): Promise<DriverGetResult | null> { return null }
  async query(): Promise<DriverQueryRow[]> { return [] }
  // intentionally no remove / removeQuery
}
