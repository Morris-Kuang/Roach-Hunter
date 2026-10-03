// Canvas HUD overlays drawn on top of each WebGL panel: target boxes,
// crosshair, scanline sweep, and corner readouts.

import { projectToScreen, segmentBlocked } from './utils.js';
import { OBSTACLES } from './constants.js';

export function drawMapHud(ctx, hud, dims, camera, state) {
  const w = hud.width, h = hud.height, dpr = dims.dpr || 1;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(78,230,160,.35)';
  ctx.lineWidth = 2 * dpr;
  ctx.strokeRect(1, 1, w - 2, h - 2);

  state.roaches.forEach((r) => {
    if (!r.alive) return;
    const p = projectToScreen(camera, new THREE.Vector3(r.x, 0.08, r.z), w, h);
    if (!p) return;
    const isLocked = state.lockedId === r.id;
    ctx.strokeStyle = isLocked ? '#ff5c66' : 'rgba(78,230,160,.7)';
    ctx.lineWidth = 1.4 * dpr;
    const sz = 26 * dpr;
    ctx.strokeRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
    if (isLocked) {
      ctx.font = (10 * dpr) + 'px "IBM Plex Mono", monospace';
      ctx.fillStyle = '#ff5c66';
      ctx.fillText('#' + r.id, p.x - sz / 2, p.y - sz / 2 - 4);
    }
  });

  const rp = projectToScreen(camera, new THREE.Vector3(state.robot.x, 0.12, state.robot.z), w, h);
  if (rp) {
    ctx.strokeStyle = 'rgba(78,230,160,.9)';
    ctx.lineWidth = 1.4 * dpr;
    const s = 20 * dpr;
    ctx.beginPath();
    ctx.moveTo(rp.x - s, rp.y); ctx.lineTo(rp.x + s, rp.y);
    ctx.moveTo(rp.x, rp.y - s); ctx.lineTo(rp.x, rp.y + s);
    ctx.stroke();
  }
}

export function drawCamHud(ctx, hud, dims, camera, state, detection) {
  const w = hud.width, h = hud.height, dpr = dims.dpr || 1;
  ctx.clearRect(0, 0, w, h);

  const visible = [];
  state.roaches.forEach((r) => {
    if (!r.alive) return;
    // Same no-X-ray rule as the actual detector (vision.js) -- the onboard
    // feed can't show a box around something it's physically blocked from
    // seeing, even if it's within the frustum.
    if (segmentBlocked(camera.position.x, camera.position.z, r.x, r.z, OBSTACLES)) return;
    const p = projectToScreen(camera, new THREE.Vector3(r.x, 0.07, r.z), w, h, 1.05);
    if (!p) return;
    visible.push({ r, p });
  });

  // scanline sweep
  const sweepY = ((state.simTime * 70 * dpr) % (h + 40 * dpr)) - 20 * dpr;
  const grad = ctx.createLinearGradient(0, sweepY - 16 * dpr, 0, sweepY + 16 * dpr);
  grad.addColorStop(0, 'rgba(78,230,160,0)');
  grad.addColorStop(0.5, 'rgba(78,230,160,.10)');
  grad.addColorStop(1, 'rgba(78,230,160,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, sweepY - 16 * dpr, w, 32 * dpr);

  visible.forEach(({ r, p }) => {
    const isLocked = state.lockedId === r.id;
    const det = isLocked ? detection : null;
    const size = det ? det.bboxSize : 0.01;
    const conf = det ? det.confidence : 0.4;
    const bw = Math.max(18 * dpr, Math.sqrt(size) * w * 1.15);
    const bh = Math.max(14 * dpr, Math.sqrt(size) * h * 1.15);
    ctx.strokeStyle = isLocked ? '#ff5c66' : '#4ee6a0';
    ctx.lineWidth = 1.6 * dpr;
    ctx.strokeRect(p.x - bw / 2, p.y - bh / 2, bw, bh);
    const label = (isLocked ? 'LOCK ' : 'ROACH ') + Math.round(conf * 100) + '%';
    ctx.font = '600 ' + (10 * dpr) + 'px "IBM Plex Mono", monospace';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillRect(p.x - bw / 2, p.y - bh / 2 - 14 * dpr, tw + 8 * dpr, 14 * dpr);
    ctx.fillStyle = '#04120a';
    ctx.fillText(label, p.x - bw / 2 + 4 * dpr, p.y - bh / 2 - 3 * dpr);
  });

  // crosshair
  ctx.strokeStyle = 'rgba(205,245,225,.5)';
  ctx.lineWidth = 1 * dpr;
  const ccx = w / 2, ccy = h * 0.5;
  ctx.beginPath();
  ctx.moveTo(ccx - 9 * dpr, ccy); ctx.lineTo(ccx - 3 * dpr, ccy);
  ctx.moveTo(ccx + 3 * dpr, ccy); ctx.lineTo(ccx + 9 * dpr, ccy);
  ctx.moveTo(ccx, ccy - 9 * dpr); ctx.lineTo(ccx, ccy - 3 * dpr);
  ctx.moveTo(ccx, ccy + 3 * dpr); ctx.lineTo(ccx, ccy + 9 * dpr);
  ctx.stroke();

  ctx.font = '500 ' + (10.5 * dpr) + 'px "IBM Plex Mono", monospace';
  ctx.fillStyle = 'rgba(205,245,225,.75)';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('ESP32-CAM · OV2640  320x240', 10 * dpr, 10 * dpr);
  ctx.fillText('MODE ' + state.mode, 10 * dpr, 24 * dpr);
  ctx.textAlign = 'right';
  ctx.fillText('HEADING ' + Math.round(((state.robot.angle * 180 / Math.PI) + 360) % 360) + '°', w - 10 * dpr, 10 * dpr);
  ctx.fillText('TARGETS ' + visible.length, w - 10 * dpr, 24 * dpr);
  ctx.textAlign = 'left';

  drawCaptureOverlay(ctx, w, h, dpr, state);
}

function drawCaptureOverlay(ctx, w, h, dpr, state) {
  if (state.mode === 'CAPTURE') {
    const pulse = 0.12 + Math.abs(Math.sin(state.simTime * 14)) * 0.12;
    ctx.strokeStyle = 'rgba(255,92,102,' + pulse.toFixed(2) + ')';
    ctx.lineWidth = 10 * dpr;
    ctx.strokeRect(5 * dpr, 5 * dpr, w - 10 * dpr, h - 10 * dpr);
    ctx.font = '700 ' + (15 * dpr) + 'px "IBM Plex Mono", monospace';
    ctx.fillStyle = '#ff5c66';
    ctx.textAlign = 'center';
    ctx.fillText('STRIKE', w / 2, 12 * dpr);
    ctx.textAlign = 'left';
  }

  const fx = state.captureFx;
  if (!fx) return;
  const elapsed = state.simTime - fx.startTime;
  const DECAY = 0.55;
  if (elapsed < 0 || elapsed > DECAY) return;
  const alpha = 1 - elapsed / DECAY;
  const isHit = fx.result === 'success';
  ctx.fillStyle = (isHit ? 'rgba(78,230,160,' : 'rgba(255,92,102,') + (alpha * 0.28).toFixed(2) + ')';
  ctx.fillRect(0, 0, w, h);
  ctx.font = '700 ' + (22 * dpr) + 'px "IBM Plex Mono", monospace';
  ctx.fillStyle = isHit ? '#4ee6a0' : '#ff5c66';
  ctx.globalAlpha = Math.min(1, alpha * 1.6);
  ctx.textAlign = 'center';
  ctx.fillText(isHit ? 'SQUASHED' : 'MISSED', w / 2, h * 0.42);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}
