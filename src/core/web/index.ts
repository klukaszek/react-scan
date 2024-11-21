import { recalcOutlines } from './outline';
import { createElement } from './utils';

// Original createOverlay function using 2D canvas
export const createOverlay = () => {
    const canvas = createElement(
        `<canvas id="react-scan-overlay" style="position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646" aria-hidden="true"/>`,
    ) as HTMLCanvasElement;

    const prevCanvas = document.getElementById('react-scan-overlay');
    if (prevCanvas) {
        prevCanvas.remove();
    }
    document.documentElement.appendChild(canvas);

    const isOffscreenCanvasSupported = 'OffscreenCanvas' in globalThis;
    const offscreenCanvas = isOffscreenCanvasSupported
        ? canvas.transferControlToOffscreen()
        : canvas;
    const ctx = offscreenCanvas.getContext('2d') as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D;

    let resizeScheduled = false;

    const resize = () => {
        const dpi = window.devicePixelRatio;
        ctx.canvas.width = dpi * window.innerWidth;
        ctx.canvas.height = dpi * window.innerHeight;

        if (ctx) {
            ctx.resetTransform();
            ctx.scale(dpi, dpi);
        }

        resizeScheduled = false;
    };

    resize();

    window.addEventListener('resize', () => {
        recalcOutlines();
        if (!resizeScheduled) {
            resizeScheduled = true;
            requestAnimationFrame(() => {
                resize();
            });
        }
    });
    window.addEventListener('scroll', () => {
        recalcOutlines();
    });

    return ctx;
};

// End of original createOverlay function using 2D canvas

// Vertex Shader
const vertexShaderSource = `#version 300 es
in vec2 a_position;

void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
}`;

// Fragment Shader
const fragmentShaderSource = `#version 300 es
precision mediump float;
out vec4 fragColor;

void main() {
    fragColor = vec4(115.0 / 255.0, 97.0 / 255.0, 230.0 / 255.0, 0.5);
}`;

export interface WebGLContext {
    gl: WebGL2RenderingContext;
    program: WebGLProgram;
}

// Create a WebGL shader from the source code.
function createShader(gl: WebGLRenderingContext, type: number, source: string) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

// Create a WebGL program from the vertex and fragment shaders.
function createProgram(gl: WebGLRenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader) {
    const program = gl.createProgram()!;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
    }
    return program;
}

// Initialize a new WebGL context as a transparent canvas overlay.
// Assigns two simple shaders at the moment to draw a triangle.
// These shaders will be replaced with the actual outline drawing logic at a later time.
// Should return a WebGLContext object with the WebGLRenderingContext and WebGLProgram.
export const createGLOverlay = () => {
    const canvas = createElement(
        `<canvas id="react-scan-gl-overlay" style="position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646" aria-hidden="true"/>`,
    ) as HTMLCanvasElement;

    const prevCanvas = document.getElementById('react-scan-gl-overlay');
    if (prevCanvas) {
        prevCanvas.remove();
    }
    document.documentElement.appendChild(canvas);

    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true })!;
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource)!;
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource)!;
    const program = createProgram(gl, vertexShader, fragmentShader)!;

    const context = { gl, program };

    if (!gl) {
        console.error('WebGL not supported');
        return null;
    }

    // To resize we simply set the canvas width and height to the window width and height
    // and update the viewport to match.
    const resize = () => {
        const dpi = window.devicePixelRatio;
        canvas.width = dpi * window.innerWidth;
        canvas.height = dpi * window.innerHeight;
        gl.viewport(0, 0, canvas.width, canvas.height);
    };

    resize();

    window.addEventListener('resize', () => {
        requestAnimationFrame(resize);
    });

    return context;
};

// End of new WebGL based overlay for drawing outlines
