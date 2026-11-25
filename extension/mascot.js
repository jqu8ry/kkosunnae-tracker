for (const slot of document.querySelectorAll(".live-mascot-slot")) {
  slot.append(document.getElementById("live-mascot-template").content.cloneNode(true));
}

// Deform only the muzzle and touching tail. Pixels above and below that band stay fixed.
function drawChew(ctx, source, x, left, top, scale, pose) {
  const upper = Math.round(top + 205 * scale);
  const bite = Math.round(top + 265 * scale);
  const lower = Math.round(top + 355 * scale);
  for (let col = 0; col < source.width; col++) {
    const distance = ((col - left) / scale - 230) / 115;
    const weight = Math.max(0, 1 - distance * distance);
    const shift = Math.round(pose * .68 * weight * weight);
    if (!shift) continue;
    ctx.clearRect(x + col, upper, 1, lower - upper);
    ctx.drawImage(source, col, upper, 1, bite - upper, x + col, upper, 1, bite - upper + shift);
    ctx.drawImage(source, col, bite, 1, lower - bite, x + col, bite + shift, 1, lower - bite - shift);
  }
}
// Bend the paw toward the shoulder while keeping every scanline in source order.
function drawWave(ctx, pixels, frameX, left, top, scale, phase) {
  if (!phase) return;
  const {width, height, data} = pixels;
  const frame = new ImageData(new Uint8ClampedArray(data), width, height);
  const swing = Math.sin(phase * Math.PI / 2) * (phase < 0 ? .19 : .115);
  const shoulderY = top + 374 * scale;
  const pawEdge = left + 126 * scale;
  const faceEdge = left + 165 * scale;
  for (let y = 0; y < height && y < shoulderY; y++) {
    const reach = shoulderY - y;
    const t = Math.min(1, reach / (75 * scale));
    const shift = Math.max(-35 * scale, Math.min(24 * scale, reach * swing * t * t * (3 - 2 * t)));
    const movedEdge = pawEdge + shift;
    for (let x = 0; x < faceEdge; x++) {
      // A one-to-one mapping up to the fixed face edge keeps its outline out of the gap.
      const sx = x <= movedEdge ? x - shift :
        pawEdge + (x - movedEdge) * (faceEdge - pawEdge) / (faceEdge - movedEdge);
      const x0 = Math.floor(sx), fraction = sx - x0;
      const dest = (y * width + x) * 4;
      const src = (y * width + x0) * 4;
      const a = x0 >= 0 && x0 < width ? data[src + 3] * (1 - fraction) : 0;
      const b = x0 + 1 >= 0 && x0 + 1 < width ? data[src + 7] * fraction : 0;
      for (let c = 0; c < 3; c++) {
        frame.data[dest + c] = a + b ? ((a ? data[src+c]*a : 0) + (b ? data[src+4+c]*b : 0)) / (a+b) : 0;
      }
      frame.data[dest + 3] = a + b;
    }
  }
  ctx.putImageData(frame, frameX, 0);
}

const motionAllowed = matchMedia("(prefers-reduced-motion: no-preference)");
async function makePoses(container) {
  const poster = container.querySelector("svg");
  const image = new Image();
  image.src = poster.querySelector("image").getAttribute("href");
  const crop = poster.viewBox.baseVal;
  const width = 196;
  const height = Math.round(width * container.clientHeight / container.clientWidth);
  if (!Number.isFinite(height) || height <= 0) return;
  await image.decode();
  if (container.querySelector("canvas")) return;
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const scale = Math.min(width / crop.width, height / crop.height);
  const left = (width - crop.width * scale) / 2 - crop.x * scale;
  const top = height - (crop.y + crop.height) * scale;
  const sourceCtx = source.getContext("2d");
  sourceCtx.drawImage(image, left, top, image.width * scale, image.height * scale);
  const chewing = container.classList.contains("chewing-cat");
  const half = chewing ? 6 : 10;
  const pixels = chewing ? null : sourceCtx.getImageData(0, 0, width, height);

  const strip = document.createElement("canvas");
  strip.width = width * (half * 2 + 1);
  strip.height = height;
  const ctx = strip.getContext("2d");
  for (let pose = -half; pose <= half; pose++) {
    const x = (pose + half) * width;
    ctx.drawImage(source, x, 0);
    if (chewing) {
      drawChew(ctx, source, x, left, top, scale, pose);
    } else {
      drawWave(ctx, pixels, x, left, top, scale, pose / half);
    }
  }
  container.append(strip);
}

const visible = new IntersectionObserver(entries => {
  for (const {target, isIntersecting} of entries) {
    if (!isIntersecting || !motionAllowed.matches || target.querySelector("canvas")) continue;
    visible.unobserve(target);
    void makePoses(target).catch(() => {}); // The original, static illustration stays visible.
  }
});
function observeMascots() {
  visible.disconnect();
  if (motionAllowed.matches) {
    for (const el of document.querySelectorAll(":is(.waving-cat,.chewing-cat):not(:has(canvas))")) visible.observe(el);
  }
}
motionAllowed.addEventListener("change", observeMascots);
observeMascots();
