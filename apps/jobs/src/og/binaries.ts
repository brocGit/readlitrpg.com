// The Worker's copy of the renderer: wrangler bundles the WebAssembly module and the TTF files
// (see "rules" in wrangler.jsonc). Imported lazily, only by the og job.

import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import sans from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf";
import sansBold from "dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf";
import mono from "dejavu-fonts-ttf/ttf/DejaVuSansMono.ttf";
import { createRasterizer } from "./rasterizer";

export const workerRasterizer = () =>
  createRasterizer(resvgWasm, [new Uint8Array(sans), new Uint8Array(sansBold), new Uint8Array(mono)]);
