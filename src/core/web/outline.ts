import { type Fiber } from 'react-reconciler';
import { getNearestHostFiber } from '../instrumentation/fiber';
import type { Render } from '../instrumentation/index';
import { ReactScanInternals } from '../index';
import { WebGLContext, drawComposite } from './index'
import { getLabelText } from '../utils';
import { isOutlineUnstable, throttle } from './utils';

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

const DEFAULT_THROTTLE_TIME = 6; // 1 frame
const START_COLOR = { r: 115, g: 97, b: 230 };
const END_COLOR = { r: 185, g: 49, b: 115 };

const pendingLabels = new Map<ActiveOutline, OutlineLabel>();

// Create quad vertices for a single rectangle
const quad_vertices = [
    -1, -1,
    1, -1,
    -1, 1,
    1, 1
];

interface TextureInfo {
    texture: WebGLTexture;
    useCount: number;
    width: number;
    height: number;
}

const componentUpdateMap = new Map<string, number>();
const textureCache = new Map<string, TextureInfo>();

// Create a texture from text using Canvas2D
// Create texture from text
function createTextTexture(gl: WebGL2RenderingContext, text: string, fontSize: number = 48) {

    if (textureCache.has(text)) {
        const textureInfo = textureCache.get(text)!;
        textureInfo.useCount++;
        return textureInfo;
    }

    const textCanvas = document.createElement('canvas');
    const ctx = textCanvas.getContext('2d')!;

    // Set canvas size
    ctx.font = `${fontSize}px ${MONO_FONT}`;
    const metrics = ctx.measureText(text);
    const width = Math.ceil(metrics.width);
    const height = fontSize * 1.5;

    textCanvas.width = width;
    textCanvas.height = height;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'transparent';
    ctx.fillRect(0, 0, width, height);

    // Draw text
    ctx.font = `${fontSize}px ${MONO_FONT}`;
    ctx.textBaseline = 'middle';

    ctx.lineWidth = 4;
    ctx.strokeStyle = 'black';
    ctx.strokeText(text, 0, height / 2);

    ctx.fillStyle = 'black';
    ctx.fillText(text, 0, height / 2);

    // Create texture
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        textCanvas
    );

    // Set texture parameters
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

    const textureInfo = { texture, useCount: 1, width, height };
    textureCache.set(text, textureInfo);

    return textureInfo;
}

export const getOutlineKey = (outline: PendingOutline): string => {
    return `${outline.rect.top}-${outline.rect.left}-${outline.rect.width}-${outline.rect.height}`;
};

const rectCache = new Map<HTMLElement, { rect: DOMRect; timestamp: number }>();

export const getRect = (domNode: HTMLElement): DOMRect | null => {
    const cached = rectCache.get(domNode);
    if (cached && cached.timestamp > performance.now() - 128) {
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
        rect.top >= -30 &&
        rect.left >= 0 &&
        rect.bottom <= window.innerHeight + 30 &&
        rect.right <= window.innerWidth + 30;

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
};

export const paintOutlineGL = (
    ctx: WebGLContext,
    outline: PendingOutline,
) => {
    return new Promise<void>((resolve) => {
        const unstable = isOutlineUnstable(outline);
        const totalFrames = unstable ? 60 : 30;
        const alpha = 1.0;

        const { options } = ReactScanInternals;
        options.onPaintStart?.(outline);

        const key = getOutlineKey(outline);
        const existingActiveOutline = ReactScanInternals.activeOutlines.find(
            (activeOutline) => getOutlineKey(activeOutline.outline) === key,
        );

        // Update the component's update count in our map
        const currentCount = componentUpdateMap.get(key) || 0;
        componentUpdateMap.set(key, currentCount + 1);

        const maxRenders = ReactScanInternals.options.maxRenders ?? 100;
        const updateCount = componentUpdateMap.get(key) || 0;
        const t = Math.min(updateCount / maxRenders, 1);

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
    const { gl } = ctx;
    const { activeOutlines } = ReactScanInternals;

    if (!activeOutlines.length || activeOutlines.length === 0) {
        animationFrameId = null;

        console.log(textureCache.keys());

        // Reset the maps on idle
        componentUpdateMap.clear();
        rectCache.clear();

        textureCache.forEach((textureInfo) => {
            if (textureInfo.useCount > 1) {
                textureInfo.useCount--;
                return;
            }
            gl.deleteTexture(textureInfo.texture);
        });
        textureCache.clear();

        return;
    }

    const currentZoom = window.devicePixelRatio;
    const screenOffsetX = window.scrollX;
    const screenOffsetY = window.scrollY;

    // Update canvas size if needed
    const canvasWidth = window.innerWidth * currentZoom;
    const canvasHeight = window.innerHeight * currentZoom;
    if (gl.canvas.width !== canvasWidth || gl.canvas.height !== canvasHeight) {
        gl.canvas.width = canvasWidth;
        gl.canvas.height = canvasHeight;

        if (ctx.framebufferManager) {
            ctx.framebufferManager.resizeFramebuffer(
                ctx.framebufferManager.mainFramebuffer,
                canvasWidth,
                canvasHeight
            );
        }
    }

    const outlineFBO = ctx.framebufferManager.mainFramebuffer;
    ctx.framebufferManager.bindFramebuffer(outlineFBO);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    //ctx.framebufferManager.clear();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Draw outlines to framebuffer using the outline shader program
    drawOutlines(ctx, currentZoom, screenOffsetX, screenOffsetY);
    // Draw text to framebuffer using the text shader program
    if (activeOutlines.length > 0) {
        drawText(ctx, 16, currentZoom, screenOffsetX, screenOffsetY);
    }

    gl.disable(gl.BLEND);

    ctx.framebufferManager.bindFramebuffer(null);
    drawComposite(ctx, outlineFBO);

    // Clean up expired outlines
    for (let i = activeOutlines.length - 1; i >= 0; i--) {
        if (activeOutlines[i].frame > activeOutlines[i].totalFrames) {
            activeOutlines.splice(i, 1);
        }
    }

    // Continue animation
    animationFrameId = requestAnimationFrame(() => fadeOutOutlineGL(ctx));
};

const drawText = (ctx: WebGLContext, fontSize: number = 16, currentZoom: number, screenOffsetX: number, screenOffsetY: number) => {
    const { gl, programs } = ctx;
    const { activeOutlines } = ReactScanInternals;

    gl.useProgram(programs.text);

    // Get attribute locations
    const positionLocation = gl.getAttribLocation(programs.text, 'aPosition');
    const texCoordLocation = gl.getAttribLocation(programs.text, 'aTexCoord');
    const quadPositionLocation = gl.getAttribLocation(programs.text, 'aQuadPosition');
    const quadSizeLocation = gl.getAttribLocation(programs.text, 'aQuadSize');
    const resolutionLocation = gl.getUniformLocation(programs.text, 'uResolution');
    const colorLocation = gl.getUniformLocation(programs.text, 'uColor');

    // Set uniforms
    gl.uniform2f(resolutionLocation, gl.canvas.width, gl.canvas.height);

    // Create unit quad position buffer (standard quad from 0 to 1)
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0, 0,
        1, 0,
        0, 1,
        0, 1,
        1, 0,
        1, 1,
    ]), gl.STATIC_DRAW);

    // Create texcoord buffer
    const texCoordBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0, 0,
        1, 0,
        0, 1,
        0, 1,
        1, 0,
        1, 1,
    ]), gl.STATIC_DRAW);

    // Set up position attribute (unit quad)
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(positionLocation, 0);

    // Set up texcoord attribute
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.enableVertexAttribArray(texCoordLocation);
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(texCoordLocation, 0);


    activeOutlines.forEach((activeOutline) => {

        const { outline, text, color, alpha } = activeOutline;

        // Texture cache should only contain textures marked as unstable during the current frame
        if (textureCache.has(text!)) {
            const textInfo = textureCache.get(text!)!;
            const { rect } = outline;

            const quadPositionBuffer = gl.createBuffer();
            let x = (rect.x + 5)
            let y = rect.y - (fontSize * 0.7) - 1;

            // Make sure text follows zoom and scroll offsets
            x = x * currentZoom;
            y = y * currentZoom;

            gl.bindBuffer(gl.ARRAY_BUFFER, quadPositionBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                x, y,
                x, y,
                x, y,
                x, y,
                x, y,
                x, y,
            ]), gl.STATIC_DRAW);

            // Create quad size buffer
            const quadSizeBuffer = gl.createBuffer();
            const textWidth = textInfo.width * fontSize / textInfo.height;
            const textHeight = fontSize;
            gl.bindBuffer(gl.ARRAY_BUFFER, quadSizeBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                textWidth, textHeight,
                textWidth, textHeight,
                textWidth, textHeight,
                textWidth, textHeight,
                textWidth, textHeight,
                textWidth, textHeight,
            ]), gl.STATIC_DRAW);

            // Set up quad position attribute
            gl.bindBuffer(gl.ARRAY_BUFFER, quadPositionBuffer);
            gl.enableVertexAttribArray(quadPositionLocation);
            gl.vertexAttribPointer(quadPositionLocation, 2, gl.FLOAT, false, 0, 0);
            gl.vertexAttribDivisor(quadPositionLocation, 1);

            // Set up quad size attribute
            gl.bindBuffer(gl.ARRAY_BUFFER, quadSizeBuffer);
            gl.enableVertexAttribArray(quadSizeLocation);
            gl.vertexAttribPointer(quadSizeLocation, 2, gl.FLOAT, false, 0, 0);
            gl.vertexAttribDivisor(quadSizeLocation, 1);

            // Bind the texture
            gl.bindTexture(gl.TEXTURE_2D, textInfo.texture);

            const isImportant = isOutlineUnstable(outline);
            const alphaScalar = isImportant ? 1.0 : 0.2;

            const new_alpha = alphaScalar * alpha;
            const fillAlpha = isImportant ? new_alpha * 0.1 : 0;

            // Set color and alpha
            gl.uniform4f(colorLocation, color.r / 255, color.g / 255, color.b / 255, alphaScalar * alpha);

            // Draw the text
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            gl.disableVertexAttribArray(quadPositionLocation);
            gl.disableVertexAttribArray(quadSizeLocation);

            gl.deleteBuffer(quadPositionBuffer);
        }
    });

    gl.disableVertexAttribArray(positionLocation);
    gl.disableVertexAttribArray(texCoordLocation);


    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    gl.deleteBuffer(positionBuffer);
    gl.deleteBuffer(texCoordBuffer);

    gl.bindTexture(gl.TEXTURE_2D, null);
};

// GL code to bind necessary data to draw outlines in a single draw call
const drawOutlines = (ctx: WebGLContext, currentZoom: number, screenOffsetX: number, screenOffsetY: number) => {

    const { gl, programs } = ctx;
    const { activeOutlines } = ReactScanInternals;

    // Validate program (We can probably remove this since we know the program is valid)
    gl.validateProgram(programs.outline);
    if (!gl.getProgramParameter(programs.outline, gl.VALIDATE_STATUS)) {
        console.error('Program validation failed:', gl.getProgramInfoLog(programs.outline));
        return false;
    }

    // Assign program
    gl.useProgram(programs.outline);
    if (!gl.getProgramParameter(programs.outline, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(programs.outline));
        return false;
    }

    // Get attribute and uniform locations
    const positionLocation = gl.getAttribLocation(programs.outline, 'a_position');
    const colorLocation = gl.getAttribLocation(programs.outline, 'a_color');
    const rectLocation = gl.getAttribLocation(programs.outline, 'a_rect');
    const resolutionLocation = gl.getUniformLocation(programs.outline, 'u_resolution');
    const outlineZoomLocation = gl.getUniformLocation(programs.outline, 'u_zoom');
    const outlineViewportOffsetLocation = gl.getUniformLocation(programs.outline, 'u_offset');

    if (positionLocation === -1 || colorLocation === -1 || rectLocation === -1) {
        console.error('Failed to get attribute locations');
        return false;
    }

    // Set resolution, zoom, and screen offset uniforms
    gl.uniform2f(resolutionLocation, gl.canvas.width, gl.canvas.height);
    gl.uniform1f(outlineZoomLocation, currentZoom);
    gl.uniform2f(outlineViewportOffsetLocation, screenOffsetX, screenOffsetY);

    // Create and bind position buffer (reusable quad)
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(quad_vertices), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    // Create instance data buffers
    const colorBuffer = gl.createBuffer();
    const rectBuffer = gl.createBuffer();

    // Assemble instance data arrays for drawArraysInstanced
    const bufferData = assembleOutlinesDrawArraysInstanced(ctx);
    if (!bufferData) {
        return false;
    }
    const { rectData, colorData } = bufferData;

    // Upload color data
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colorData, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(colorLocation);
    gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(colorLocation, 1);

    // Upload rect data
    gl.bindBuffer(gl.ARRAY_BUFFER, rectBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, rectData, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(rectLocation);
    gl.vertexAttribPointer(rectLocation, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(rectLocation, 1);

    //Draw all instances
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, activeOutlines.length);

    // Clean up
    gl.disableVertexAttribArray(positionLocation);
    gl.disableVertexAttribArray(colorLocation);
    gl.disableVertexAttribArray(rectLocation);

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.deleteBuffer(colorBuffer);
    gl.deleteBuffer(rectBuffer);

    return true;
}

// Helper to assemble instance data for drawArraysInstanced
const assembleOutlinesDrawArraysInstanced = (ctx: WebGLContext) => {

    const { gl } = ctx;
    const { activeOutlines } = ReactScanInternals;

    // Prepare instance data
    const rectData = new Float32Array(activeOutlines.length * 4);
    const colorData = new Float32Array(activeOutlines.length * 4);

    // Fill instance data
    activeOutlines.forEach((activeOutline, i) => {
        if (!activeOutline) return;

        const { outline, frame, totalFrames, color, text } = activeOutline;
        const { rect } = outline;
        const unstable = isOutlineUnstable(outline);

        console.log(text!, 'unstable', unstable);

        if (!textureCache.has(text!) && unstable) {
            createTextTexture(gl, text!); // this will also cache the texture for future use
        }

        // Update rect if needed
        if (outline) {
            const newRect = getRect(outline.domNode);
            if (newRect) {
                outline.rect = newRect;
            }
        }

        // Current position in the data arrays
        const offset = i * 4;

        // Set rect data
        rectData[offset] = rect.x + window.scrollX;
        rectData[offset + 1] = rect.y + window.scrollY;
        rectData[offset + 2] = rect.width;
        rectData[offset + 3] = rect.height;

        const alphaScalar = unstable ? 1.0 : 0.2;
        activeOutline.alpha = alphaScalar * (1 - frame / totalFrames);

        // Set color data
        colorData[offset] = unstable ? color.r / 255 : 1.0;
        colorData[offset + 1] = unstable ? color.g / 255 : 25 / 255;
        colorData[offset + 2] = unstable ? color.b / 255 : 115 / 255;
        colorData[offset + 3] = activeOutline.alpha;

        // Increment frame to fade out
        activeOutline.frame++;
    });

    return { rectData, colorData };
}
