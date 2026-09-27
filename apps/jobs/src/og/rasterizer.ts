// SVG → PNG for link previews (DESIGN §7.10). resvg compiled to WebAssembly, with fonts we ship:
// Workers have no system fonts. Kept free of binary imports so tests can run it under Node.

import { initWasm, Resvg } from "@resvg/resvg-wasm";

export type Rasterizer = (svg: string) => Promise<Uint8Array>;

let ready: Promise<void> | null = null;

export function createRasterizer(wasm: WebAssembly.Module | BufferSource, fonts: Uint8Array[]): Rasterizer {
  return async (svg) => {
    ready ??= initWasm(wasm).catch((error: unknown) => {
      // initWasm may only run once per isolate; a second call means it already has.
      if (!String(error).includes("Already initialized")) {
        ready = null;
        throw error;
      }
    });
    await ready;
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: 1200 },
      font: {
        fontBuffers: fonts,
        loadSystemFonts: false,
        defaultFontFamily: "DejaVu Sans",
        sansSerifFamily: "DejaVu Sans",
        monospaceFamily: "DejaVu Sans Mono",
      },
    });
    try {
      return resvg.render().asPng();
    } finally {
      resvg.free();
    }
  };
}
