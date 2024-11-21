import type { Fiber, FiberRoot } from 'react-reconciler';
import type * as React from 'react';
import { instrument, type Render } from './instrumentation/index';
import {
    type ActiveOutline,
    flushOutlines,
    getOutline,
    drawTriangle,
    drawOutline,
    type PendingOutline,
} from './web/outline';
import { createGLOverlay, createOverlay } from './web/index';
import { logIntro } from './web/log';
import { createToolbar } from './web/toolbar';
import { playGeigerClickSound } from './web/geiger';

interface Options {
    /**
     * Enable/disable scanning
     *
     * Please use the recommended way:
     * enabled: process.env.NODE_ENV === 'development',
     *
     * @default true
     */
    enabled?: boolean;
    /**
     * Include children of a component applied with withScan
     *
     * @default true
     */
    includeChildren?: boolean;

    /**
     * Run in production
     *
     * @default false
     */
    runInProduction?: boolean;

    /**
     * Enable/disable geiger sound
     *
     * @default true
     */
    playSound?: boolean;

    /**
     * Log renders to the console
     *
     * @default false
     */
    log?: boolean;

    /**
     * Show toolbar bar
     *
     * @default true
     */
    showToolbar?: boolean;

    /**
     * Render count threshold, only show
     * when a component renders more than this
     *
     * @default 0
     */
    renderCountThreshold?: number;

    /**
     * Clear aggregated fibers after this time in milliseconds
     *
     * @default 5000
     */
    resetCountTimeout?: number;

    /**
     * Maximum number of renders for red indicator
     *
     * @default 20
     */
    maxRenders?: number;

    /**
     * Report data to getReport()
     *
     * @default false
     */
    report?: boolean;

    onCommitStart?: () => void;
    onRender?: (fiber: Fiber, render: Render) => void;
    onCommitFinish?: () => void;
    onPaintStart?: (outline: PendingOutline) => void;
    onPaintFinish?: (outline: PendingOutline) => void;
}

interface Internals {
    onCommitFiberRoot: (rendererID: number, root: FiberRoot) => void;
    isInIframe: boolean;
    isPaused: boolean;
    componentAllowList: WeakMap<React.ComponentType<any>, Options> | null;
    options: Options;
    scheduledOutlines: PendingOutline[];
    activeOutlines: ActiveOutline[];
    reportData: Record<
        string,
        {
            count: number;
            time: number;
            badRenders: Render[];
        }
    >;
}

export const ReactScanInternals: Internals = {
    onCommitFiberRoot: (_rendererID: number, _root: FiberRoot): void => {
        /**/
    },
    isInIframe: window.self !== window.top,
    isPaused: false,
    componentAllowList: null,
    options: {
        enabled: true,
        includeChildren: true,
        runInProduction: false,
        playSound: false,
        log: false,
        showToolbar: true,
        renderCountThreshold: 0,
        report: false,
    },
    reportData: {},
    scheduledOutlines: [],
    activeOutlines: [],
};

export const getReport = () => ReactScanInternals.reportData;

export const setOptions = (options: Options) => {
    ReactScanInternals.options = {
        ...ReactScanInternals.options,
        ...options,
    };
};

export const getOptions = () => ReactScanInternals.options;

let inited = false;

export const start = () => {
    if (inited) return;
    inited = true;
    const { options } = ReactScanInternals;

    const gl_ctx = createGLOverlay()!;
    const ctx = createOverlay();
    const toolbar = options.showToolbar ? createToolbar() : null;
    const audioContext =
        typeof window !== 'undefined'
            ? new (window.AudioContext ||
                // @ts-expect-error -- This is a fallback for Safari
                window.webkitAudioContext)()
            : null;

    if (!ctx) return;
    logIntro();

    globalThis.__REACT_SCAN__ = {
        ReactScanInternals,
    };

    instrument({
        onCommitStart() {
            options.onCommitStart?.();
        },
        onRender(fiber, render) {
            options.onRender?.(fiber, render);
            const outline = getOutline(fiber, render);
            if (!outline) return;
            ReactScanInternals.scheduledOutlines.push(outline);

            if (options.playSound && audioContext) {
                const renderTimeThreshold = 10;
                const amplitude = Math.min(
                    1,
                    (render.time - renderTimeThreshold) / (renderTimeThreshold * 2),
                );
                playGeigerClickSound(audioContext, amplitude);
            }

            requestAnimationFrame(() => {
                flushOutlines(ctx, new Map(), toolbar);
                drawOutline(gl_ctx);
            });
        },
        onCommitFinish() {
            options.onCommitFinish?.();
        },
    });
};

export const withScan = <T>(
    component: React.ComponentType<T>,
    options: Options = {},
) => {
    setOptions(options);
    const { isInIframe, componentAllowList } = ReactScanInternals;
    if (isInIframe || options.enabled === false) return component;
    if (!componentAllowList) {
        ReactScanInternals.componentAllowList = new WeakMap<
            React.ComponentType<any>,
            Options
        >();
    }
    if (componentAllowList) {
        componentAllowList.set(component, { ...options });
    }

    start();

    return component;
};

export const scan = (options: Options = {}) => {
    setOptions(options);
    const { isInIframe } = ReactScanInternals;
    if (isInIframe || options.enabled === false) return;

    start();
};
