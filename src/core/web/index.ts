import { recalcOutlines } from './outline';
import { createElement } from './utils';

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
