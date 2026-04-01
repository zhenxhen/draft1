import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Setup Scene, Camera, Renderer
// preserveDrawingBuffer: true — required to read WebGL canvas pixels each frame
const scene = new THREE.Scene();
scene.background = new THREE.Color('#ffffff');

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0, 20);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.getElementById('canvas-container').appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.01;
controls.autoRotate = true;
controls.autoRotateSpeed = 2;

// Left: vivid color palette
const leftColors = [
    '#e3586b', '#e095a5', '#f4cc5e',
    '#f2a84d', '#a7c1e5', '#648ec1'
];

// Right: 8-bit quantized grayscale target
const grayLevels = [0, 32, 64, 96, 128, 160, 192, 224];
function makeGrayValue() {
    return grayLevels[Math.floor(Math.random() * grayLevels.length)] / 255;
}

// Main group
const nodeGroup = new THREE.Group();
nodeGroup.scale.set(0.7, 0.7, 0.7);
scene.add(nodeGroup);

const totalNodesCount = 100;

function getRandomSphericalDirection() {
    const phi = Math.acos(2 * Math.random() - 1);
    const theta = Math.random() * Math.PI * 2;
    return new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.sin(phi) * Math.sin(theta),
        Math.cos(phi)
    ).normalize();
}

function smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

const worldQuat = new THREE.Quaternion();
const localZ = new THREE.Vector3(0, 0, 1);
const TRANSITION_WIDTH = 0.3;

// Build spokes (single material, color lerped each frame)
for (let i = 0; i < totalNodesCount; i++) {
    const dir = getRandomSphericalDirection();
    const spokeGroup = new THREE.Group();
    spokeGroup.lookAt(dir);
    spokeGroup.userData.isSpoke = true;

    const maxLength = 6.0;
    const spokeLength = maxLength * (0.9 + Math.random() * 0.1);
    const radius = 0.15 + Math.random() * 0.15;
    const capLength = Math.max(0.1, spokeLength - 2 * radius);

    const colorHex = leftColors[Math.floor(Math.random() * leftColors.length)];
    const originalColor = new THREE.Color(colorHex);
    const gv = makeGrayValue();
    const grayColor = new THREE.Color(gv, gv, gv);

    const geo = new THREE.CapsuleGeometry(radius, capLength, 8, 16);
    const mat = new THREE.MeshBasicMaterial({
        color: originalColor.clone(),
        transparent: true,
        opacity: 0.85,
        blending: THREE.MultiplyBlending,
        depthWrite: false,
        side: THREE.DoubleSide
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.z = spokeLength / 2;
    spokeGroup.add(mesh);

    spokeGroup.userData.mat = mat;
    spokeGroup.userData.originalColor = originalColor;
    spokeGroup.userData.grayColor = grayColor;

    spokeGroup.scale.set(0, 0, 0);
    nodeGroup.add(spokeGroup);

    if (window.gsap) {
        gsap.to(spokeGroup.scale, {
            x: 1, y: 1, z: 1,
            duration: 1.5 + Math.random() * 0.1,
            ease: 'back.out(1.5)',
            delay: Math.random() * 1
        });
    } else {
        spokeGroup.scale.set(1, 1, 1);
    }
}

// ─── 16-bit Bitmap Overlay (right half) ────────────────────────────────────

// Pixel block size in CSS pixels (larger = chunkier / more retro)
const PIXEL_SIZE = 6;

// Palette: 8 discrete gray levels (3-bit depth, 16-bit game style)
const PALETTE_LEVELS = 8;
const PALETTE_STEP = 255 / (PALETTE_LEVELS - 1); // ≈ 36.4

// Bayer 4×4 ordered dithering matrix (values 0–15)
const BAYER4 = [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5
];

function bayerDither(bx, by, gray) {
    // Normalised threshold in [-0.5, 0.5]  →  spread across one palette step
    const threshold = (BAYER4[(by % 4) * 4 + (bx % 4)] / 16 - 0.5) * PALETTE_STEP * 0.9;
    const adjusted = Math.max(0, Math.min(255, gray + threshold));
    return Math.round(Math.round(adjusted / PALETTE_STEP) * PALETTE_STEP);
}

// Overlay canvas — CSS-pixel sized, drawn on top of the Three.js canvas
const overlayCanvas = document.createElement('canvas');
overlayCanvas.style.position = 'fixed';
overlayCanvas.style.top = '0';
overlayCanvas.style.left = '0';
overlayCanvas.style.pointerEvents = 'none';
overlayCanvas.style.zIndex = '10';
document.body.appendChild(overlayCanvas);
const overlayCtx = overlayCanvas.getContext('2d');

// Small downsampled buffer for the right half
const bufCanvas = document.createElement('canvas');
const bufCtx = bufCanvas.getContext('2d', { willReadFrequently: true });

function resizeBuffers() {
    overlayCanvas.width = window.innerWidth;
    overlayCanvas.height = window.innerHeight;
    overlayCanvas.style.width = window.innerWidth + 'px';
    overlayCanvas.style.height = window.innerHeight + 'px';

    // One buffer pixel = PIXEL_SIZE×PIXEL_SIZE CSS pixels of source
    bufCanvas.width = Math.ceil(window.innerWidth / 2 / PIXEL_SIZE);
    bufCanvas.height = Math.ceil(window.innerHeight / PIXEL_SIZE);
}
resizeBuffers();

const _lerpColor = new THREE.Color();

function animate() {
    requestAnimationFrame(animate);
    controls.update();

    // 1. Lerp each spoke colour: vivid (left) → grayscale target (right)
    nodeGroup.children.forEach(spoke => {
        if (!spoke.isGroup || !spoke.userData.isSpoke) return;
        spoke.getWorldQuaternion(worldQuat);
        const worldDir = localZ.clone().applyQuaternion(worldQuat);
        const cameraDir = worldDir.transformDirection(camera.matrixWorldInverse);
        const t = smoothstep(-TRANSITION_WIDTH, TRANSITION_WIDTH, cameraDir.x);
        _lerpColor.lerpColors(spoke.userData.originalColor, spoke.userData.grayColor, t);
        spoke.userData.mat.color.copy(_lerpColor);
    });

    // 2. Render Three.js scene
    renderer.render(scene, camera);

    // 3. Apply 16-bit bitmap effect to right half via 2D overlay ─────────────
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    const rdEl = renderer.domElement;
    const rendW = rdEl.width;   // physical pixels (CSS × dpr)
    const rendH = rdEl.height;

    // Source: right half of the rendered WebGL canvas (physical pixel coords)
    const srcX = Math.floor(rendW / 2);
    const srcW = rendW - srcX;

    // Downsample right half → small buffer
    bufCtx.clearRect(0, 0, bufCanvas.width, bufCanvas.height);
    bufCtx.drawImage(rdEl, srcX, 0, srcW, rendH, 0, 0, bufCanvas.width, bufCanvas.height);

    // Pixel-level: grayscale luminance + Bayer ordered dithering
    const imgData = bufCtx.getImageData(0, 0, bufCanvas.width, bufCanvas.height);
    const data = imgData.data;

    for (let by = 0; by < bufCanvas.height; by++) {
        for (let bx = 0; bx < bufCanvas.width; bx++) {
            const idx = (by * bufCanvas.width + bx) * 4;
            const r = data[idx], g = data[idx + 1], b = data[idx + 2];
            // Luminance-weighted grayscale
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            const q = bayerDither(bx, by, lum);
            data[idx] = data[idx + 1] = data[idx + 2] = q;
            // alpha unchanged
        }
    }
    bufCtx.putImageData(imgData, 0, 0);

    // Scale buffer back up → right half of overlay (no smoothing = crisp pixel blocks)
    overlayCtx.imageSmoothingEnabled = false;
    overlayCtx.drawImage(
        bufCanvas,
        0, 0, bufCanvas.width, bufCanvas.height,
        window.innerWidth / 2, 0,
        window.innerWidth / 2, window.innerHeight
    );
}

animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    resizeBuffers();
});
