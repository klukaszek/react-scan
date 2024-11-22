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

const outlineVertexShaderSource = `
    attribute vec2 a_position;
    attribute vec4 a_color;
    attribute vec4 a_rect;
    uniform vec2 u_resolution;
    varying vec4 v_color;
    varying vec2 v_position;
    varying vec4 v_rect;  // Add this

    void main() {
        gl_Position = vec4(a_position, 0, 1);
        v_position = vec2(a_position.x, -a_position.y);
        v_color = a_color;
        v_rect = a_rect;  // Pass rect data to fragment shader
    }
`;

const outlineFragShaderSource = `
    precision mediump float;
    varying vec4 v_color;
    varying vec2 v_position;
    varying vec4 v_rect;
    uniform vec2 u_resolution;

    float roundedRectSDF(vec2 pos, vec2 rect, vec2 size, float radius) {
        vec2 d = abs(pos - rect) - size + vec2(radius);
        return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
    }

    void main() {
        // Convert position to pixels
        vec2 pixelPos = (v_position + 1.0) * 0.5 * u_resolution;
        
        // Calculate rect center and size
        vec2 rectCenter = v_rect.xy + v_rect.zw * 0.5;
        vec2 rectSize = v_rect.zw * 0.5;
        
        // Calculate SDF
        float distance = roundedRectSDF(pixelPos, rectCenter, rectSize, 4.0);
        

        float edgeWidth = 5.0;
        float smoothing = 0.1;
        
        // Calculate alpha based on distance
        float alpha = 1.0 - smoothstep(0.0, edgeWidth + smoothing, abs(distance));
        
        if (alpha > 0.0) {
            gl_FragColor = vec4(v_color.rgb, v_color.a * alpha);
        } else {
            discard;
        }
    }
`;

// Text vertex shader
const textVertexShaderSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    uniform vec2 u_resolution;
    uniform vec2 u_position;   // Position of the text
    uniform vec2 u_scale;      // Scale of the text
    varying vec2 v_texCoord;
    
    void main() {
        vec2 position = u_position + (a_position * u_scale);
        vec2 clipSpace = (position / u_resolution) * 2.0 - 1.0;
        gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
        v_texCoord = a_texCoord;
    }
`;

// Text fragment shader
const textFragmentShaderSource = `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform vec4 u_color;
    varying vec2 v_texCoord;
    
    void main() {
        float alpha = texture2D(u_texture, v_texCoord).r;
        gl_FragColor = vec4(u_color.rgb, u_color.a * alpha);
    }
`;


export interface WebGLContext {
    gl: WebGL2RenderingContext;
    programs: {
        outline: WebGLProgram;
        text: WebGLProgram;
    };
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
    const outlineVS = createShader(gl, gl.VERTEX_SHADER, outlineVertexShaderSource)!;
    const outlineFS = createShader(gl, gl.FRAGMENT_SHADER, outlineFragShaderSource)!;
    const outlineProg = createProgram(gl, outlineVS, outlineFS)!;

    const textVS = createShader(gl, gl.VERTEX_SHADER, textVertexShaderSource)!;
    const textFS = createShader(gl, gl.FRAGMENT_SHADER, textFragmentShaderSource)!;
    const textProg = createProgram(gl, textVS, textFS)!;

    const context = { gl } as WebGLContext;
    context.programs = {
        outline: outlineProg,
        text: textProg,
    };

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
