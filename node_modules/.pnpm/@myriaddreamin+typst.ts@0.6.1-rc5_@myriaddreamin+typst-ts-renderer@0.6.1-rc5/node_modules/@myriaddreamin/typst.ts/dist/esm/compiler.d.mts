import type * as typst from '@myriaddreamin/typst-ts-web-compiler';
import { SemanticTokens, SemanticTokensLegend, kObject } from './internal.types.mjs';
import { type InitOptions } from './options.init.mjs';
/**
 * Available formats for compiling the document.
 */
export type CompileFormat = keyof typeof CompileFormatEnum;
/**
 * Available formats for compiling the document.
 */
export declare enum CompileFormatEnum {
    vector = 0,
    pdf = 1,
    _dummy = 2
}
/**
 * The diagnostic message partially following the LSP specification.
 */
interface DiagnosticMessage {
    package: string;
    path: string;
    severity: string;
    range: string;
    message: string;
}
/**
 * Available formats for compiling the document.
 *
 * If set to unix, a diagnostics is in format of
 *
 * ```log
 * // with package
 * cetz:0.2.0@lib.typ:2:9-3:15: error: unexpected type in `+` application
 * // without package
 * main.typ:2:9-3:15: error: unexpected type in `+` application
 * ```
 *
 * If set to long, a diagnostics is in format of {@link DiagnosticMessage}.
 *
 * If set to full, a diagnostics is in format of {@link DiagnosticMessage}, but also with trace messages.
 */
export type DiagnosticsFormat = 'none' | 'unix' | 'full';
export type DiagnosticsData = {
    none: never;
    unix: string;
    full: DiagnosticMessage;
};
interface DiagOpts<D extends DiagnosticsFormat = DiagnosticsFormat> {
    /**
     * Whether to include diagnostic information in the result.
     * Note: it will be set to 'full' by default in v0.6.0
     * @default 'full'
     */
    diagnostics?: D;
}
interface SnapshotOptions {
    /**
     * The path of the main file.
     */
    mainFilePath: string;
    /**
     * The root of the main file.
     */
    root?: string;
    /**
     * Adds a string key-value pair visible through `sys.inputs`
     *
     * Note: pass `{}` to clear `sys.inputs`
     *
     * Note: When passing `undefined`, compiler will use last set `sys.inputs`.
     *
     * Note: This means you should always specify inputs when using compiler for concurrent tasks.
     */
    inputs?: Record<string, string>;
}
interface TransientCompileOptions<F extends CompileFormatEnum = CompileFormatEnum, Diagnostics extends DiagnosticsFormat = DiagnosticsFormat> extends SnapshotOptions, DiagOpts<Diagnostics> {
    /**
     * The format of the artifact.
     * - CompileFormatEnum.vector: can then load to the renderer to render the document.
     * - CompileFormatEnum.pdf: for finally exporting pdf to the user.
     *
     * Hint: you can convert the format from {@link CompileFormat} to
     * {@link CompileFormatEnum} by `CompileFormatEnum[Format]`.
     * @default CompileFormatEnum.vector
     */
    format?: F;
}
interface IncrementalCompileOptions<Diagnostics extends DiagnosticsFormat = DiagnosticsFormat> extends SnapshotOptions, DiagOpts<Diagnostics> {
    /**
     * The format of the incrementally exported artifact.
     * @default 'vector'
     */
    format?: 'vector';
    /**
     * The incremental server for the document.
     */
    incrementalServer: IncrementalServer;
}
export interface QueryOptions {
    /**
     * select part of document for query.
     */
    selector: string;
    /**
     * cast result by accessing single field.
     */
    field?: string;
}
/**
 * The options for compiling the document.
 */
export type CompileOptions<Format extends CompileFormatEnum = CompileFormatEnum, Diagnostics extends DiagnosticsFormat = DiagnosticsFormat> = TransientCompileOptions<Format, Diagnostics> | IncrementalCompileOptions;
export declare class IncrementalServer {
    /**
     * Reset the incremental server to the initial state.
     */
    reset(): void;
    /**
     * Return current result.
     */
    current(): Uint8Array | undefined;
    /**
     * Also attach the debug info to the result.
     */
    setAttachDebugInfo(enable: boolean): void;
}
interface CompileResult<T, D extends DiagnosticsFormat> {
    result?: T;
    diagnostics?: DiagnosticsData[D][];
}
export interface TypstFontInfo {
}
declare enum TypstFontResolverCons {
}
export type TypstFontResolver = TypstFontResolverCons;
export interface TypstFontBuilder {
    /**
     * Initialize the font builder.
     * @param options - The options for initializing the font builder.
     */
    init(options?: Partial<InitOptions>): Promise<void>;
    /**
     * Get the font info.
     *
     * @param font_buffer - The font buffer to get the font info.
     * @returns {TypstFontInfo} - The font info.
     */
    getFontInfo(font_buffer: Uint8Array): Promise<TypstFontInfo>;
    /**
     * Add a raw font.
     *
     * @param font_buffer - The font buffer to add.
     */
    addFontData(font_buffer: Uint8Array): Promise<void>;
    /**
     * Add a lazy font.
     *
     * @param info - The font info, usually from {@link getFontInfo}.
     * @param blob - The blob function to get the font buffer.
     * @param context - The context.
     */
    addLazyFont(info: TypstFontInfo, blob: (idx: number) => Uint8Array, context?: object): Promise<void>;
    /**
     * Build the font resolver. The font resolver will be freed after the callback
     * is invoked and before returning the build function.
     *
     * @param cb - The function to use the font resolver.
     * @returns {Promise<T>} - The result of the function.
     */
    build<T>(cb: (resolver: TypstFontResolver) => Promise<T>): Promise<T>;
}
/**
 * create a Typst font builder.
 * @returns {TypstFontBuilder} - The Typst font builder.
 * @example
 * ```typescript
 * import { createTypstFontBuilder } from 'typst';
 * const fb = createTypstFontBuilder();
 * await fb.init();
 * await fb.addFontData(new Uint8Array(await fetch('font.ttf').then(r => r.arrayBuffer())));
 * await fb.build();
 * ```
 */
export declare function createTypstFontBuilder(): TypstFontBuilder;
export declare class TypstWorld {
    private [kObject];
    constructor(world: typst.TypstCompileWorld);
    /**
     * Compile the paged document.
     *
     * @param {DiagnosticsFormat} format - The format of the diagnostics.
     * @returns {Promise<{ diagnostics?: DiagnosticsData[DiagnosticsFormat][] }>} - The result of the compilation.
     */
    compile<D extends DiagnosticsFormat = 'full'>(opts?: DiagOpts<D>): Promise<CompileResult<undefined, D> & {
        hasError: boolean;
    }>;
    /**
     * Compile the paged document.
     *
     * @param {DiagnosticsFormat} format - The format of the diagnostics.
     * @returns {Promise<{ diagnostics?: DiagnosticsData[DiagnosticsFormat][] }>} - The result of the compilation.
     */
    compileHtml<D extends DiagnosticsFormat = 'full'>(opts?: DiagOpts<D>): Promise<CompileResult<undefined, D> & {
        hasError: boolean;
    }>;
    /**
     * Runs query on the paged document.
     */
    query<T = any>(options: QueryOptions): Promise<T>;
    /**
     * Get the title of the paged document.
     * Throw error if the world didn't compile the paged document.
     *
     * @returns {string | undefined} - The title of the paged document.
     */
    title(): string | undefined;
    /**
     * Export the paged document as vector format.
     *
     * @returns {Uint8Array | undefined} - The title of the paged document.
     */
    vector<D extends DiagnosticsFormat = 'full'>(opts?: DiagOpts<D>): Promise<CompileResult<Uint8Array, D>>;
    /**
     * Export the paged document to PDF.
     *
     * @returns {Uint8Array | undefined} - The title of the paged document.
     */
    pdf<D extends DiagnosticsFormat = 'full'>(opts?: DiagOpts<D>): Promise<CompileResult<Uint8Array, D>>;
}
/**
 * The interface of Typst compiler.
 */
export interface TypstCompiler {
    /**
     * Initialize the typst compiler.
     * @param {Partial<InitOptions>} options - The options for initializing the
     * typst compiler.
     */
    init(options?: Partial<InitOptions>): Promise<void>;
    /**
     * Reset the typst compiler to the initial state.
     * Note: without calling this function, the compiler will always keep caches
     * such as:
     * - loaded fonts
     * - source files corresponding to typst modules
     *
     * Note: this function is independent to the {@link resetShadow} function.
     * This is intended to optimize the performance of the compiler.
     */
    reset(): Promise<void>;
    /**
     * Compile an document with the maintained state.
     * @param {CompileOptions} options - The options for compiling the document.
     * @returns {Promise<Uint8Array>} - artifact in vector format.
     * You can then load the artifact to the renderer to render the document.
     */
    compile<D extends DiagnosticsFormat>(options: CompileOptions<CompileFormatEnum.vector, D>): Promise<CompileResult<Uint8Array, D>>;
    compile<D extends DiagnosticsFormat>(options: CompileOptions<CompileFormatEnum.pdf, D>): Promise<CompileResult<Uint8Array, D>>;
    compile<F extends CompileFormatEnum, D extends DiagnosticsFormat>(options: CompileOptions<F, D>): Promise<CompileResult<Uint8Array, D>>;
    runWithWorld<T>(options: SnapshotOptions, cb: (world: TypstWorld) => Promise<T>): Promise<T>;
    /**
     * Set the fonts to the compiler. Note: multiple compilers can share the same fonts.
     *
     * @param {TypstFontResolver} fonts - The fonts to set.
     */
    setFonts(fonts: TypstFontResolver): void;
    /**
     * experimental
     * Query the result with document
     */
    query<T>(options: QueryOptions & SnapshotOptions): Promise<T>;
    /**
     * Print the AST of the main file.
     * @param {string} mainFilePath - The path of the main file.
     * @returns {Promise<string>} - an string representation of the AST.
     */
    getAst(mainFilePath: string): Promise<string>;
    /**
     * Add a source file to the compiler.
     * @param {string} path - The path of the source file.
     * @param {string} source - The source code of the source file.
     *
     */
    addSource(path: string, source: string): void;
    /**
     * Add a shadow file to the compiler.
     * @param {string} path - The path to the shadow file.
     * @param {Uint8Array} content - The content of the shadow file.
     *
     */
    mapShadow(path: string, content: Uint8Array): void;
    /**
     * Remove a shadow file from the compiler.
     * @param {string} path - The path to the shadow file.
     */
    unmapShadow(path: string): void;
    /**
     * Reset the shadow files.
     * Note: this function is independent to the {@link reset} function.
     */
    resetShadow(): void;
    /**
     * experimental
     * See Semantic tokens: https://github.com/microsoft/vscode/issues/86415
     */
    getSemanticTokenLegend(): Promise<SemanticTokensLegend>;
    /**
     * experimental
     * See Semantic tokens: https://github.com/microsoft/vscode/issues/86415
     *
     * @param {string} opts.mainFilePath - The path of the main file.
     * @param {string} opts.resultId - The id of the result.
     * @param {string} opts.offsetEncoding - The encoding of the offset.
     *   - 'utf-16': the offset is encoded in utf-16.
     *   - 'utf-8': the offset is encoded in utf-8.
     *   @default 'utf-16'
     * @returns {Promise<SemanticTokens>} - The semantic tokens.
     */
    getSemanticTokens(opts: {
        mainFilePath: string;
        resultId?: string;
        offsetEncoding?: string;
    }): Promise<SemanticTokens>;
    /**
     * experimental
     * Run with an incremental server which holds the state of the document in wasm.
     *
     * @param {function(IncrementalServer): Promise<T>} f - The function to run with the incremental server.
     * @returns {Promise<T>} - The result of the function.
     *
     * Note: the incremental server will be freed after the function is finished.
     */
    withIncrementalServer<T>(f: (s: IncrementalServer) => Promise<T>): Promise<T>;
}
/**
 * create a Typst compiler.
 * @returns {TypstCompiler} - The Typst compiler.
 * @example
 * ```typescript
 * import { createTypstCompiler } from 'typst';
 * const compiler = createTypstCompiler();
 * await compiler.init();
 * compiler.addSource('/main.typ', 'Hello, typst!');
 * await compiler.compile({ mainFilePath: '/main.typ' });
 * ```
 */
export declare function createTypstCompiler(): TypstCompiler;
export declare namespace createTypstCompiler {
    var _impl: typeof TypstCompilerDriver;
}
export declare class TypstFontBuilderDriver implements TypstFontBuilder {
    private fontBuilderJs;
    private fontBuilder;
    init(options?: Partial<InitOptions>): Promise<void>;
    getFontInfo(font_buffer: Uint8Array): Promise<TypstFontInfo>;
    addFontData(font_buffer: Uint8Array): Promise<void>;
    addLazyFont<C extends TypstFontInfo>(info: TypstFontInfo, blob: (this: C, idx: number) => Uint8Array): Promise<void>;
    build<T>(cb: (resolver: TypstFontResolver) => Promise<T>): Promise<T>;
}
declare class TypstCompilerDriver implements TypstCompiler {
    compiler: typst.TypstCompiler;
    compilerJs: typeof typst;
    static defaultAssets: "text"[];
    constructor();
    init(options?: Partial<InitOptions>): Promise<void>;
    setFonts(fonts: TypstFontResolver): void;
    compile(options: CompileOptions): Promise<any>;
    runWithWorld<T>(options: SnapshotOptions, cb: (world: TypstWorld) => Promise<T>): Promise<T>;
    query(options: QueryOptions & SnapshotOptions): Promise<any>;
    getSemanticTokenLegend(): Promise<SemanticTokensLegend>;
    getSemanticTokens(opts: {
        mainFilePath: string;
        resultId?: string;
        offsetEncoding?: string;
    }): Promise<SemanticTokens>;
    withIncrementalServer<T>(f: (s: IncrementalServer) => Promise<T>): Promise<T>;
    getAst(mainFilePath: string): Promise<string>;
    reset(): Promise<void>;
    addSource(path: string, source: string): void;
    mapShadow(path: string, content: Uint8Array): void;
    unmapShadow(path: string): void;
    resetShadow(): void;
    renderPageToCanvas(): Promise<any>;
}
export {};
//# sourceMappingURL=compiler.d.mts.map