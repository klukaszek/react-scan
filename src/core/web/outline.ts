import { type Fiber } from 'react-reconciler';
import { getNearestHostFiber } from '../instrumentation/fiber';
import type { Render } from '../instrumentation/index';
import { ReactScanInternals } from '../index';
import { WebGLContext } from './index'
import { getLabelText } from '../utils';
import { isOutlineUnstable, throttle } from './utils';
import { log } from './log';
import { createElement } from 'react';

let animationFrameId: number | null = null;

export interface PendingOutline {
    rect: DOMRect;
    domNode: HTMLElement;
    renders: Render[];
}

export interface ActiveOutline {
    outline: PendingOutline;
    alpha: number;
    frame: number;
    totalFrames: number;
    resolve: () => void;
    text: string | null;
    color: { r: number; g: number; b: number };
}

export interface OutlineLabel {
    alpha: number;
    outline: PendingOutline;
    text: string | null;
    color: { r: number; g: number; b: number };
}

export const MONO_FONT =
    'Menlo,Consolas,Monaco,Liberation Mono,Lucida Console,monospace';

const DEFAULT_THROTTLE_TIME = 16; // 1 frame
const START_COLOR = { r: 115, g: 97, b: 230 };
const END_COLOR = { r: 185, g: 49, b: 115 };
// Create quad vertices for a single rectangle
const quad_vertices = [
    -1, -1,
    1, -1,
    -1, 1,
    1, 1
];

const textPositions = new Float32Array([
    0, 0,
    1, 0,
    0, 1,
    1, 1,
]);

const textCoords = new Float32Array([
    0, 0,
    1, 0,
    0, 1,
    1, 1,
]);

const createTextTexture = (gl: WebGLRenderingContext, text: string) => {
    const textCanvas = document.createElement('canvas');
    const ctx = textCanvas.getContext('2d')!;

    ctx.font = `10px arial`;
    const textMetrics = ctx.measureText(text);

    textCanvas.width = textMetrics.width;
    textCanvas.height = 16;

    ctx.font = `10px arial`;
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'white';
    ctx.fillText(text, -text.length / 2, -text.length / 2);

    const texture: WebGLTexture = gl.createTexture()!;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
        gl.TEXTURE_2D,        // target
        0,                    // level
        gl.RGBA,             // internalformat
        textCanvas.width,     // width
        textCanvas.height,    // height
        0,                    // border
        gl.RGBA,             // format
        gl.UNSIGNED_BYTE,    // type
        ctx.getImageData(0, 0, textCanvas.width, textCanvas.height).data   // pixels
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return {
        WebGLTexture: texture,
        width: textCanvas.width,
        height: textCanvas.height
    };
}

export const getOutlineKey = (outline: PendingOutline): string => {
    return `${outline.rect.top}-${outline.rect.left}-${outline.rect.width}-${outline.rect.height}`;
};

const rectCache = new Map<HTMLElement, { rect: DOMRect; timestamp: number }>();

export const getRect = (domNode: HTMLElement): DOMRect | null => {
    const cached = rectCache.get(domNode);
    if (cached && cached.timestamp > performance.now() - DEFAULT_THROTTLE_TIME) {
        return cached.rect;
    }

    const style = window.getComputedStyle(domNode);
    if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0'
    ) {
        return null;
    }

    const rect = domNode.getBoundingClientRect();

    const isVisible =
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight &&
        rect.right <= window.innerWidth;

    if (!isVisible || !rect.width || !rect.height) {
        return null;
    }

    rectCache.set(domNode, { rect, timestamp: performance.now() });

    return rect;
};

export const getOutline = (
    fiber: Fiber,
    render: Render,
): PendingOutline | null => {
    const domFiber = getNearestHostFiber(fiber);
    if (!domFiber) return null;

    const domNode = domFiber.stateNode;

    if (!(domNode instanceof HTMLElement)) return null;

    let shouldIgnore = false;

    let currentDomNode: HTMLElement | null = domNode;
    while (currentDomNode) {
        if (currentDomNode.hasAttribute('data-react-scan-ignore')) {
            shouldIgnore = true;
            break;
        }
        currentDomNode = currentDomNode.parentElement;
    }

    if (shouldIgnore) return null;

    const rect = getRect(domNode);
    if (!rect) return null;

    return {
        rect,
        domNode,
        renders: [render],
    };
};

export const mergeOutlines = (outlines: PendingOutline[]) => {
    const mergedOutlines = new Map<string, PendingOutline>();
    for (let i = 0, len = outlines.length; i < len; i++) {
        const outline = outlines[i];
        const key = getOutlineKey(outline);
        const existingOutline = mergedOutlines.get(key);

        if (!existingOutline) {
            mergedOutlines.set(key, outline);
            continue;
        }
        existingOutline.renders.push(...outline.renders);
    }
    return Array.from(mergedOutlines.values());
};

export const recalcOutlines = throttle(() => {
    const { scheduledOutlines, activeOutlines } = ReactScanInternals;

    for (let i = scheduledOutlines.length - 1; i >= 0; i--) {
        const outline = scheduledOutlines[i];
        const rect = getRect(outline.domNode);
        if (!rect) {
            scheduledOutlines.splice(i, 1);
            continue;
        }
        outline.rect = rect;
    }

    for (let i = activeOutlines.length - 1; i >= 0; i--) {
        const activeOutline = activeOutlines[i];
        if (!activeOutline) continue;
        const { outline } = activeOutline;
        const rect = getRect(outline.domNode);
        if (!rect) {
            activeOutlines.splice(i, 1);
            continue;
        }
        outline.rect = rect;
    }
}, DEFAULT_THROTTLE_TIME);

export const flushOutlinesGL = (
    ctx: WebGLContext,
    previousOutlines: Map<string, PendingOutline> = new Map(),
    toolbar: HTMLElement | null = null,
) => {
    if (!ReactScanInternals.scheduledOutlines.length) {
        return;
    }

    const firstOutlines = ReactScanInternals.scheduledOutlines;
    ReactScanInternals.scheduledOutlines = [];

    //requestAnimationFrame(() => {
    recalcOutlines();
    void (async () => {
        const secondOutlines = ReactScanInternals.scheduledOutlines;
        ReactScanInternals.scheduledOutlines = [];
        const mergedOutlines = secondOutlines
            ? mergeOutlines([...firstOutlines, ...secondOutlines])
            : firstOutlines;

        const newPreviousOutlines = new Map<string, PendingOutline>();

        if (toolbar) {
            const stats = mergedOutlines.reduce((acc, outline) => ({
                count: acc.count + outline.renders.reduce((sum, r) => sum + r.count, 0),
                time: acc.time + outline.renders.reduce((sum, r) => sum + r.time, 0)
            }), { count: 0, time: 0 });

            toolbar.textContent = `×${stats.count}${stats.time > 0 ? ` (${stats.time.toFixed(2)}ms)` : ''
                } · react-scan`;
        }

        await Promise.all(
            mergedOutlines.map(async (outline) => {
                const key = getOutlineKey(outline);
                if (!previousOutlines.has(key)) {
                    await paintOutlineGL(ctx, outline);
                    newPreviousOutlines.set(key, outline);
                }
            }),
        );

        if (ReactScanInternals.scheduledOutlines.length) {
            flushOutlinesGL(ctx, newPreviousOutlines, toolbar);
        }
    })();
    //});
};

export const paintOutlineGL = (
    ctx: WebGLContext,
    outline: PendingOutline,
) => {
    return new Promise<void>((resolve) => {
        const unstable = isOutlineUnstable(outline);
        const totalFrames = unstable ? 144 : 60;
        const alpha = 0.8;

        const { options } = ReactScanInternals;
        options.onPaintStart?.(outline);

        const key = getOutlineKey(outline);
        const existingActiveOutline = ReactScanInternals.activeOutlines.find(
            (activeOutline) => getOutlineKey(activeOutline.outline) === key,
        );

        let count = outline.renders.reduce((acc, render) => acc + render.count, 0);
        const maxRenders = ReactScanInternals.options.maxRenders ?? 100;
        const t = Math.min(count / maxRenders, 1);

        const color = {
            r: Math.round(START_COLOR.r + t * (END_COLOR.r - START_COLOR.r)),
            g: Math.round(START_COLOR.g + t * (END_COLOR.g - START_COLOR.g)),
            b: Math.round(START_COLOR.b + t * (END_COLOR.b - START_COLOR.b))
        };

        if (existingActiveOutline) {
            existingActiveOutline.outline.renders.push(...outline.renders);
            existingActiveOutline.outline.rect = outline.rect;
            existingActiveOutline.frame = 0;
            existingActiveOutline.totalFrames = totalFrames;
            existingActiveOutline.alpha = alpha;
            existingActiveOutline.color = color;
        } else {
            ReactScanInternals.activeOutlines.push({
                outline,
                alpha,
                frame: 0,
                totalFrames,
                resolve: () => {
                    resolve();
                    options.onPaintFinish?.(outline);
                },
                text: getLabelText(outline.renders),
                color,
            });
        }

        if (!animationFrameId) {
            animationFrameId = requestAnimationFrame(() => fadeOutOutlineGL(ctx));
        }
    });
};

export const fadeOutOutlineGL = (
    ctx: WebGLContext
) => {
    const { gl, programs } = ctx;
    const { activeOutlines } = ReactScanInternals;

    gl.clearColor(0, 0, 0, 0);

    const positionLocation = gl.getAttribLocation(programs.outline, 'a_position');
    const colorLocation = gl.getUniformLocation(programs.outline, 'u_color');
    const resolutionLocation = gl.getUniformLocation(programs.outline, 'u_resolution');
    const rectLocation = gl.getUniformLocation(programs.outline, 'u_rect');

    gl.uniform2f(resolutionLocation, gl.canvas.width, gl.canvas.height);

    // Create and bind position buffer (reusable quad)
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(quad_vertices), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.useProgram(programs.outline);

    // Draw each rectangle using the same quad
    for (let i = activeOutlines.length - 1; i >= 0; i--) {
        const activeOutline = activeOutlines[i];
        if (!activeOutline) continue;

        const { outline, frame, totalFrames, color, text } = activeOutline;
        const { rect } = outline;
        const unstable = isOutlineUnstable(outline);

        // Update rect if needed
        if (outline) {
            const newRect = getRect(outline.domNode);
            if (newRect) {
                outline.rect = newRect;
            }
        }

        const alphaScalar = unstable ? 0.8 : 0.2;
        activeOutline.alpha = alphaScalar * (1 - frame / totalFrames);

        // Set color uniform
        const r = unstable ? color.r / 255 : 255 / 255;
        const g = unstable ? color.g / 255 : 25 / 255;
        const b = unstable ? color.b / 255 : 115 / 255;
        const a = activeOutline.alpha;
        
        // Set color uniform
        gl.uniform4f(colorLocation, r, g, b, a);

        // Set rectangle dimensions uniform
        gl.uniform4f(rectLocation, rect.x, rect.y, rect.width, rect.height);

        // Draw quad
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // WE SHOULD DRAW TEXT HERE
        // -------------------------

        activeOutline.frame++;
        if (activeOutline.frame > activeOutline.totalFrames) {
            activeOutlines.splice(i, 1);
        }
    }

    if (activeOutlines.length) {
        animationFrameId = requestAnimationFrame(() => fadeOutOutlineGL(ctx));
    } else {
        animationFrameId = null;
    }
};

// Original code
// ----------------

//export const flushOutlines = (
//    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
//    previousOutlines: Map<string, PendingOutline> = new Map(),
//    toolbar: HTMLElement | null = null,
//) => {
//    if (!ReactScanInternals.scheduledOutlines.length) {
//        return;
//    }
//
//    const firstOutlines = ReactScanInternals.scheduledOutlines;
//    ReactScanInternals.scheduledOutlines = [];
//
//    requestAnimationFrame(() => {
//        recalcOutlines();
//        void (async () => {
//            const secondOutlines = ReactScanInternals.scheduledOutlines;
//            ReactScanInternals.scheduledOutlines = [];
//            const mergedOutlines = secondOutlines
//                ? mergeOutlines([...firstOutlines, ...secondOutlines])
//                : firstOutlines;
//
//            const newPreviousOutlines = new Map<string, PendingOutline>();
//
//            if (toolbar) {
//                let totalCount = 0;
//                let totalTime = 0;
//
//                for (let i = 0, len = mergedOutlines.length; i < len; i++) {
//                    const outline = mergedOutlines[i];
//                    for (let j = 0, len = outline.renders.length; j < len; j++) {
//                        const render = outline.renders[j];
//                        totalTime += render.time;
//                        totalCount += render.count;
//                    }
//                }
//
//                let text = `×${totalCount}`;
//                if (totalTime > 0) text += ` (${totalTime.toFixed(2)}ms)`;
//                toolbar.textContent = `${text} · react-scan`;
//            }
//
//            await Promise.all(
//                mergedOutlines.map(async (outline) => {
//                    const key = getOutlineKey(outline);
//                    if (previousOutlines.has(key)) {
//                        return;
//                    }
//                    await paintOutline(ctx, outline);
//                    newPreviousOutlines.set(key, outline);
//                }),
//            );
//            if (ReactScanInternals.scheduledOutlines.length) {
//                flushOutlines(ctx, newPreviousOutlines, toolbar);
//            }
//        })();
//    });
//};
//
//let animationFrameId: number | null = null;
//
//export const paintOutline = (
//    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
//    outline: PendingOutline,
//) => {
//    return new Promise<void>((resolve) => {
//        const unstable = isOutlineUnstable(outline);
//        const totalFrames = unstable ? 60 : 5;
//        const alpha = 0.8;
//
//        const { options } = ReactScanInternals;
//        options.onPaintStart?.(outline);
//        if (options.log) {
//            log(outline.renders);
//        }
//
//        const key = getOutlineKey(outline);
//        const existingActiveOutline = ReactScanInternals.activeOutlines.find(
//            (activeOutline) => getOutlineKey(activeOutline.outline) === key,
//        );
//
//        let renders = outline.renders;
//        if (existingActiveOutline) {
//            existingActiveOutline.outline.renders.push(...outline.renders);
//            renders = existingActiveOutline.outline.renders;
//        }
//
//        let count = 0;
//        for (let i = 0, len = renders.length; i < len; i++) {
//            const render = renders[i];
//            count += render.count;
//        }
//
//        const maxRenders = ReactScanInternals.options.maxRenders ?? 100;
//        const t = Math.min(count / maxRenders, 1);
//
//        const r = Math.round(START_COLOR.r + t * (END_COLOR.r - START_COLOR.r));
//        const g = Math.round(START_COLOR.g + t * (END_COLOR.g - START_COLOR.g));
//        const b = Math.round(START_COLOR.b + t * (END_COLOR.b - START_COLOR.b));
//
//        const color = { r, g, b };
//
//        if (existingActiveOutline) {
//            existingActiveOutline.outline.renders.push(...outline.renders);
//            existingActiveOutline.outline.rect = outline.rect;
//            existingActiveOutline.frame = 0;
//            existingActiveOutline.totalFrames = totalFrames;
//            existingActiveOutline.alpha = alpha;
//            existingActiveOutline.text = getLabelText(
//                existingActiveOutline.outline.renders,
//            );
//            existingActiveOutline.color = color;
//        } else {
//            const frame = 0;
//            ReactScanInternals.activeOutlines.push({
//                outline,
//                alpha,
//                frame,
//                totalFrames,
//                resolve: () => {
//                    resolve();
//                    options.onPaintFinish?.(outline);
//                },
//                text: getLabelText(outline.renders),
//                color,
//            });
//        }
//
//        if (!animationFrameId) {
//            animationFrameId = requestAnimationFrame(() => fadeOutOutline(ctx));
//        }
//    });
//};
//
//export const fadeOutOutline = (
//    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
//) => {
//    const { activeOutlines, options } = ReactScanInternals;
//
//    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
//
//    const groupedOutlines = new Map<string, ActiveOutline>();
//
//    for (let i = activeOutlines.length - 1; i >= 0; i--) {
//        const activeOutline = activeOutlines[i];
//        if (!activeOutline) continue;
//        const { outline } = activeOutline;
//
//        requestAnimationFrame(() => {
//            if (outline) {
//                const newRect = getRect(outline.domNode);
//                if (newRect) {
//                    outline.rect = newRect;
//                }
//            }
//        });
//
//        const { rect } = outline;
//        const key = `${rect.x}-${rect.y}`;
//
//        if (!groupedOutlines.has(key)) {
//            groupedOutlines.set(key, activeOutline);
//        } else {
//            const group = groupedOutlines.get(key)!;
//
//            if (group.outline.renders !== outline.renders) {
//                group.outline.renders = [...group.outline.renders, ...outline.renders];
//            }
//
//            group.alpha = Math.max(group.alpha, activeOutline.alpha);
//            group.frame = Math.min(group.frame, activeOutline.frame);
//            group.totalFrames = Math.max(
//                group.totalFrames,
//                activeOutline.totalFrames,
//            );
//
//            activeOutlines.splice(i, 1);
//        }
//
//        activeOutline.frame++;
//
//        if (activeOutline.frame > activeOutline.totalFrames) {
//            activeOutlines.splice(i, 1);
//        }
//    }
//
//    //console.log('Grouped outlines:', groupedOutlines.size);
//
//    const pendingLabeledOutlines: OutlineLabel[] = [];
//
//    ctx.save();
//
//    const renderCountThreshold = options.renderCountThreshold ?? 0;
//    for (const activeOutline of Array.from(groupedOutlines.values())) {
//        const { outline, frame, totalFrames, color } = activeOutline;
//        const { rect } = outline;
//        const unstable = isOutlineUnstable(outline);
//
//        if (renderCountThreshold > 0) {
//            let count = 0;
//            for (let i = 0, len = outline.renders.length; i < len; i++) {
//                const render = outline.renders[i];
//                count += render.count;
//            }
//            if (count < renderCountThreshold) {
//                continue;
//            }
//        }
//
//        const alphaScalar = unstable ? 0.8 : 0.2;
//        activeOutline.alpha = alphaScalar * (1 - frame / totalFrames);
//
//        const alpha = activeOutline.alpha;
//        const fillAlpha = unstable ? activeOutline.alpha * 0.1 : 0;
//
//        const rgb = `${color.r},${color.g},${color.b}`;
//        ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
//        ctx.lineWidth = 1;
//        ctx.fillStyle = `rgba(${rgb}, ${fillAlpha})`;
//
//        ctx.beginPath();
//        ctx.rect(rect.x, rect.y, rect.width, rect.height);
//        ctx.stroke();
//        ctx.fill();
//
//        if (unstable) {
//            const text = getLabelText(outline.renders);
//            pendingLabeledOutlines.push({
//                alpha,
//                outline,
//                text,
//                color,
//            });
//        }
//    }
//
//    ctx.restore();
//
//    for (let i = 0, len = pendingLabeledOutlines.length; i < len; i++) {
//        const { alpha, outline, text, color } = pendingLabeledOutlines[i];
//        const { rect } = outline;
//        ctx.save();
//
//        if (text) {
//            ctx.font = `10px ${MONO_FONT}`;
//            const textMetrics = ctx.measureText(text);
//            const textWidth = textMetrics.width;
//            const textHeight = 10;
//
//            const labelX: number = rect.x;
//            const labelY: number = rect.y - textHeight - 4;
//
//            ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${alpha})`;
//            ctx.fillRect(labelX, labelY, textWidth + 4, textHeight + 4);
//
//            ctx.fillStyle = `rgba(255,255,255,${alpha})`;
//            ctx.fillText(text, labelX + 2, labelY + textHeight);
//        }
//
//        ctx.restore();
//    }
//
//    if (activeOutlines.length) {
//        animationFrameId = requestAnimationFrame(() => fadeOutOutline(ctx));
//    } else {
//        animationFrameId = null;
//    }
//};
