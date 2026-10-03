// DOM bindings for the stat tiles and event log.

import { clamp, fmt } from './utils.js';
import { HALF_W, HALF_D, MAX_SPEED } from './constants.js';

export function bindTelemetry() {
  const els = {
    battery: document.getElementById('statBattery'), batteryBar: document.getElementById('batteryBar'),
    caught: document.getElementById('statCaught'), missed: document.getElementById('statMissed'),
    targets: document.getElementById('statTargets'),
    mode: document.getElementById('statMode'),
    ultrasonic: document.getElementById('statUltrasonic'),
    pwmL: document.getElementById('statPwmL'), pwmR: document.getElementById('statPwmR'),
    conf: document.getElementById('statConf'), bbox: document.getElementById('statBbox'),
    rpm: document.getElementById('statRpm'), rssi: document.getElementById('statRssi'),
    latency: document.getElementById('statLatency'), fps: document.getElementById('statFps'),
    log: document.getElementById('log'), mapBadge: document.getElementById('mapBadge'),
    uptime: document.getElementById('uptime'), sysPill: document.getElementById('sysPill'),
    pauseBtn: document.getElementById('pauseBtn'), resetBtn: document.getElementById('resetBtn')
  };

  let logEntries = [];

  function log(msg, level, simTime) {
    const t0 = simTime || 0;
    const mm = Math.floor(t0 / 60), ss = Math.floor(t0 % 60);
    const stamp = (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
    logEntries.unshift({ t: stamp, m: msg, level: level || '' });
    if (logEntries.length > 40) logEntries.length = 40;
    els.log.innerHTML = logEntries.map((e) =>
      `<div class="entry ${e.level}"><span class="t">${e.t}</span><span class="m">${e.m}</span></div>`
    ).join('');
  }

  function clearLog() { logEntries = []; els.log.innerHTML = ''; }

  /** Wall-raycast the HC-SR04 reading (cm) along the robot's current heading. */
  function ultrasonicCm(robot) {
    const cx = Math.cos(robot.angle), cz = Math.sin(robot.angle);
    const tX = cx >= 0 ? (HALF_W - robot.x) / Math.max(cx, 1e-4) : (-HALF_W - robot.x) / Math.min(cx, -1e-4);
    const tZ = cz >= 0 ? (HALF_D - robot.z) / Math.max(cz, 1e-4) : (-HALF_D - robot.z) / Math.min(cz, -1e-4);
    return Math.max(0, Math.min(tX, tZ)) * 100;
  }

  /** command: {turn, speed} the controller output for this frame; detection: current vision result or null */
  function update(state, command, detection, wallCm, dt) {
    const rb = state.robot;
    const frameFps = 1 / Math.max(dt, 0.0001);
    state.fpsSmooth += (frameFps - state.fpsSmooth) * 0.08;

    // Differential-drive PWM per wheel: base speed +/- the steering term, per
    // docs/movement-algorithm.md M3 ("left_speed = base + turn, right_speed = base - turn").
    const baseDuty = clamp(command.speed / MAX_SPEED, 0, 1) * 100;
    const turnDuty = clamp(command.turn / MAX_SPEED, -1, 1) * 35;
    const pwmL = clamp(baseDuty + turnDuty, 0, 100);
    const pwmR = clamp(baseDuty - turnDuty, 0, 100);

    const activeTargets = state.roaches.filter((r) => r.alive).length;

    els.battery.textContent = fmt(rb.battery, 0) + '%';
    els.battery.className = 'val' + (rb.battery < 18 ? ' crit' : rb.battery < 40 ? ' warn' : '');
    els.batteryBar.style.width = clamp(rb.battery, 0, 100) + '%';
    els.batteryBar.style.background = rb.battery < 18 ? 'var(--danger)' : rb.battery < 40 ? 'var(--amber)' : 'var(--accent)';
    els.caught.textContent = rb.caught;
    els.missed.textContent = (rb.missed || 0) + (rb.escaped || 0) + (rb.lost || 0);
    els.targets.textContent = activeTargets;
    els.mode.textContent = state.mode;
    els.mode.className = 'val' + (state.mode === 'RECOVER' ? ' warn' : state.mode === 'CAPTURE' ? ' crit' : '');
    els.ultrasonic.textContent = fmt(wallCm, 0) + ' cm';
    els.pwmL.textContent = fmt(pwmL, 0) + '%';
    els.pwmR.textContent = fmt(pwmR, 0) + '%';
    els.conf.textContent = detection ? fmt(detection.confidence * 100, 0) + '%' : '--%';
    els.bbox.textContent = detection ? fmt(detection.bboxSize * 100, 1) + '%' : '--%';
    els.rpm.textContent = fmt(command.speed * 640, 0);
    els.rssi.textContent = fmt(-46 + Math.sin(state.simTime * 1.3) * 3, 0) + ' dBm';
    els.latency.textContent = fmt(19 + Math.sin(state.simTime * 2.1) * 6 + Math.random() * 3, 0) + ' ms';
    els.fps.textContent = fmt(state.fpsSmooth, 0);
    els.mapBadge.textContent = activeTargets + ' target' + (activeTargets === 1 ? '' : 's') + ' tracked';

    const mm = Math.floor(state.simTime / 60), ss = Math.floor(state.simTime % 60);
    const hh = Math.floor(mm / 60);
    els.uptime.textContent = 'UPTIME ' + [hh, mm % 60, ss].map((v) => (v < 10 ? '0' : '') + v).join(':');
  }

  return { els, log, clearLog, ultrasonicCm, update };
}
