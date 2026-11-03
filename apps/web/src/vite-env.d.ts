/// <reference types="vite/client" />

// hls.js's "light" build has the same API as the full one but ships no type
// declarations of its own, so borrow the full build's.
declare module "hls.js/light" {
  export * from "hls.js";
  export { default } from "hls.js";
}
