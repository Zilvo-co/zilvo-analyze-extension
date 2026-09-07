// Pulls the Chrome extension APIs (`chrome.*`) into the global scope for every
// file in the project. Without this the types are only picked up implicitly
// from node_modules/@types, which editors silently skip when they fall back to
// an inferred project — producing "Cannot find name 'chrome'" in the IDE while
// `tsc --noEmit` still passes.
/// <reference types="chrome" />
