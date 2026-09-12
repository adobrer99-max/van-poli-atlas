// Loads the browser-targeted src files into one context for Node testing.
// Top-level `const` in a <script> is a lexical binding, so the exported names
// are copied onto the context explicitly after the sources run.
const fs = require('fs'), path = require('path'), vm = require('vm');
const dir = path.join(__dirname, '..', 'src');
function load(files, names) {
  const ctx = vm.createContext({
    console, TextDecoder, TextEncoder, DecompressionStream, Response, ReadableStream, Blob,
    Uint8Array, Uint16Array, Uint32Array, Int32Array, Float32Array, Float64Array, DataView,
    Math, JSON, Map, Set, Date, Promise, Array, Object, String, Number, RegExp, Error,
    isFinite, isNaN, parseFloat, parseInt, globalThis: undefined,
  });
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  }
  const exported = {};
  for (const n of names) exported[n] = vm.runInContext(n, ctx);
  return exported;
}
module.exports = { load };
