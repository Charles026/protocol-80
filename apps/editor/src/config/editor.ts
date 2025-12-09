/**
 * Editor Configuration - Central source of truth for all magic numbers
 * 
 * This file establishes the "single source of truth" for editor constants,
 * eliminating scattered magic numbers and enabling easy tuning.
 */

export const EDITOR_CONFIG = {
    // ============================================================================
    // Layout & Rendering
    // ============================================================================

    /** Resolution multiplier: pixels per typographic point */
    PIXEL_PER_PT: 3.0,

    /** Default display scale factor (1.0 = 100%) */
    DEFAULT_SCALE: 1.0,

    /** Canvas container padding in pixels */
    CANVAS_PADDING: 20,

    /** Default cursor height in typographic points */
    CURSOR_HEIGHT_PT: 12,

    // ============================================================================
    // Timing & Safety
    // ============================================================================

    /** Input debounce delay in milliseconds (100ms balances responsiveness and WASM stability) */
    INPUT_DEBOUNCE_MS: 100,

    /** Watchdog timeout: force unlock render queue if task hangs */
    RENDER_TIMEOUT_MS: 5000,

    /**
     * Rust "breather" gap (ms) - gives WASM time to release RefCell locks.
     * 0ms is too aggressive, 5-10ms is safe and imperceptible to humans.
     * This forces the next render into a new macro-task.
     */
    RENDER_GAP_MS: 5,

    /** Brief pause after error before retry (prevents tight error loops) */
    ERROR_COOLDOWN_MS: 50,

    /** Cooldown after recovery before accepting new renders */
    RECOVERY_COOLDOWN_MS: 200,
} as const;

/** Type for the configuration object */
export type EditorConfig = typeof EDITOR_CONFIG;
