/// <reference types="vite/client" />

/**
 * The Vite that built this bundle, injected by `define` in `vite.config.ts`. The
 * Performance panel shows it in the runtime line; a test runner that does not go
 * through that config sees it as `undefined`, so reads go through a `typeof`
 * check rather than assuming it exists.
 */
declare const __ACSA_VITE_VERSION__: string;
