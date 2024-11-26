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
    varying vec4 v_rect;

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
    varying vec2 v_position;  // NDC coordinates (-1 to 1)
    varying vec4 v_rect;      // Rectangle in world space
    uniform vec2 u_resolution;
    uniform vec2 u_offset;    // Scroll offset in world space
    uniform float u_zoom;     // Device pixel ratio

    float roundedRectSDF(vec2 pos, vec2 rect, vec2 size, float radius) {
        vec2 d = abs(pos - rect) - size + vec2(radius);
        return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - radius;
    }

    void main() {
        // 1. Convert NDC to screen space pixels
        vec2 screenPos = (v_position + 1.0) * 0.5 * u_resolution;

        // 2. Convert screen space to world space
        vec2 worldPos = screenPos / u_zoom;

        // 3. Apply scroll offset
        worldPos += u_offset;

        // Calculate rect properties in world space
        vec2 rectCenter = v_rect.xy + v_rect.zw * 0.5;
        vec2 rectSize = v_rect.zw * 0.5;

        // Calculate distance in world space
        float distance = roundedRectSDF(worldPos, rectCenter, rectSize, 3.0);

        // Visual parameters
        float edgeWidth = 1.5;
        float smoothing = 0.1;

        float outlineAlpha = 1.0 - smoothstep(0.0, edgeWidth + smoothing, abs(distance));
        float fillAlpha = smoothstep(-3.0, 0.0, -distance);

        vec4 fillColor = vec4(v_color.rgb, v_color.a * fillAlpha * 0.6);
        vec4 outlineColor = vec4(v_color.rgb, v_color.a * outlineAlpha);
        vec4 blendedColor = mix(fillColor, outlineColor, outlineAlpha);

        if (outlineAlpha > 0.0 || fillAlpha > 0.0) {
            gl_FragColor = vec4(blendedColor.rgb, blendedColor.a);
        } else {
            discard;
        }
    }
`;

// Vertex shader for the framebuffer program
const framebufferVertexShaderSource = `#version 300 es
in vec2 position;
out vec2 texCoord;

void main() {
    texCoord = position * 0.5 + 0.5;  // Convert from clip space to texture space
    gl_Position = vec4(position, 0.0, 1.0);
}`;

// Fragment shader for the framebuffer program
const framebufferFragmentShaderSource = `#version 300 es
precision mediump float;

uniform sampler2D framebufferTexture;
in vec2 texCoord;
out vec4 fragColor;

void main() {
    fragColor = texture(framebufferTexture, texCoord);
}`;

// Text vertex shader
const textVertexShaderSource = `#version 300 es
    in vec2 aPosition;       // Unit quad vertices
    in vec2 aTexCoord;       // Texture coordinates
    in vec2 aQuadPosition;   // Position of this instance
    in vec2 aQuadSize;       // Size of this instance
    uniform vec2 uResolution;     // Resolution of the canvas    

    out vec2 vTexCoord;
    
    void main() {
        // Scale and position the quad
        vec2 scaled = aPosition * aQuadSize;
        vec2 positioned = scaled + aQuadPosition;
               
        // Convert to clip space
        vec2 clipSpace = (positioned / uResolution) * 2.0 - 1.0;
        gl_Position = vec4(clipSpace.x, -clipSpace.y, 1, 1);
        vTexCoord = aTexCoord;
    }
`;

// Fragment shader for text rendering as a quad
const textFragmentShaderSource = `#version 300 es
    precision highp float;
        
    in vec2 vTexCoord;
    uniform sampler2D uTexture;
    uniform vec4 uColor;
    
    out vec4 fragColor;
    
    void main() {
        fragColor = texture(uTexture, vTexCoord);
        fragColor.a *= uColor.a;    
    }
`;

// Types for framebuffer management
interface FramebufferObject {
    framebuffer: WebGLFramebuffer;
    texture: WebGLTexture;
    depthBuffer?: WebGLRenderbuffer;
    width: number;
    height: number;
}

interface FramebufferOptions {
    width?: number;
    height?: number;
    useDepthBuffer?: boolean;
    minFilter?: number;
    magFilter?: number;
    wrapS?: number;
    wrapT?: number;
    internalFormat?: number;
    format?: number;
    type?: number;
}

interface FramebufferManager {
    mainFramebuffer: FramebufferObject;
    createFramebuffer(options?: FramebufferOptions): FramebufferObject;
    resizeFramebuffer(fbo: FramebufferObject, width: number, height: number): void;
    deleteFramebuffer(fbo: FramebufferObject): void;
    bindFramebuffer(fbo: FramebufferObject | null): void;
    clear(r?: number, g?: number, b?: number, a?: number): void;
}

// Implementation of the framebuffer manager
const createFramebufferManager = (gl: WebGL2RenderingContext): FramebufferManager => {
    const defaultOptions: Required<FramebufferOptions> = {
        width: gl.canvas.width,
        height: gl.canvas.height,
        useDepthBuffer: false,
        minFilter: gl.LINEAR,
        magFilter: gl.LINEAR,
        wrapS: gl.CLAMP_TO_EDGE,
        wrapT: gl.CLAMP_TO_EDGE,
        internalFormat: gl.RGBA,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE
    };

    const createFramebuffer = (options: FramebufferOptions = {}): FramebufferObject => {
        const opts = { ...defaultOptions, ...options };
        const {
            width, height, useDepthBuffer, minFilter, magFilter,
            wrapS, wrapT, internalFormat, format, type
        } = opts;

        // Create framebuffer
        const framebuffer = gl.createFramebuffer();
        if (!framebuffer) throw new Error('Failed to create framebuffer');
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);

        // Create and setup texture
        const texture = gl.createTexture();
        if (!texture) throw new Error('Failed to create texture');

        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            internalFormat,
            width,
            height,
            0,
            format,
            type,
            null
        );

        // Set texture parameters
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);

        // Attach texture to framebuffer
        gl.framebufferTexture2D(
            gl.FRAMEBUFFER,
            gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D,
            texture,
            0
        );

        let depthBuffer: WebGLRenderbuffer | undefined;
        if (useDepthBuffer) {
            depthBuffer = gl.createRenderbuffer()!;
            if (!depthBuffer) throw new Error('Failed to create depth buffer');

            gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
            gl.renderbufferStorage(
                gl.RENDERBUFFER,
                gl.DEPTH_COMPONENT16,
                width,
                height
            );
            gl.framebufferRenderbuffer(
                gl.FRAMEBUFFER,
                gl.DEPTH_ATTACHMENT,
                gl.RENDERBUFFER,
                depthBuffer
            );
        }

        // Check framebuffer status
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error(`Framebuffer is not complete: ${status}`);
        }

        // Clear bindings
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);

        return { framebuffer, texture, depthBuffer, width, height };
    };

    const resizeFramebuffer = (fbo: FramebufferObject, width: number, height: number): void => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.framebuffer);

        // Resize texture
        gl.bindTexture(gl.TEXTURE_2D, fbo.texture);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            width,
            height,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            null
        );

        // Resize depth buffer if it exists
        if (fbo.depthBuffer) {
            gl.bindRenderbuffer(gl.RENDERBUFFER, fbo.depthBuffer);
            gl.renderbufferStorage(
                gl.RENDERBUFFER,
                gl.DEPTH_COMPONENT16,
                width,
                height
            );
        }

        // Update dimensions
        fbo.width = width;
        fbo.height = height;

        // Clear bindings
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    };

    const deleteFramebuffer = (fbo: FramebufferObject): void => {
        gl.deleteFramebuffer(fbo.framebuffer);
        gl.deleteTexture(fbo.texture);
        if (fbo.depthBuffer) {
            gl.deleteRenderbuffer(fbo.depthBuffer);
        }
    };

    const bindFramebuffer = (fbo: FramebufferObject | null): void => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo?.framebuffer || null);
    };

    const clear = (r: number = 0, g: number = 0, b: number = 0, a: number = 0): void => {
        gl.clearColor(r, g, b, a);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    };

    // Create main framebuffer
    const mainFramebuffer = createFramebuffer({
        width: gl.canvas.width,
        height: gl.canvas.height,
        useDepthBuffer: true
    });

    return {
        mainFramebuffer,
        createFramebuffer,
        resizeFramebuffer,
        deleteFramebuffer,
        bindFramebuffer,
        clear
    };
};

// Example resize handler
const handleResize = (ctx: WebGLContext) => {
    const { gl, framebufferManager } = ctx;
    const canvas = gl.canvas;

    // Update canvas size
    const displayWidth = Math.floor(canvas.width * window.devicePixelRatio);
    const displayHeight = Math.floor(canvas.height * window.devicePixelRatio);

    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

        // Resize main framebuffer
        framebufferManager.resizeFramebuffer(
            framebufferManager.mainFramebuffer,
            displayWidth,
            displayHeight
        );
    }
};

export interface WebGLContext {
    gl: WebGL2RenderingContext;
    programs: {
        framebuffer: WebGLProgram;
        outline: WebGLProgram;
        text: WebGLProgram;
    };
    framebufferManager: FramebufferManager;
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
    if (!gl) {
        console.error('WebGL not supported');
        return null;
    }

    // Shader program for drawing our framebuffer texture to a quad that covers the screen
    const framebufferVS = createShader(gl, gl.VERTEX_SHADER, framebufferVertexShaderSource)!;
    const framebufferFS = createShader(gl, gl.FRAGMENT_SHADER, framebufferFragmentShaderSource)!;
    const framebufferProg = createProgram(gl, framebufferVS, framebufferFS)!;

    // Shader program for drawing outlines to our framebuffer
    const outlineVS = createShader(gl, gl.VERTEX_SHADER, outlineVertexShaderSource)!;
    const outlineFS = createShader(gl, gl.FRAGMENT_SHADER, outlineFragShaderSource)!;
    const outlineProg = createProgram(gl, outlineVS, outlineFS)!;

    // Shader program for drawing text to our framebuffer
    const textVS = createShader(gl, gl.VERTEX_SHADER, textVertexShaderSource)!;
    const textFS = createShader(gl, gl.FRAGMENT_SHADER, textFragmentShaderSource)!;
    const textProg = createProgram(gl, textVS, textFS)!;

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

    // Create framebuffer manager
    const framebufferManager = createFramebufferManager(gl);
    console.log(framebufferManager);

    // Create WebGL context object
    return {
        gl: gl,
        programs: {
            framebuffer: framebufferProg,
            outline: outlineProg,
            text: textProg,
        },
        framebufferManager: framebufferManager
    };
};

// Initialize the full-screen quad buffer
function createFullscreenQuad(gl: WebGL2RenderingContext): WebGLBuffer {
    const positions = new Float32Array([
        -1.0, -1.0,
        1.0, -1.0,
        -1.0, 1.0,
        1.0, 1.0
    ]);

    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Failed to create buffer');

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    return buffer;
}

// Draw composite function that works with your FramebufferObject type
export function drawComposite(ctx: WebGLContext, sourceFBO: FramebufferObject): void {
    const { gl, programs } = ctx;
    const program = programs.framebuffer;

    // Use the framebuffer program
    gl.useProgram(program);

    // Ensure we have the quad buffer initialized
    if (!program.quadBuffer) {
        program.quadBuffer = createFullscreenQuad(gl);
        program.positionLocation = gl.getAttribLocation(program, 'position');
        program.textureLocation = gl.getUniformLocation(program, 'framebufferTexture')!;
    }

    // Set up the vertex attributes
    gl.bindBuffer(gl.ARRAY_BUFFER, program.quadBuffer);
    gl.enableVertexAttribArray(program.positionLocation!);
    gl.vertexAttribPointer(program.positionLocation!, 2, gl.FLOAT, false, 0, 0);

    // Bind the source framebuffer texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceFBO.texture);
    gl.uniform1i(program.textureLocation!, 0);

    // Draw the fullscreen quad
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Clean up state
    gl.disableVertexAttribArray(program.positionLocation!);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
}

// Augment WebGLProgram interface to include our custom properties
declare global {
    interface WebGLProgram {
        quadBuffer?: WebGLBuffer;
        positionLocation?: number;
        textureLocation?: WebGLUniformLocation;
    }
}// End of new WebGL based overlay for drawing outlines
