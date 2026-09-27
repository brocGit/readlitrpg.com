// Test-only: an in-memory R2Bucket with the subset of the API our code uses.

export class TestR2 {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string; cacheControl?: string }>();

  async put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string; cacheControl?: string } },
  ) {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : new Uint8Array(value instanceof ArrayBuffer ? value : value.slice());
    this.objects.set(key, { bytes, ...options?.httpMetadata });
    return { key };
  }

  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return {
      key,
      size: o.bytes.length,
      httpMetadata: { contentType: o.contentType, cacheControl: o.cacheControl },
      body: new Blob([new Uint8Array(o.bytes)]).stream(),
      arrayBuffer: async () => o.bytes.slice().buffer,
      text: async () => new TextDecoder().decode(o.bytes),
      writeHttpMetadata: (headers: Headers) => {
        if (o.contentType) headers.set("content-type", o.contentType);
        if (o.cacheControl) headers.set("cache-control", o.cacheControl);
      },
    };
  }

  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { key, size: o.bytes.length } : null;
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  asR2(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}
