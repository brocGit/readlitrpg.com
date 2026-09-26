// Entry module. Workers treat every named export here as an entrypoint, so helpers live in
// worker.ts and only the handler object is exported.
export { default } from "./worker";
