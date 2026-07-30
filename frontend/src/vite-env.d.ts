/// <reference types="vite/client" />

// Vite emits these as asset URLs / worker constructors; it does not ship types
// for arbitrary query suffixes.
declare module '*.wasm?url' {
  const url: string
  export default url
}

declare module '*?worker' {
  const WorkerConstructor: new () => Worker
  export default WorkerConstructor
}
