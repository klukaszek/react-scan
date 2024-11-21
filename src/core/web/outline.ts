import { type Fiber } from 'react-reconciler';
import { getNearestHostFiber } from '../instrumentation/fiber';
import type { Render } from '../instrumentation/index';
import { ReactScanInternals } from '../index';
import { WebGLContext } from './index'
import { getLabelText } from '../utils';
import { isOutlineUnstable, throttle } from './utils';
import { log } from './log';

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

export const flushOutlines = (
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    previousOutlines: Map<string, PendingOutline> = new Map(),
    toolbar: HTMLElement | null = null,
) => {
    if (!ReactScanInternals.scheduledOutlines.length) {
        return;
    }

    const firstOutlines = ReactScanInternals.scheduledOutlines;
    ReactScanInternals.scheduledOutlines = [];

    requestAnimationFrame(() => {
        recalcOutlines();
        void (async () => {
            const secondOutlines = ReactScanInternals.scheduledOutlines;
            ReactScanInternals.scheduledOutlines = [];
            const mergedOutlines = secondOutlines
                ? mergeOutlines([...firstOutlines, ...secondOutlines])
                : firstOutlines;

            const newPreviousOutlines = new Map<string, PendingOutline>();

            if (toolbar) {
                let totalCount = 0;
                let totalTime = 0;

                for (let i = 0, len = mergedOutlines.length; i < len; i++) {
                    const outline = mergedOutlines[i];
                    for (let j = 0, len = outline.renders.length; j < len; j++) {
                        const render = outline.renders[j];
                        totalTime += render.time;
                        totalCount += render.count;
                    }
                }

                let text = `×${totalCount}`;
                if (totalTime > 0) text += ` (${totalTime.toFixed(2)}ms)`;
                toolbar.textContent = `${text} · react-scan`;
            }

            await Promise.all(
                mergedOutlines.map(async (outline) => {
                    const key = getOutlineKey(outline);
                    if (previousOutlines.has(key)) {
                        return;
                    }
                    await paintOutline(ctx, outline);
                    newPreviousOutlines.set(key, outline);
                }),
            );
            if (ReactScanInternals.scheduledOutlines.length) {
                flushOutlines(ctx, newPreviousOutlines, toolbar);
            }
        })();
    });
};

let animationFrameId: number | null = null;

export const paintOutline = (
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    outline: PendingOutline,
) => {
    return new Promise<void>((resolve) => {
        const unstable = isOutlineUnstable(outline);
        const totalFrames = unstable ? 60 : 5;
        const alpha = 0.8;

        const { options } = ReactScanInternals;
        options.onPaintStart?.(outline);
        if (options.log) {
            log(outline.renders);
        }

        const key = getOutlineKey(outline);
        const existingActiveOutline = ReactScanInternals.activeOutlines.find(
            (activeOutline) => getOutlineKey(activeOutline.outline) === key,
        );

        let renders = outline.renders;
        if (existingActiveOutline) {
            existingActiveOutline.outline.renders.push(...outline.renders);
            renders = existingActiveOutline.outline.renders;
        }

        let count = 0;
        for (let i = 0, len = renders.length; i < len; i++) {
            const render = renders[i];
            count += render.count;
        }

        const maxRenders = ReactScanInternals.options.maxRenders ?? 100;
        const t = Math.min(count / maxRenders, 1);

        const r = Math.round(START_COLOR.r + t * (END_COLOR.r - START_COLOR.r));
        const g = Math.round(START_COLOR.g + t * (END_COLOR.g - START_COLOR.g));
        const b = Math.round(START_COLOR.b + t * (END_COLOR.b - START_COLOR.b));

        const color = { r, g, b };

        if (existingActiveOutline) {
            existingActiveOutline.outline.renders.push(...outline.renders);
            existingActiveOutline.outline.rect = outline.rect;
            existingActiveOutline.frame = 0;
            existingActiveOutline.totalFrames = totalFrames;
            existingActiveOutline.alpha = alpha;
            existingActiveOutline.text = getLabelText(
                existingActiveOutline.outline.renders,
            );
            existingActiveOutline.color = color;
        } else {
            const frame = 0;
            ReactScanInternals.activeOutlines.push({
                outline,
                alpha,
                frame,
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
            animationFrameId = requestAnimationFrame(() => fadeOutOutline(ctx));
        }
    });
};

export const fadeOutOutline = (
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
) => {
    const { activeOutlines, options } = ReactScanInternals;

    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    const groupedOutlines = new Map<string, ActiveOutline>();

    for (let i = activeOutlines.length - 1; i >= 0; i--) {
        const activeOutline = activeOutlines[i];
        if (!activeOutline) continue;
        const { outline } = activeOutline;

        requestAnimationFrame(() => {
            if (outline) {
                const newRect = getRect(outline.domNode);
                if (newRect) {
                    outline.rect = newRect;
                }
            }
        });

        const { rect } = outline;
        const key = `${rect.x}-${rect.y}`;

        if (!groupedOutlines.has(key)) {
            groupedOutlines.set(key, activeOutline);
        } else {
            const group = groupedOutlines.get(key)!;

            if (group.outline.renders !== outline.renders) {
                group.outline.renders = [...group.outline.renders, ...outline.renders];
            }

            group.alpha = Math.max(group.alpha, activeOutline.alpha);
            group.frame = Math.min(group.frame, activeOutline.frame);
            group.totalFrames = Math.max(
                group.totalFrames,
                activeOutline.totalFrames,
            );

            activeOutlines.splice(i, 1);
        }

        activeOutline.frame++;

        if (activeOutline.frame > activeOutline.totalFrames) {
            activeOutlines.splice(i, 1);
        }
    }

    const pendingLabeledOutlines: OutlineLabel[] = [];

    ctx.save();

    const renderCountThreshold = options.renderCountThreshold ?? 0;
    for (const activeOutline of Array.from(groupedOutlines.values())) {
        const { outline, frame, totalFrames, color } = activeOutline;
        const { rect } = outline;
        const unstable = isOutlineUnstable(outline);

        if (renderCountThreshold > 0) {
            let count = 0;
            for (let i = 0, len = outline.renders.length; i < len; i++) {
                const render = outline.renders[i];
                count += render.count;
            }
            if (count < renderCountThreshold) {
                continue;
            }
        }

        const alphaScalar = unstable ? 0.8 : 0.2;
        activeOutline.alpha = alphaScalar * (1 - frame / totalFrames);

        const alpha = activeOutline.alpha;
        const fillAlpha = unstable ? activeOutline.alpha * 0.1 : 0;

        const rgb = `${color.r},${color.g},${color.b}`;
        ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
        ctx.lineWidth = 1;
        ctx.fillStyle = `rgba(${rgb}, ${fillAlpha})`;

        ctx.beginPath();
        ctx.rect(rect.x, rect.y, rect.width, rect.height);
        ctx.stroke();
        ctx.fill();

        if (unstable) {
            const text = getLabelText(outline.renders);
            pendingLabeledOutlines.push({
                alpha,
                outline,
                text,
                color,
            });
        }
    }

    ctx.restore();

    for (let i = 0, len = pendingLabeledOutlines.length; i < len; i++) {
        const { alpha, outline, text, color } = pendingLabeledOutlines[i];
        const { rect } = outline;
        ctx.save();

        if (text) {
            ctx.font = `10px ${MONO_FONT}`;
            const textMetrics = ctx.measureText(text);
            const textWidth = textMetrics.width;
            const textHeight = 10;

            const labelX: number = rect.x;
            const labelY: number = rect.y - textHeight - 4;

            ctx.fillStyle = `rgba(${color.r},${color.g},${color.b},${alpha})`;
            ctx.fillRect(labelX, labelY, textWidth + 4, textHeight + 4);

            ctx.fillStyle = `rgba(255,255,255,${alpha})`;
            ctx.fillText(text, labelX + 2, labelY + textHeight);
        }

        ctx.restore();
    }

    if (activeOutlines.length) {
        animationFrameId = requestAnimationFrame(() => fadeOutOutline(ctx));
    } else {
        animationFrameId = null;
    }
};

// Draw a simple rectangular outline. Will be updated to draw outlines of all components.
export function drawOutline(ctx: WebGLContext) {
    const { gl, program } = ctx;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Create vertex data for outline
    const vertices = new Float32Array([
        -0.5,  0.5,    // top left
        -0.5, -0.5,    // bottom left
         0.5, -0.5,    // bottom right
         0.5,  0.5,    // top right
        -0.5,  0.5     // close the shape by repeating first vertex
    ]);

    // Create and bind buffer
    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    // Set up attributes
    const positionLocation = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    
    gl.useProgram(program);
    gl.drawArrays(gl.LINE_STRIP, 0, 5);
}
