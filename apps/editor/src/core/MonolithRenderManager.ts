import { Mutex } from 'async-mutex';
import { createTypstRenderer, TypstRenderer } from '@myriaddreamin/typst.ts/renderer';
import { EDITOR_CONFIG } from '../config/editor';

/**
 * MonolithRenderManager (Singleton)
 * 
 * Manages access to the WASM renderer to prevent ownership errors and race conditions.
 * Implements a Singleton pattern to ensure WASM memory is initialized exactly once,
 * safely handling React Strict Mode double-mounts.
 */
export class MonolithRenderManager {
    // 1. Static Instance holder
    private static instance: MonolithRenderManager | null = null;

    private mutex = new Mutex();
    private renderer: TypstRenderer | null = null;

    // State flags
    private isReady = false;
    private isInitializing = false;

    // LIFO State
    private pendingArtifact: Uint8Array | null = null;
    private isRenderPending = false;

    // 2. Private Constructor to prevent 'new' calls
    private constructor() { }

    // 3. Global Access Point
    public static getInstance(): MonolithRenderManager {
        if (!MonolithRenderManager.instance) {
            MonolithRenderManager.instance = new MonolithRenderManager();
        }
        return MonolithRenderManager.instance;
    }

    /**
     * Idempotent Initialization.
     * Safe to call from React useEffect multiple times.
     * Only the first call triggers the WASM load.
     */
    public async init() {
        // Fast exit if already ready
        if (this.isReady) return;

        // Prevent race condition if multiple components call init() simultaneously
        if (this.isInitializing) return;
        this.isInitializing = true;

        try {
            console.log('[Monolith Kernel] Initializing Singleton WASM...');

            const renderer = createTypstRenderer();
            await renderer.init({
                getModule: () => ({
                    module_or_path: new URL(
                        '@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm',
                        import.meta.url
                    ).href
                } as any)
            });

            this.renderer = renderer;
            this.isReady = true;
            console.log('[Monolith Kernel] WASM Ready.');
        } catch (error) {
            console.error('[Monolith Kernel] FATAL: Init failed', error);
            this.isInitializing = false; // Reset on failure to allow retry
            throw error;
        }
    }

    /**
     * Schedules a render safely using the artifact from the Worker.
     */
    public async scheduleRender(
        artifact: Uint8Array,
        container: HTMLDivElement
    ) {
        if (!this.isReady || !this.renderer) {
            console.warn('[Monolith Kernel] Render skipped: Renderer not ready');
            return;
        }

        // 1. Update the "latest" state (LIFO: overwrite previous pending)
        this.pendingArtifact = artifact;

        // 2. If a render is already queued behind the current lock, don't spawn another queue item.
        if (this.isRenderPending) return;

        this.isRenderPending = true;

        // 3. Acquire Lock (Wait for current render to finish)
        await this.mutex.runExclusive(async () => {
            // Once we have the lock, check if we still have work to do
            while (this.pendingArtifact !== null) {
                const artifactToRender = this.pendingArtifact;
                this.pendingArtifact = null; // Clear pending, we are handling it now

                try {
                    if (container.hasChildNodes()) {
                        container.innerHTML = '';
                    }

                    await this.renderer!.renderToCanvas({
                        container,
                        artifactContent: artifactToRender,
                        format: 'vector',
                        pixelPerPt: EDITOR_CONFIG.PIXEL_PER_PT,
                        backgroundColor: '#ffffff',
                    });

                } catch (error: any) {
                    console.error('[Monolith Kernel] Render Error:', error);
                    // Critical recovery check could go here
                }
            }

            // Queue is empty
            this.isRenderPending = false;
        });
    }
}
