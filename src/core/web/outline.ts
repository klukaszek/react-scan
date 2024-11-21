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
        //const unstable = isOutlineUnstable(outline);

        // Update rect if needed
        if (outline) {
            const newRect = getRect(outline.domNode);
            if (newRect) {
                outline.rect = newRect;
            }
        }

        //const alphaScalar = unstable ? 0.8 : 0.2;
        activeOutline.alpha = 0.8 * (1 - frame / totalFrames);

        // Set color uniform
        const r = color.r / 255;
        const g = color.g / 255;
        const b = color.b / 255;
        const a = activeOutline.alpha;

        gl.uniform4f(colorLocation, r, g, b, a);

        // Set rectangle dimensions uniform
        gl.uniform4f(rectLocation, rect.x, rect.y, rect.width, rect.height);

        // Draw quad
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        //if (text) {
        //    requestAnimationFrame(() => {
        //        gl.useProgram(programs.text);
        //        let textTexture = createTextTexture(gl, text);
        //
        //        const textResolutionLocation = gl.getUniformLocation(programs.text, 'u_resolution');
        //        const textPositionLocation = gl.getUniformLocation(programs.text, 'u_position');
        //        const textScaleLocation = gl.getUniformLocation(programs.text, 'u_scale');
        //        const textColorLocation = gl.getUniformLocation(programs.text, 'u_color');
        //        const textTextureLocation = gl.getUniformLocation(programs.text, 'u_texture');
        //
        //        // Set text uniforms
        //        gl.uniform2f(textResolutionLocation, gl.canvas.width, gl.canvas.height);
        //        gl.uniform2f(textPositionLocation, rect.x, rect.y - 16); // Position above box
        //        gl.uniform2f(textScaleLocation, 16, 16);
        //        gl.uniform1i(textTextureLocation, 0);
        //
        //        let alpha = activeOutline.alpha;
        //
        //        gl.uniform4f(textColorLocation, 1, 1, 1, alpha);
        //
        //        // Bind text texture
        //        gl.activeTexture(gl.TEXTURE0);
        //        //gl.bindTexture(gl.TEXTURE_2D, textTexture);
        //
        //        // Enable blending for text
        //        gl.enable(gl.BLEND);
        //        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        //
        //        // Draw text quad
        //        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        //    }
        //    );
        //}

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

//export const fadeOutOutlineGL = (
//    ctx: WebGLContext
//) => {
//    const { gl, program } = ctx;
//    const { activeOutlines, options } = ReactScanInternals;
//
//    gl.clear(gl.COLOR_BUFFER_BIT);
//    gl.clearColor(0, 0, 0, 0);
//
//    //const program = initWebGL(gl);
//    const positionLocation = gl.getAttribLocation(program, 'a_position');
//    const colorLocation = gl.getAttribLocation(program, 'a_color');
//    const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
//
//    //// Set canvas resolution
//    gl.uniform2f(resolutionLocation, gl.canvas.width, gl.canvas.height);
//
//    // Create buffers for batch rendering
//    const quad_vertices: number[] = [];
//    const colors: number[] = [];
//    const labels: OutlineLabel[] = [];
//
//    for (let i = activeOutlines.length - 1; i >= 0; i--) {
//        const activeOutline = activeOutlines[i];
//        if (!activeOutline) continue;
//
//        const { outline, frame, totalFrames, color } = activeOutline;
//        const { rect } = outline;
//        const unstable = isOutlineUnstable(outline);
//
//        // Update rect if needed
//        requestAnimationFrame(() => {
//            if (outline) {
//                const newRect = getRect(outline.domNode);
//                if (newRect) {
//                    outline.rect = newRect;
//                }
//            }
//        });
//
//        const alphaScalar = unstable ? 0.8 : 0.2;
//        activeOutline.alpha = alphaScalar * (1 - frame / totalFrames);
//
//        // Convert rect to clip space coordinates
//        const clipRect = getBounds(rect, gl.canvas as HTMLCanvasElement);
//
//        // Add rectangle vertices
//        const x1 = clipRect.x;
//        const y1 = clipRect.y;
//        const x2 = x1 + clipRect.width;
//        const y2 = y1 + clipRect.height;
//
//        // Rectangle outline (4 lines)
//        quad_vertices.push(
//            x1, y1, x2, y1,
//            x2, y2, x1, y2,
//            x1, y1
//        );
//
//        // Add colors for each vertex
//        const r = color.r / 255;
//        const g = color.g / 255;
//        const b = color.b / 255;
//        const a = activeOutline.alpha;
//
//        for (let j = 0; j < 5; j++) {
//            colors.push(r, g, b, a);
//        }
//
//        activeOutline.frame++;
//        if (activeOutline.frame > activeOutline.totalFrames) {
//            activeOutlines.splice(i, 1);
//        }
//
//        if (unstable) {
//            labels.push({
//                alpha: a,
//                outline,
//                text: getLabelText(outline.renders),
//                color
//            });
//        }
//    }
//
//    // Create and bind position buffer
//    const positionBuffer = gl.createBuffer();
//    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
//    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(quad_vertices), gl.STATIC_DRAW);
//    gl.enableVertexAttribArray(positionLocation);
//    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
//
//    // Create and bind color buffer
//    const colorBuffer = gl.createBuffer();
//    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
//    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);
//    gl.enableVertexAttribArray(colorLocation);
//    gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, 0, 0);
//
//    // Draw all rectangles
//    gl.useProgram(program);
//
//    for (let i = 0; i < quad_vertices.length / 2; i++) {
//        gl.drawArrays(gl.LINES, i * 4, 5);
//    }
//
//    //gl.drawArrays(gl.LINE_STRIP, 0, quad_vertices.length / 2);
//
//    //// Handle labels using 2D context for text rendering
//    //if (labels.length > 0) {
//    //    const ctx = (gl.canvas as HTMLCanvasElement).getContext('2d')!;
//    //    ctx.save();
//    //
//    //    for (const label of labels) {
//    //        if (label.text) {
//    //            const { rect } = label.outline;
//    //            ctx.font = `10px ${MONO_FONT}`;
//    //            const textMetrics = ctx.measureText(label.text);
//    //            const textWidth = textMetrics.width;
//    //            const textHeight = 10;
//    //
//    //            const labelX = rect.x;
//    //            const labelY = rect.y - textHeight - 4;
//    //
//    //            ctx.fillStyle = `rgba(${label.color.r},${label.color.g},${label.color.b},${label.alpha})`;
//    //            ctx.fillRect(labelX, labelY, textWidth + 4, textHeight + 4);
//    //
//    //            ctx.fillStyle = `rgba(255,255,255,${label.alpha})`;
//    //            ctx.fillText(label.text, labelX + 2, labelY + textHeight);
//    //        }
//    //    }
//    //
//    //    ctx.restore();
//    //}
//
//    if (activeOutlines.length) {
//        animationFrameId = requestAnimationFrame(() => fadeOutOutlineGL(ctx));
//    } else {
//        animationFrameId = null;
//    }
//};

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
//
//const maxOutlines = 100;
//const maxVertices = maxOutlines * 5;

//export function drawOutline(ctx: WebGLContext) {
//    const { gl, program } = ctx;
//    const { activeOutlines, scheduledOutlines } = ReactScanInternals;
//
//    // Clear the canvas
//    gl.clearColor(0, 0, 0, 0);
//    gl.clear(gl.COLOR_BUFFER_BIT);
//
//    let accumulatedVertices: number[] = [];
//    let numOutlines = 0;
//
//    recalcOutlines();
//
//    // Iterate through the scheduled outlines and add them to the active outlines
//    for (let i = scheduledOutlines.length - 1; i >= 0; i--) {
//        const outline = scheduledOutlines[i];
//        const rect = getRect(outline.domNode);
//        if (!rect) {
//            scheduledOutlines.splice(i, 1);
//            continue;
//        }
//        outline.rect = rect;
//        activeOutlines.push({
//            outline,
//            alpha: 0.8,
//            frame: 0,
//            totalFrames: 5,
//            resolve: () => { },
//            text: getLabelText(outline.renders),
//            color: { r: 115, g: 97, b: 230 },
//        });
//    }
//
//    // Iterate through the active outlines and update their frames
//    // Remove any outlines that have completed their animation
//    for (let i = activeOutlines.length - 1; i >= 0; i--) {
//        const activeOutline = activeOutlines[i];
//        if (!activeOutline) continue;
//        const { outline, frame, totalFrames, color } = activeOutline;
//
//        activeOutline.frame++;
//
//        // Remove if animation is complete
//        if (activeOutline.frame > totalFrames) {
//            activeOutlines.splice(i, 1);
//            numOutlines--;
//            console.log('Removing outline');
//            continue;
//        }
//
//        const unstable = isOutlineUnstable(outline);
//        const alphaScalar = unstable ? 0.8 : 0.2;
//        activeOutline.alpha = alphaScalar * (1 - frame / totalFrames);
//
//        const { rect } = outline;
//
//        const vertices = convertToWebGLCoords(rect, gl);
//
//        accumulatedVertices = [...accumulatedVertices, ...vertices];
//
//        numOutlines++;
//    }
//
//    // Create and bind vertex buffer
//    const vertexBuffer = gl.createBuffer();
//    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
//    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(accumulatedVertices), gl.DYNAMIC_DRAW);
//
//    // Set up attributes
//    const positionLocation = gl.getAttribLocation(program, 'a_position');
//    gl.enableVertexAttribArray(positionLocation);
//    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
//
//    // Draw the outline
//    gl.useProgram(program);
//    gl.drawArrays(gl.LINE_STRIP, 0, numOutlines * 4);
//
//}
//
//function convertToWebGLCoords(bounds: DOMRect, gl: WebGLRenderingContext): number[] {
//    const canvas = gl.canvas as HTMLCanvasElement;
//    const canvasWidth = canvas.width;
//    const canvasHeight = canvas.height;
//
//    const left = (bounds.left / canvasWidth) * 2 - 1;
//    const right = (bounds.right / canvasWidth) * 2 - 1;
//    const top = 1 - (bounds.top / canvasHeight) * 2;
//    const bottom = 1 - (bounds.bottom / canvasHeight) * 2;
//
//    return [
//        left, top,      // top left
//        left, bottom,   // bottom left
//        right, bottom,  // bottom right
//        right, top,     // top right
//        left, top       // close the shape
//    ];
//}

// Draw a simple rectangular outline. Will be updated to draw outlines of all components.
export function drawOutline(ctx: WebGLContext) {
    const { gl, programs } = ctx;
    const { activeOutlines, options } = ReactScanInternals;

    // Create vertex data for outline
    const vertices = new Float32Array([
        -0.5, 0.5,    // top left
        -0.5, -0.5,    // bottom left
        0.5, -0.5,    // bottom right
        0.5, 0.5,    // top right
        -0.5, 0.5     // close the shape by repeating first vertex
    ]);

    //// Create and vertex buffer, colorData
    //const { vertices, colors } = buildOutlineBuffers(gl);
    //
    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);

    //const colorBuffer = gl.createBuffer();
    //gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    //gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);

    // Set up attributes
    const positionLocation = gl.getAttribLocation(programs.outline, 'a_position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.useProgram(programs.outline);
    gl.drawArrays(gl.LINE_STRIP, 0, 5);

    // Request next frame if there are active outlines
    if (activeOutlines.some(outline => outline.frame <= outline.totalFrames)) {
        requestAnimationFrame(() => drawOutline(ctx));
    }
}

//export function drawOutline2(ctx: WebGLContext) {
//
//    const { gl, program } = ctx;
//    const { activeOutlines } = ReactScanInternals;
//
//    // Clear the canvas
//    gl.clearColor(0, 0, 0, 0);
//    gl.clear(gl.COLOR_BUFFER_BIT);
//
//    const vertices: number[] = [];
//    const colors: number[] = [];
//
//    // Process each outline directly
//    for (let i = activeOutlines.length - 1; i >= 0; i--) {
//        const activeOutline = activeOutlines[i];
//        if (!activeOutline) continue;
//
//        const { outline, frame, totalFrames, color } = activeOutline;
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
//
//        const { rect } = outline;
//
//        // Update frame counter
//        activeOutline.frame++;
//
//        // Remove if animation is complete
//        if (activeOutline.frame > totalFrames) {
//            activeOutlines.splice(i, 1);
//            continue;
//        }
//
//        // Calculate alpha
//        const unstable = isOutlineUnstable(outline);
//        const alphaScalar = unstable ? 0.8 : 0.2;
//        const alpha = alphaScalar * (1 - frame / totalFrames);
//
//        // Convert to clip space
//        const left = (rect.x / gl.canvas.width) * 2 - 1;
//        const right = ((rect.x + rect.width) / gl.canvas.width) * 2 - 1;
//        const top = -(rect.y / gl.canvas.height) * 2 + 1;
//        const bottom = -((rect.y + rect.height) / gl.canvas.height) * 2 + 1;
//
//        // Add rectangle vertices
//        vertices.push(
//            left, top,
//            right, top,
//            right, bottom,
//            left, bottom
//        );
//
//        // Add colors for each vertex
//        for (let j = 0; j < 4; j++) {
//            colors.push(
//                color.r / 255,
//                color.g / 255,
//                color.b / 255,
//                alpha
//            );
//        }
//    }
//
//    console.log('Vertices:', vertices.length);
//
//    if (vertices.length > 0) {
//
//        const vertexBuffer = gl.createBuffer();
//
//        // Update buffers
//        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
//        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
//
//        const positionLocation = gl.getAttribLocation(program, 'a_position');
//        gl.enableVertexAttribArray(positionLocation);
//        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
//
//        const colorBuffer = gl.createBuffer();
//
//        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
//        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.DYNAMIC_DRAW);
//
//        const colorLocation = gl.getAttribLocation(program, 'a_color');
//        gl.enableVertexAttribArray(colorLocation);
//        gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, 0, 0);
//
//        // Draw outlines
//        gl.useProgram(program);
//        gl.drawArrays(gl.LINE_LOOP, 0, vertices.length / 2);
//
//        console.log('Drawing outlines');
//    }
//
//    // Continue animation if there are active outlines
//    if (activeOutlines.length > 0) {
//        requestAnimationFrame(() => drawOutline(ctx));
//    }
//}
//
//export const drawOutline = (ctx: WebGLContext,
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
//
//            const { gl, program } = ctx;
//            const { activeOutlines, options } = ReactScanInternals;
//
//            // Clear canvas
//            gl.clearColor(0, 0, 0, 0);
//            gl.clear(gl.COLOR_BUFFER_BIT);
//
//            const groupedOutlines = new Map<string, ActiveOutline>();
//
//            // Process and group outlines
//            for (let i = activeOutlines.length - 1; i >= 0; i--) {
//                const activeOutline = activeOutlines[i];
//                if (!activeOutline) continue;
//                const { outline } = activeOutline;
//
//                requestAnimationFrame(() => {
//                    if (outline) {
//                        const newRect = getRect(outline.domNode);
//                        if (newRect) {
//                            console.log('Updating rect');
//                            outline.rect = newRect;
//                        }
//                    }
//                });
//
//                const { rect } = outline;
//                const key = `${rect.x}-${rect.y}`;
//
//                if (!groupedOutlines.has(key)) {
//                    groupedOutlines.set(key, activeOutline);
//                } else {
//                    const group = groupedOutlines.get(key)!;
//
//                    if (group.outline.renders !== outline.renders) {
//                        group.outline.renders = [...group.outline.renders, ...outline.renders];
//                    }
//
//                    group.alpha = Math.max(group.alpha, activeOutline.alpha);
//                    group.frame = Math.min(group.frame, activeOutline.frame);
//                    group.totalFrames = Math.max(
//                        group.totalFrames,
//                        activeOutline.totalFrames,
//                    );
//
//                    activeOutlines.splice(i, 1);
//                }
//
//                activeOutline.frame++;
//
//                if (activeOutline.frame > activeOutline.totalFrames) {
//                    activeOutlines.splice(i, 1);
//                }
//            }
//
//            const vertices: number[] = [];
//            const colors: number[] = [];
//            const pendingLabeledOutlines: OutlineLabel[] = [];
//
//            console.log('Grouped outlines:', groupedOutlines.size);
//
//            // Process outlines for rendering
//            const renderCountThreshold = options.renderCountThreshold ?? 0;
//            for (const activeOutline of Array.from(groupedOutlines.values())) {
//                const { outline, frame, totalFrames, color } = activeOutline;
//                const { rect } = outline;
//                const unstable = isOutlineUnstable(outline);
//
//                if (renderCountThreshold > 0) {
//                    let count = 0;
//                    for (let i = 0, len = outline.renders.length; i < len; i++) {
//                        const render = outline.renders[i];
//                        count += render.count;
//                    }
//                    if (count < renderCountThreshold) {
//                        continue;
//                    }
//                }
//
//                const alphaScalar = unstable ? 0.8 : 0.2;
//                activeOutline.alpha = alphaScalar * (1 - frame / totalFrames);
//
//                const alpha = activeOutline.alpha;
//                const fillAlpha = unstable ? activeOutline.alpha * 0.1 : 0;
//
//                // Convert to clip space
//                const left = (rect.x / gl.canvas.width) * 2 - 1;
//                const right = ((rect.x + rect.width) / gl.canvas.width) * 2 - 1;
//                const top = -(rect.y / gl.canvas.height) * 2 + 1;
//                const bottom = -((rect.y + rect.height) / gl.canvas.height) * 2 + 1;
//
//                // Add vertices for outline
//                vertices.push(
//                    left, top,
//                    right, top,
//                    right, bottom,
//                    left, bottom
//                );
//
//                // Add colors for each vertex
//                for (let i = 0; i < 4; i++) {
//                    colors.push(
//                        color.r / 255,
//                        color.g / 255,
//                        color.b / 255,
//                        alpha
//                    );
//                }
//
//                if (unstable) {
//                    const text = getLabelText(outline.renders);
//                    pendingLabeledOutlines.push({
//                        alpha,
//                        outline,
//                        text,
//                        color,
//                    });
//                }
//            }
//
//            // Draw outlines if we have any
//            if (vertices.length > 0) {
//
//                console.log('Vertices:', vertices.length);
//
//                const vertexBuffer = gl.createBuffer();
//                gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
//                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
//
//                //const colorBuffer = gl.createBuffer();
//                //gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
//                //gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.DYNAMIC_DRAW);
//
//                gl.useProgram(program);
//                gl.drawArrays(gl.LINE_LOOP, 0, vertices.length / 2);
//            }
//
//            if (activeOutlines.length) {
//                animationFrameId = requestAnimationFrame(() => drawOutline(ctx));
//            } else {
//                animationFrameId = null;
//            }
//        });
//    });
//}

