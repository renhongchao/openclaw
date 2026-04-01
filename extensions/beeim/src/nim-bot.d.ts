/**
 * Ambient type declaration for @yxim/nim-bot.
 * The package ships without TypeScript types; this shim satisfies the compiler.
 * All SDK service objects are typed as `any` intentionally.
 */
declare module "@yxim/nim-bot" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const NIM: new (...args: any[]) => any;
  export default NIM;
}
