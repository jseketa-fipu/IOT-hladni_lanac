/** true in `npm run dev`, false in the GitHub Pages build (esbuild define). */
declare const __DEV__: boolean;

/** Bumped by the dev server whenever project/ or public/ change (see scripts/build.mjs). */
declare module 'virtual:static-version' {
  const version: number;
  export default version;
}
