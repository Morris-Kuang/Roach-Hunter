// Entry point: builds the scene, wires vision -> controller -> motors ->
// render the simulated pursuit pipeline,
// and drives the animation loop.

import { clamp, norm, dist, resolveObstacles } from './utils.js';
import {
  HALF_W, HALF_D, MAX_SPEED, TURN_RATE, ROACH_POOL_SIZE, CAM_FOV_DEG,
  CAPTURE_SUCCESS_BASE, CAPTURE_SUCCESS_FLEEING_FACTOR,
  OBSTACLES, ROBOT_FOOTPRINT_RADIUS, CATCH_RADIUS,
  SWATTER_REST_ANGLE, SWATTER_STRIKE_ANGLE, CAPTURE_HOLD_TIME
} from './constants.js';
import { buildRoom } from './scene/room.js';
import { buildRobot } from './scene/robot.js';
import { Roach } from './scene/roach.js';
import { detectTarget } from './vision.js';
import { RoachHunterFSM } from './controller.js';
import { drawMapHud, drawCamHud } from './hud.js';
import { bindTelemetry } from './telemetry.js';
import { parseLocation, nearestLocation } from './chat.js';

function formatClock(simTime) {
  const mm = Math.floor(simTime / 60), ss = Math.floor(simTime % 60);
  return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
}

if (typeof THREE === 'undefined') {
  document.getElementById('log').textContent = 'Failed to load 3D engine.';
} else {
  boot();
}

function boot() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f0d);
  scene.fog = new THREE.Fog(0x0b0f0d, 6, 15);

  const { room } = buildRoom(scene);
  const { robotMesh, swatterPivot } = buildRobot(room);

  const effectPool = [];
  function spawnEffect(x, z) {
    // A squish mark, not a teleport ring: a flat, dark, slow-fading splat.
    const splat = new THREE.Mesh(
      new THREE.CircleGeometry(0.05, 20),
      new THREE.MeshBasicMaterial({ color: 0x3a1c10, transparent: true, opacity: 0.6, depthWrite: false })
    );
    splat.rotation.x = -Math.PI / 2;
    splat.position.set(x, 0.003, z);
    room.add(splat);
    effectPool.push({ mesh: splat, t: 0 });
  }

  // Swatter-paddle "mask" that drops straight down onto the locked target's
  // last-known spot for the duration of the CAPTURE hold, visually covering
  // it (success or miss alike -- a real swat always covers the target during
  // the attempt, it just doesn't always land clean). Fades away once the
  // state machine resolves the attempt.
  const COVER_DROP_Y = 0.32, COVER_LAND_Y = 0.018, COVER_FADE_TIME = 0.4;
  let coverMesh = null, coverFadeT = 0;
  function spawnCover(x, z) {
    if (coverMesh) { room.remove(coverMesh); coverMesh.geometry.dispose(); coverMesh.material.dispose(); }
    coverMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.13, 0.012, 0.11),
      new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.55, metalness: 0.15, transparent: true, opacity: 1 })
    );
    coverMesh.position.set(x, COVER_DROP_Y, z);
    coverMesh.castShadow = true;
    coverFadeT = 0;
    room.add(coverMesh);
  }
  function updateCover(dt) {
    if (!coverMesh) return;
    if (fsm.mode === 'CAPTURE') {
      const p = strikeProgress();
      coverMesh.position.y = COVER_DROP_Y + (COVER_LAND_Y - COVER_DROP_Y) * p;
    } else {
      coverFadeT += dt;
      coverMesh.material.opacity = clamp(1 - coverFadeT / COVER_FADE_TIME, 0, 1);
      if (coverFadeT >= COVER_FADE_TIME) {
        room.remove(coverMesh); coverMesh.geometry.dispose(); coverMesh.material.dispose(); coverMesh = null;
      }
    }
  }

  // ---- renderers / cameras ----
  const mapGl = document.getElementById('mapGl'), mapHud = document.getElementById('mapHud');
  const camGl = document.getElementById('camGl'), camHud = document.getElementById('camHud');
  const mapWrap = document.getElementById('mapWrap'), camWrap = document.getElementById('camWrap');

  const mapRenderer = new THREE.WebGLRenderer({ canvas: mapGl, antialias: true });
  // preserveDrawingBuffer: the onboard-cam feed gets screenshotted (see
  // captureCamSnapshot()) for the chat's lost-target photo. Without this,
  // the browser is free to clear/discard the WebGL drawing buffer right
  // after compositing, and reading it back via drawImage/toDataURL can come
  // back blank or garbled.
  const camRenderer = new THREE.WebGLRenderer({ canvas: camGl, antialias: true, preserveDrawingBuffer: true });
  [mapRenderer, camRenderer].forEach((r) => {
    if (r.outputEncoding !== undefined) r.outputEncoding = THREE.sRGBEncoding;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
  });

  const mapCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 40);
  const camCamera = new THREE.PerspectiveCamera(CAM_FOV_DEG, 1, 0.05, 30);

  const mapHudCtx = mapHud.getContext('2d');
  const camHudCtx = camHud.getContext('2d');

  function sizeCanvasPair(wrap, gl, hud, renderer) {
    const w = Math.max(1, wrap.clientWidth), h = Math.max(1, wrap.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    hud.width = Math.round(w * dpr); hud.height = Math.round(h * dpr);
    return { w, h, dpr };
  }
  let mapDims, camDims;
  function onResize() {
    mapDims = sizeCanvasPair(mapWrap, mapGl, mapHud, mapRenderer);
    camDims = sizeCanvasPair(camWrap, camGl, camHud, camRenderer);
    mapCamera.aspect = mapDims.w / mapDims.h; mapCamera.updateProjectionMatrix();
    camCamera.aspect = camDims.w / camDims.h; camCamera.updateProjectionMatrix();
  }
  window.addEventListener('resize', onResize);

  // ---- tip-line chat (floating widget, bottom-right) ----
  const chatFloat = document.getElementById('chatFloat');
  const chatFloatToggle = document.getElementById('chatFloatToggle');
  chatFloatToggle.addEventListener('click', () => chatFloat.classList.toggle('collapsed'));

  const chatLogEl = document.getElementById('chatLog');
  const chatForm = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');

  const WHO_LABEL = { user: 'YOU', robot: 'ROBOT' };
  function postChatMessage(who, text, imageDataUrl) {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + who;
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = '<span class="who">' + (WHO_LABEL[who] || who.toUpperCase()) + '<span class="ts">' + ts + '</span></span>'
      + (imageDataUrl ? '<img class="snap" src="' + imageDataUrl + '">' : '')
      + '<span class="txt"></span>';
    div.querySelector('.txt').textContent = text;
    chatLogEl.appendChild(div);
    chatLogEl.scrollTop = chatLogEl.scrollHeight;
    return div;
  }
  const postRobotMessage = (text, imageDataUrl) => postChatMessage('robot', text, imageDataUrl);

  // Composite the onboard-cam's WebGL render + its 2D HUD overlay (bounding
  // box, crosshair, scanline) into one still frame -- called right after a
  // render so the GL drawing buffer still holds this frame's pixels.
  function captureCamSnapshot() {
    const w = camGl.width, h = camGl.height;
    if (!w || !h) return null;
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d');
    octx.drawImage(camGl, 0, 0, w, h);
    octx.drawImage(camHud, 0, 0, w, h);
    return off.toDataURL('image/jpeg', 0.75);
  }

  // Record the lost location and report it locally with the camera snapshot.
  function handleTargetLost(targetId, simTime) {
    const place = nearestLocation(state.robot.x, state.robot.z);
    const roach = state.roaches.find((r) => r.id === targetId);
    state.lostPoints.push(roach ? { x: roach.x, z: roach.z } : { x: state.robot.x, z: state.robot.z });
    postRobotMessage(formatClock(simTime) + '，剛剛在' + place.zh + '附近跟丟了，正在找。', captureCamSnapshot());
  }

  function applyLocationReport(loc) {
    if (fsm.reportSighting(loc.x, loc.z)) {
      telemetry.log('TIP RECEIVED · heading to ' + loc.name, '', state.simTime);
      postRobotMessage('收到，我去' + loc.zh + '附近蹲點看看！');
      startPatrol();
    } else {
      postRobotMessage('現在正在追一隻真的看到的蟑螂，等這邊處理完再去看看。');
    }
  }

  // Recognize room landmarks locally; dispatch the simulated robot without a backend.
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    postChatMessage('user', text);
    chatInput.value = '';
    const loc = parseLocation(text);
    if (!loc) {
      postRobotMessage('沒聽懂是哪裡耶，可以講清楚一點嗎？像是床、床頭櫃、衣櫃、書桌、垃圾桶、或窗戶附近。');
      return;
    }
    applyLocationReport(loc);
    chatInput.focus();
  });

  // ---- telemetry / log / FSM ----
  const telemetry = bindTelemetry();
  const fsm = new RoachHunterFSM((from, to, targetId, tag) => {
    if (tag === 'SAFETY') { telemetry.log('HC-SR04 < 10cm · SAFETY STOP', 'warn', state.simTime); return; }
    if (to === 'TRACK') telemetry.log('TARGET ACQUIRED #' + targetId + ' · turning to center', '', state.simTime);
    else if (to === 'APPROACH') telemetry.log('TARGET CENTERED · approaching #' + targetId, '', state.simTime);
    else if (to === 'CAPTURE') {
      telemetry.log('CAPTURE RANGE #' + targetId + ' · gripper cycle', 'catch', state.simTime);
      const victim = state.roaches.find((r) => r.id === targetId);
      if (victim) spawnCover(victim.x, victim.z);
    }
    else if (to === 'RECOVER') {
      telemetry.log('TARGET LOST · recovering', 'warn', state.simTime);
      state._pendingLossEvent = { targetId, simTime: state.simTime };
    }
    else if (to === 'SEARCH' && from === 'RECOVER') telemetry.log('RECOVERY TIMEOUT · resuming scan', 'warn', state.simTime);
    else if (to === 'SEARCH' && from === 'STAKEOUT') {
      telemetry.log('STAKEOUT TIMED OUT · resuming patrol', 'warn', state.simTime);
      postRobotMessage(formatClock(state.simTime) + '，蹲點了一下子都沒看到，我先回去巡邏囉。');
    }
  });

  let state;
  function reset() {
    // tear down old roaches if re-running
    if (state) state.roaches.forEach((r) => room.remove(r.mesh));
    const roaches = [];
    for (let i = 0; i < ROACH_POOL_SIZE; i++) roaches.push(new Roach(i, room));
    state = {
      simTime: 0, running: false, everStarted: false,
      robot: { x: 0.4, z: 1.0, angle: Math.PI, battery: 100, caught: 0, missed: 0 },
      roaches, mode: 'SEARCH', lockedId: null,
      fpsSmooth: 60, last: performance.now(), charging: false,
      showHeatmap: false, lostPoints: [], caughtPoints: []
    };
    fsm.reset();
    telemetry.clearLog();
    telemetry.log('SYSTEM BOOT · sensor fusion online', '', 0);
    telemetry.log('STANDING BY · press START to begin patrol', '', 0);
  }

  // Progress through the swatter's downward strike, 0 (cocked) -> 1 (impact),
  // driven by the FSM's own capture-hold timer so the swing, the first-person
  // camera dip, and the CAPTURE state all resolve at exactly the same instant.
  function strikeProgress() {
    return fsm.mode === 'CAPTURE' ? clamp(1 - fsm.captureTimer / CAPTURE_HOLD_TIME, 0, 1) : 0;
  }

  function updateSwatterAndCamera(dt) {
    const rb = state.robot;
    const p = strikeProgress();
    const eased = p * p; // quick snap into the strike rather than a linear swing
    swatterPivot.rotation.z = SWATTER_REST_ANGLE + (SWATTER_STRIKE_ANGLE - SWATTER_REST_ANGLE) * eased;

    mapCamera.position.set(0.3, 10.2, 3.6);
    mapCamera.lookAt(0.2, 0, -0.4);

    const fx = Math.cos(rb.angle), fz = Math.sin(rb.angle);
    const eyeX = rb.x + fx * 0.30, eyeZ = rb.z + fz * 0.30;
    // Normal cruise: look ahead and slightly down. Mid-strike: dive to look
    // at the ground right in front of the chassis, where the paddle lands --
    // this is the "first-person view of striking down" the swat needs.
    const lookX = eyeX + fx * (2 - 1.8 * eased);
    const lookY = 0.02 - 0.16 * eased;
    const lookZ = eyeZ + fz * (2 - 1.8 * eased);
    camCamera.position.set(eyeX, 0.16 - 0.05 * eased, eyeZ);

    let shakeX = 0, shakeY = 0;
    if (state.captureFx) {
      const elapsed = state.simTime - state.captureFx.startTime;
      if (elapsed >= 0 && elapsed < 0.15) {
        const k = (1 - elapsed / 0.15) * 0.02;
        shakeX = (Math.random() * 2 - 1) * k;
        shakeY = (Math.random() * 2 - 1) * k;
      }
    }
    camCamera.lookAt(lookX + shakeX, lookY + shakeY, lookZ);
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - state.last) / 1000);
    state.last = now;

    updateWorld(dt); // roaches live their own life regardless of patrol state
    if (state.running) step(dt);

    robotMesh.position.set(state.robot.x, 0, state.robot.z);
    robotMesh.rotation.y = -state.robot.angle;
    effectPool.forEach((e) => { e.t += dt; e.mesh.material.opacity = Math.max(0, 0.6 - e.t * 0.35); });
    for (let i = effectPool.length - 1; i >= 0; i--) {
      if (effectPool[i].t > 1.6) { room.remove(effectPool[i].mesh); effectPool[i].mesh.geometry.dispose(); effectPool[i].mesh.material.dispose(); effectPool.splice(i, 1); }
    }
    updateSwatterAndCamera(dt);
    updateCover(dt);

    mapRenderer.render(scene, mapCamera);
    camRenderer.render(scene, camCamera);

    const detection = state._lastDetection || null;
    drawMapHud(mapHudCtx, mapHud, mapDims, mapCamera, state);
    drawCamHud(camHudCtx, camHud, camDims, camCamera, state, detection);
    telemetry.update(state, state._lastCommand || { turn: 0, speed: 0 }, detection, state._lastWallCm || 999, dt);

    // A target-lost event is detected inside step() (via the FSM's onLog
    // callback), which runs *before* this frame's render + HUD draw above --
    // capturing a screenshot there would grab last frame's (or an empty)
    // buffer. Queue it and take the photo only now, once this frame's cam
    // view is actually on screen.
    if (state._pendingLossEvent) {
      const ev = state._pendingLossEvent;
      state._pendingLossEvent = null;
      handleTargetLost(ev.targetId, ev.simTime);
    }

    requestAnimationFrame(frame);
  }

  // Shared by the vision-driven CAPTURE state and the physical contact
  // fallback below -- either way, a grab isn't guaranteed.
  function attemptCapture(victim, s, rb) {
    const wasFleeing = victim.state === 'fleeing';
    const chance = CAPTURE_SUCCESS_BASE * (wasFleeing ? CAPTURE_SUCCESS_FLEEING_FACTOR : 1);
    const place = nearestLocation(victim.x, victim.z);
    const success = Math.random() < chance;

    if (success) {
      victim.markCaught();
      rb.caught = (rb.caught || 0) + 1;
      spawnEffect(victim.x, victim.z);
      state.caughtPoints.push({ x: victim.x, z: victim.z });
      state.captureFx = { result: 'success', startTime: s.simTime };
      telemetry.log('CAPTURE SUCCESS · roach #' + victim.id + ' squashed', 'catch', s.simTime);
    } else {
      rb.missed = (rb.missed || 0) + 1;
      state.captureFx = { result: 'fail', startTime: s.simTime };
      telemetry.log('CAPTURE ATTEMPT MISSED · target bolted', 'warn', s.simTime);
      if (!wasFleeing) victim.startle();
    }

    describeCaptureOutcome(place, s.simTime, success);
  }

  // Describe capture results directly from the simulation state.
  function describeCaptureOutcome(place, simTime, success) {
    postRobotMessage(formatClock(simTime) + '，在' + place.zh + '附近'
      + (success ? '抓到了！蟑螂處理掉了。' : '差一點點，還是讓牠跑掉了。'));
  }

  // Roach behavior (foraging, hiding, fleeing) -- runs every frame regardless
  // of whether the robot's patrol is active. A real bedroom's roaches don't
  // wait for the hunter to be switched on, and freezing them during
  // ROBOT STANDBY (or while PAUSEd) made the whole room look switched off.
  function updateWorld(dt) {
    const s = state, rb = s.robot;
    s.simTime += dt;

    s.roaches.forEach((r) => {
      const event = r.update(dt, s.simTime, rb);
      if (!event) return;
      // Counts every roach that got away, not just the one currently locked
      // (the Missed/Escaped/Lost stat tile is a hunt-wide tally).
      if (event === 'escaped') rb.escaped = (rb.escaped || 0) + 1;
      else if (event === 'retreated') rb.lost = (rb.lost || 0) + 1;
      if (r.id !== fsm.lockedId) return;
      if (event === 'startled') telemetry.log('TARGET #' + r.id + ' STARTLED · bolting for ' + r.fleeTarget.name, 'warn', s.simTime);
      else if (event === 'escaped') telemetry.log('TARGET #' + r.id + ' ESCAPED · lost near ' + r.fleeTarget.name, 'warn', s.simTime);
      else if (event === 'retreated') telemetry.log('TARGET #' + r.id + ' LOST · slipped back into hiding', 'warn', s.simTime);
    });
  }

  function step(dt) {
    const s = state, rb = s.robot;

    // 1. Vision: "ESP32-CAM -> Object detection on laptop"
    const detection = detectTarget(camCamera, rb, s.roaches, fsm.lockedId);

    // 2/3/4. Controller + state machine + ultrasonic safety
    const wallCm = telemetry.ultrasonicCm(rb);
    rb.battery -= dt * (1.1 + (state._lastCommand ? state._lastCommand.speed / MAX_SPEED : 0) * 0.85);
    if (rb.battery <= 18 && !s.charging) { s.charging = true; telemetry.log('BATTERY LOW (' + Math.round(rb.battery) + '%) · returning to dock', 'warn', s.simTime); }
    if (rb.battery <= 0) { rb.battery = 100; s.charging = false; telemetry.log('RECHARGE COMPLETE · resuming patrol', 'catch', s.simTime); }

    const command = fsm.step(dt, detection, wallCm, rb);
    s.mode = fsm.mode;
    s.lockedId = fsm.lockedId;

    // 5. Motors: apply the commanded turn + forward speed
    rb.angle = norm(rb.angle + clamp(command.turn, -TURN_RATE, TURN_RATE) * dt);
    rb.x += Math.cos(rb.angle) * command.speed * dt;
    rb.z += Math.sin(rb.angle) * command.speed * dt;
    rb.x = clamp(rb.x, -HALF_W + 0.3, HALF_W - 0.3);
    rb.z = clamp(rb.z, -HALF_D + 0.3, HALF_D - 0.3);

    // The chassis is solid too -- furniture blocks it exactly like a roach.
    const rbResolved = resolveObstacles(rb.x, rb.z, ROBOT_FOOTPRINT_RADIUS, OBSTACLES);
    rb.x = rbResolved.x; rb.z = rbResolved.z;

    if (command.captured) {
      const target = s.roaches.find((r) => detection && r.id === detection.id);
      const victim = target || s.roaches.reduce((a, b) => (dist(rb.x, rb.z, b.x, b.z) < dist(rb.x, rb.z, a.x, a.z) ? b : a));
      if (victim && victim.alive) {
        attemptCapture(victim, s, rb);
        // We just resolved a capture attempt against this exact roach this
        // frame (vision-driven path). Disarm the contact-fallback below for
        // it so it doesn't immediately roll a *second* attempt on the same
        // roach in the same tick just because it's still standing within
        // CATCH_RADIUS right after a miss -- that produced two contradictory
        // outcomes (one miss, one hit) stamped at the identical sim time.
        victim._contactArmed = false;
      } else {
        // Gripper cycled on empty air -- the target slipped away mid-hold.
        // Still a failed attempt, so it still counts as a miss.
        rb.missed = (rb.missed || 0) + 1;
        state.captureFx = { result: 'fail', startTime: s.simTime };
        telemetry.log('CAPTURE ATTEMPT MISSED · target already gone', 'warn', s.simTime);
      }
    }

    // Physical contact fallback: a roach that wanders into the chassis from
    // the side or behind -- outside the onboard camera's view -- still gets
    // a shot at being grabbed, exactly once per contact (a real bumper/gripper
    // switch doesn't care what the camera was pointed at). One attempt per
    // contact episode, tracked per-roach so standing on top of it doesn't
    // spam retries every frame.
    s.roaches.forEach((r) => {
      if (!r.alive) { r._contactArmed = true; return; }
      const inContact = dist(rb.x, rb.z, r.x, r.z) < CATCH_RADIUS;
      if (inContact && r._contactArmed) {
        r._contactArmed = false;
        attemptCapture(r, s, rb);
      } else if (!inContact) {
        r._contactArmed = true;
      }
    });

    state._lastDetection = detection;
    state._lastCommand = command;
    state._lastWallCm = wallCm;
  }

  // Shared by the START/RESUME button and an incoming chat tip -- reporting
  // a sighting should actually make the robot go, not just change its FSM
  // mode while the patrol loop stays switched off waiting for a button click.
  function startPatrol() {
    if (state.running) return;
    const firstStart = !state.everStarted;
    state.running = true;
    state.everStarted = true;
    telemetry.els.pauseBtn.textContent = 'PAUSE';
    telemetry.els.sysPill.textContent = 'ROBOT ONLINE';
    telemetry.log(firstStart ? 'PATROL STARTED · no targets in view yet' : 'RESUME · patrol continuing', '', state.simTime);
  }

  telemetry.els.pauseBtn.addEventListener('click', () => {
    if (state.running) {
      state.running = false;
      telemetry.els.pauseBtn.textContent = 'RESUME';
      telemetry.els.sysPill.textContent = 'ROBOT PAUSED';
      telemetry.log('PAUSED · holding position', '', state.simTime);
    } else {
      startPatrol();
    }
  });
  telemetry.els.resetBtn.addEventListener('click', () => {
    reset();
    telemetry.els.pauseBtn.textContent = 'START';
    telemetry.els.sysPill.textContent = 'ROBOT STANDBY';
    heatmapBtn.classList.remove('active');
  });

  // Infestation heatmap: red = where roaches tend to vanish from (lost
  // points), green = where they actually get caught -- accumulated for the
  // whole session, cleared on RESET along with everything else.
  const heatmapBtn = document.getElementById('heatmapBtn');
  heatmapBtn.addEventListener('click', () => {
    state.showHeatmap = !state.showHeatmap;
    heatmapBtn.classList.toggle('active', state.showHeatmap);
  });

  onResize();
  reset();
  state.last = performance.now();
  requestAnimationFrame(frame);
}
