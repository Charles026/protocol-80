import { LazyFont } from './options.init.mjs';
/**
 * Loads a font by a lazy font synchronously, which is required by the compiler.
 * @param font
 */
export declare function loadFontSync(font: LazyFont & {
    url: string;
}): (index: number) => Uint8Array;
//# sourceMappingURL=init.d.mts.map