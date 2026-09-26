// Test-only: an in-memory KVNamespace with the subset of the API our code uses.

export class TestKV {
  readonly store = new Map<string, string>();
  gets = 0;

  async get(key: string, options?: { type?: string } | string): Promise<unknown> {
    this.gets++;
    const value = this.store.get(key);
    if (value === undefined) return null;
    const type = typeof options === "string" ? options : options?.type;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  asKV(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}
