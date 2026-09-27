// Test-only: an in-memory KVNamespace with the subset of the API our code uses.

export class TestKV {
  readonly store = new Map<string, string | ArrayBuffer>();
  gets = 0;

  async get(key: string, options?: { type?: string } | string): Promise<unknown> {
    this.gets++;
    const value = this.store.get(key);
    if (value === undefined) return null;
    const type = typeof options === "string" ? options : options?.type;
    if (type === "arrayBuffer")
      return value instanceof ArrayBuffer ? value.slice(0) : new TextEncoder().encode(value).buffer;
    const text = value instanceof ArrayBuffer ? new TextDecoder().decode(value) : value;
    return type === "json" ? JSON.parse(text) : text;
  }

  async put(key: string, value: string | ArrayBuffer): Promise<void> {
    this.store.set(key, value instanceof ArrayBuffer ? value.slice(0) : value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  asKV(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}
