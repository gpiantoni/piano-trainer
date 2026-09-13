// verovio ships no type declarations. Only what the app calls is declared here;
// add methods as later phases need them (renderToTimemap, getMIDIValuesForElement…).

declare module 'verovio/wasm' {
  const createVerovioModule: () => Promise<unknown>;
  export default createVerovioModule;
}

declare module 'verovio/esm' {
  export class VerovioToolkit {
    constructor(module: unknown);
    getVersion(): string;
    setOptions(options: Record<string, unknown>): void;
    loadData(data: string): boolean;
    getPageCount(): number;
    redoLayout(options?: Record<string, unknown>): void;
    renderToSVG(pageNo?: number, xmlDeclaration?: boolean): string;
    getLog(): string;
  }
}
