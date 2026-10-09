import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { loadMixamoAnimation } from "./loadMixamoAnimation.js";

// --- Config -----------------------------------------------------------------

const ANIMATION_NAMES = [
  "idle",
  "thinking",
  "talking",
  "dance",
  "fall-flat",
  "stand-up",
];

// stand-up begins with ~3s of lying still; skip ahead and speed it up.
const STANDUP_START = 2.5;
const STANDUP_TIME_SCALE = 1.6;
const CROSSFADE_DURATION = 0.4;

// --- Module state -----------------------------------------------------------

const canvas = document.getElementById("canvas");
const overlay = document.getElementById("overlay");

let renderer;
let scene;
let camera;
let clock;

let currentVrm = null;
let mixer = null;

// Clip registry — keyed by animation name. Used by later milestones too.
const clips = {};
// Actions created lazily from clips on the single mixer.
const actions = {};

let idleAction = null;
let introPlayed = false;

// Shared AudioContext, unlocked on first click (no sound in M1).
let audioContext = null;

// Blink timing.
let nextBlinkAt = 0;
let blinkStart = -1;
const BLINK_DURATION = 0.12; // seconds, ramp up and back down

// --- Boot -------------------------------------------------------------------

init();

async function init() {
  // Fetch character settings and apply the gradient background.
  let character;
  try {
    character = await (await fetch("/character.json")).json();
    applyBackground(character.background);
  } catch (err) {
    console.error("Failed to load character.json", err);
    character = { avatar: "/avatars/CoolPineapple.vrm" };
  }

  setupThree();
  await loadAvatar(character.avatar);

  overlay.addEventListener("click", onStart, { once: true });

  animate();
}

function applyBackground(background) {
  if (Array.isArray(background) && background.length === 2) {
    document.documentElement.style.setProperty("--bg-top", background[0]);
    document.documentElement.style.setProperty("--bg-bottom", background[1]);
  }
}

function setupThree() {
  // alpha:true so the CSS gradient shows through.
  renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(
    30,
    window.innerWidth / window.innerHeight,
    0.1,
    20,
  );
  // Default framing (spec values); refined per-avatar by frameAvatar() once the
  // VRM is loaded and its real bounding box is known.
  camera.position.set(0, 1.0, 4.0);
  camera.lookAt(0, 0.75, 0);

  const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
  dirLight.position.set(1, 2, 2);
  scene.add(dirLight);

  const ambLight = new THREE.AmbientLight(0xffffff, 1.0);
  scene.add(ambLight);

  clock = new THREE.Clock();

  window.addEventListener("resize", onResize);
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

async function loadAvatar(avatarUrl) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const gltf = await loader.loadAsync(avatarUrl);
  const vrm = gltf.userData.vrm;

  // VRM 0.x faces away by default; rotate it to face the camera.
  VRMUtils.rotateVRM0(vrm);

  vrm.scene.traverse((obj) => {
    obj.frustumCulled = false;
  });

  currentVrm = vrm;
  scene.add(vrm.scene);

  // Frame the camera to this avatar's actual size (heights vary per VRM, so a
  // fixed look-at point leaves some models off-center/too high).
  frameAvatar(vrm);

  // Single AnimationMixer on vrm.scene, used for every clip.
  mixer = new THREE.AnimationMixer(vrm.scene);

  await preloadClips(vrm);

  // Start idle immediately (visible under the overlay).
  idleAction = getAction("idle");
  idleAction.reset().setLoop(THREE.LoopRepeat, Infinity).play();

  // Prime the blink timer.
  nextBlinkAt = clock.getElapsedTime() + randomBlinkDelay();
}

// Center the camera on the avatar's full body, whatever the model's height.
// VRM bounding boxes are unreliable (bind-pose / culling bounds), so frame off
// the humanoid bones: head gives the top, feet give the bottom.
function frameAvatar(vrm) {
  vrm.scene.updateWorldMatrix(true, true);

  const humanoid = vrm.humanoid;
  const tmp = new THREE.Vector3();

  const getBoneY = (name) => {
    const node = humanoid?.getNormalizedBoneNode(name);
    if (!node) return null;
    node.getWorldPosition(tmp);
    return tmp.y;
  };
  const getBoneX = (name) => {
    const node = humanoid?.getNormalizedBoneNode(name);
    if (!node) return null;
    node.getWorldPosition(tmp);
    return tmp.x;
  };

  // Top of head and the lower of the two feet, with small padding for scalp
  // above the head bone and the sole below the foot bone.
  const headY = getBoneY("head");
  const leftFootY = getBoneY("leftFoot");
  const rightFootY = getBoneY("rightFoot");
  const hipsX = getBoneX("hips");

  let topY, bottomY, centerX;
  if (headY != null && (leftFootY != null || rightFootY != null)) {
    const feetY = Math.min(
      leftFootY != null ? leftFootY : Infinity,
      rightFootY != null ? rightFootY : Infinity,
    );
    topY = headY + 0.15; // scalp above the head bone
    bottomY = feetY - 0.05; // sole below the foot bone
    centerX = hipsX != null ? hipsX : 0;
  } else {
    // Fallback to bounding box if the humanoid bones aren't available.
    const box = new THREE.Box3().setFromObject(vrm.scene);
    if (box.isEmpty()) return;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    topY = center.y + size.y / 2;
    bottomY = center.y - size.y / 2;
    centerX = center.x;
  }

  const height = topY - bottomY;
  const centerY = (topY + bottomY) / 2;

  // Distance to fit the full height in the vertical FOV, plus a small margin.
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const distance = (height / 2 / Math.tan(fov / 2)) * 1.15;

  camera.position.set(centerX, centerY, distance);
  camera.lookAt(centerX, centerY, 0);
  camera.updateProjectionMatrix();
}

async function preloadClips(vrm) {
  // Preload all six clips into the registry; M1 only uses idle + the two intro
  // clips. The registry is kept for later milestones.
  await Promise.all(
    ANIMATION_NAMES.map(async (name) => {
      const clip = await loadMixamoAnimation(`/animations/${name}.fbx`, vrm);
      clip.name = name;
      clips[name] = clip;
    }),
  );
}

function getAction(name) {
  if (!actions[name]) {
    actions[name] = mixer.clipAction(clips[name]);
  }
  return actions[name];
}

// --- Intro state machine ----------------------------------------------------

function onStart() {
  overlay.classList.add("hidden");

  // Create/resume a single shared AudioContext (unlocks audio for later use).
  if (!audioContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioContext = new Ctx();
  }
  if (audioContext && audioContext.state === "suspended") {
    audioContext.resume();
  }

  playIntro();
}

function playIntro() {
  if (introPlayed) return;
  introPlayed = true;

  // Stop the idle that was running under the overlay; the intro drives it.
  idleAction.stop();

  const fallFlat = getAction("fall-flat");
  const standUp = getAction("stand-up");

  fallFlat.reset().setLoop(THREE.LoopOnce, 1);
  fallFlat.clampWhenFinished = true;

  standUp.setLoop(THREE.LoopOnce, 1);
  standUp.clampWhenFinished = true;
  standUp.timeScale = STANDUP_TIME_SCALE;

  const onFinished = (e) => {
    if (e.action === fallFlat) {
      // Crossfade from the clamped fall-flat into stand-up (skip the ~2.5s of
      // lying still at the start).
      standUp.reset();
      standUp.time = STANDUP_START;
      standUp.setEffectiveWeight(1);
      standUp.play();
      fallFlat.crossFadeTo(standUp, CROSSFADE_DURATION, false);
    } else if (e.action === standUp) {
      // Hand off to the looping idle. Fade idle IN to full weight and fade the
      // clamped stand-up OUT, rather than crossFadeTo (which from a clamped
      // LoopOnce action leaves the body stuck in a bad blend).
      idleAction.reset().setLoop(THREE.LoopRepeat, Infinity);
      idleAction.setEffectiveWeight(1);
      idleAction.fadeIn(CROSSFADE_DURATION).play();
      standUp.fadeOut(CROSSFADE_DURATION);
      // Once the fade is done, stop the intro actions entirely so only idle
      // drives the rig (a clamped LoopOnce action can otherwise keep tugging).
      setTimeout(() => {
        standUp.stop();
        fallFlat.stop();
      }, CROSSFADE_DURATION * 1000 + 50);
      mixer.removeEventListener("finished", onFinished);
    }
  };

  mixer.addEventListener("finished", onFinished);

  fallFlat.play();
}

// --- Blink ------------------------------------------------------------------

function randomBlinkDelay() {
  return 3 + Math.random() * 2; // 3-5 seconds
}

function updateBlink(elapsed) {
  if (!currentVrm || !currentVrm.expressionManager) return;

  if (blinkStart < 0 && elapsed >= nextBlinkAt) {
    blinkStart = elapsed;
  }

  if (blinkStart >= 0) {
    const t = elapsed - blinkStart;
    const half = BLINK_DURATION / 2;
    let value;
    if (t < half) {
      value = t / half; // ramp 0 -> 1
    } else if (t < BLINK_DURATION) {
      value = 1 - (t - half) / half; // ramp 1 -> 0
    } else {
      value = 0;
      blinkStart = -1;
      nextBlinkAt = elapsed + randomBlinkDelay();
    }
    currentVrm.expressionManager.setValue("blink", value);
  }
}

// --- Render loop ------------------------------------------------------------

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  updateBlink(elapsed);

  if (mixer) mixer.update(delta);
  if (currentVrm) currentVrm.update(delta);

  renderer.render(scene, camera);
}
