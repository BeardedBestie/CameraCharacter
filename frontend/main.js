import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- DOM ELEMENTS ---
const controlsView = document.getElementById('controls-view');
const mappingList = document.getElementById('mapping-list');
const modelInput = document.getElementById('model-input');
const loaderStatus = document.getElementById('loader-status');
const saveMapBtn = document.getElementById('save-map-btn');
const trackHipsToggle = document.getElementById('track-hips-toggle');
const connectionStatus = document.getElementById('connection-status');
const mainRendererContainer = document.getElementById('main-renderer-view');
const modelScaleSlider = document.getElementById('model-scale-slider');
const modelScaleValue = document.getElementById('model-scale-value');
const poseViewerContainer = document.getElementById('pose-viewer-container');

// --- RENDERER & SCENE SETUP ---
let camera, scene, renderer, controls;
let poseCamera, poseScene, poseRenderer, poseControls, poseSkeleton;

function initScene() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111);

    const { clientWidth, clientHeight } = mainRendererContainer;
    camera = new THREE.PerspectiveCamera(75, clientWidth / clientHeight, 0.1, 1000);
    camera.position.set(0, 1.5, 2);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(clientWidth, clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    mainRendererContainer.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 1, 0);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(5, 10, 7.5);
    directionalLight.castShadow = true;
    scene.add(directionalLight);

    const floorGeometry = new THREE.PlaneGeometry(10, 10);
    const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x444444, side: THREE.DoubleSide });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
}

// --- GLOBAL VARIABLES ---
let model, bones, boneMapping = {};
let latestLandmarks = null;
let latestMouthOpenness = null;
let currentModelFile = null;
let lastDataTimestamp = 0;
let socket = null;
let isCurrentlyAnimating = false;

// Minimum confidence for a landmark to be considered "visible" for animation.
const VISIBILITY_THRESHOLD = 0.6;

const animationSettings = {
    trackHips: true,
    modelScale: 1.0,
    inversions: {
        leftArm: 'none',
        rightArm: 'none',
        leftLeg: 'none',
        rightLeg: 'none'
    },
    offsets: {
        hip: { x: 0, y: 0, z: 0 },
        head: { x: 0, y: 0, z: 0 }
    }
};

// --- STATUS DASHBOARD ---
function updateStatus(elementId, isSuccess) {
    const element = document.getElementById(elementId);
    if (!element) return;
    const light = element.querySelector('.status-light');
    if (isSuccess) {
        light.classList.remove('red');
        light.classList.add('green');
    } else {
        light.classList.remove('green');
        light.classList.add('red');
    }
}


// --- BONE MAPPING CONFIG --- 
const BONE_MAPPING_ROLES = {
    hips: "Hips",
    spine: "Spine",
    neck: "Neck",
    head: "Head",
    jaw: "Jaw",
    leftUpperArm: "Left Upper Arm",
    leftLowerArm: "Left Lower Arm",
    leftHand: "Left Hand",
    rightUpperArm: "Right Upper Arm",
    rightLowerArm: "Right Lower Arm",
    rightHand: "Right Hand",
    leftUpperLeg: "Left Upper Leg",
    leftLowerLeg: "Left Lower Leg",
    leftFoot: "Left Foot",
    rightUpperLeg: "Right Upper Leg",
    rightLowerLeg: "Right Lower Leg",
    rightFoot: "Right Foot",
};

function loadModel(file) {
    if (!file) return;

    currentModelFile = file;
    const objectURL = URL.createObjectURL(file);
    const extension = file.name.split('.').pop().toLowerCase();

    // Reset statuses for new model
    updateStatus('status-model', false);
    updateStatus('status-bones', false);
    updateStatus('status-mapping', false);
    updateStatus('status-tracking', false);
    updateStatus('status-animating', false);
    controlsView.classList.remove('active');

    // Initialize scenes if they haven't been already
    if (!renderer) {
        initScene();
        initPoseViewer();
        animate();
    }

    const loader = extension === 'fbx' ? new FBXLoader() : new GLTFLoader();
    loaderStatus.innerText = 'Loading 3D Model...';

    loader.load(
        objectURL,
        (loadedModel) => {
            // Clean up previous model
            if (model) {
                scene.remove(model);
            }

            model = extension === 'fbx' ? loadedModel : loadedModel.scene;

            model.scale.set(animationSettings.modelScale, animationSettings.modelScale, animationSettings.modelScale);

            model.traverse((node) => {
                if (node.isMesh) {
                    node.castShadow = true;
                }
            });
            scene.add(model);
            console.log('Model loaded successfully.');
            updateStatus('status-model', true);

            // Extract bones
            bones = {};
            const boneNames = [];
            model.traverse((node) => {
                if (node.isBone) {
                    bones[node.name] = node;
                    boneNames.push(node.name);
                }
            });
            console.log('Found bones:', boneNames);

            if (boneNames.length === 0) {
                loaderStatus.innerText = 'Error: No bones found in model. Please use a rigged character.';
                updateStatus('status-bones', false);
                return;
            }
            updateStatus('status-bones', true);
            
            loaderStatus.innerText = `Model: ${file.name}`;
            populateMappingUI(boneNames);
            controlsView.classList.add('active');

            // Attempt to connect WebSocket if not already connected
            if (!socket) {
                connectWebSocket();
            }
        },
        (xhr) => {
            const percentLoaded = Math.round((xhr.loaded / xhr.total) * 100);
            loaderStatus.innerText = `Loading: ${percentLoaded}%`;
        },
        (error) => {
            console.error('An error happened while loading the model:', error);
            loaderStatus.innerText = 'Error loading model. Check console for details.';
            updateStatus('status-model', false);
        }
    );
}

// --- MODEL LOADING ---
modelInput.addEventListener('change', (event) => {
    loadModel(event.target.files[0]);
});

function setupLiveMapping() {
    mappingList.addEventListener('input', (event) => {
        if (event.target.tagName === 'SELECT') {
            const role = event.target.dataset.role;
            const boneName = event.target.value;
            if (role) {
                if (boneName) {
                    boneMapping[role] = boneName;
                } else {
                    delete boneMapping[role]; // Un-map if default is selected
                }
            }
            updateStatus('status-mapping', Object.keys(boneMapping).length > 0);
        }
    });
}

function populateMappingUI(boneNames) {
    mappingList.innerHTML = '';
    const poseStatusList = document.getElementById('pose-status-list');
    poseStatusList.innerHTML = ''; // Clear previous status

    const savedMap = JSON.parse(localStorage.getItem(`bone-map-${currentModelFile.name}`) || '{}');

    for (const [role, name] of Object.entries(BONE_MAPPING_ROLES)) {
        // Create mapping UI dropdown
        const item = document.createElement('div');
        item.classList.add('mapping-item');

        const label = document.createElement('label');
        label.textContent = name;

        const select = document.createElement('select');
        select.dataset.role = role;

        const defaultOption = document.createElement('option');
        defaultOption.value = "";
        defaultOption.textContent = "-- Not Mapped --";
        select.appendChild(defaultOption);

        boneNames.forEach(boneName => {
            const option = document.createElement('option');
            option.value = boneName;
            option.textContent = boneName;
            select.appendChild(option);
        });

        if (savedMap[role] && boneNames.includes(savedMap[role])) {
            select.value = savedMap[role];
        }

        item.appendChild(label);
        item.appendChild(select);
        mappingList.appendChild(item);

        // Create pose status dashboard item
        const statusItem = document.createElement('li');
        statusItem.id = `pose-status-${role}`;
        statusItem.innerHTML = `<span class="status-light red"></span> ${name}`;
        poseStatusList.appendChild(statusItem);
    }

    boneMapping = savedMap;
    const allMappedBonesExist = Object.values(savedMap).every(boneName => boneNames.includes(String(boneName)));
    updateStatus('status-mapping', Object.keys(savedMap).length > 0 && allMappedBonesExist);
    
    setupLiveMapping();
}

saveMapBtn.addEventListener('click', () => {
    if (currentModelFile) {
        localStorage.setItem(`bone-map-${currentModelFile.name}`, JSON.stringify(boneMapping));
        // As requested, reload the model to ensure a fresh state
        loadModel(currentModelFile);
    }
});

// --- UI CONTROLS --- 
trackHipsToggle.addEventListener('change', () => {
    animationSettings.trackHips = trackHipsToggle.checked;
});

modelScaleSlider.addEventListener('input', () => {
    const scale = parseFloat(modelScaleSlider.value);
    animationSettings.modelScale = scale;
    modelScaleValue.textContent = scale.toFixed(2);
    if (model) {
        model.scale.set(scale, scale, scale);
    }
});

// Listeners for retargeting offsets
document.getElementById('hip-offset-x').addEventListener('input', (e) => animationSettings.offsets.hip.x = parseInt(e.target.value, 10));
document.getElementById('hip-offset-y').addEventListener('input', (e) => animationSettings.offsets.hip.y = parseInt(e.target.value, 10));
document.getElementById('hip-offset-z').addEventListener('input', (e) => animationSettings.offsets.hip.z = parseInt(e.target.value, 10));
document.getElementById('head-offset-x').addEventListener('input', (e) => animationSettings.offsets.head.x = parseInt(e.target.value, 10));
document.getElementById('head-offset-y').addEventListener('input', (e) => animationSettings.offsets.head.y = parseInt(e.target.value, 10));
document.getElementById('head-offset-z').addEventListener('input', (e) => animationSettings.offsets.head.z = parseInt(e.target.value, 10));


// Listeners for retargeting fixes
document.getElementById('invert-left-arm-select').addEventListener('change', (e) => animationSettings.inversions.leftArm = e.target.value);
document.getElementById('invert-right-arm-select').addEventListener('change', (e) => animationSettings.inversions.rightArm = e.target.value);
document.getElementById('invert-left-leg-select').addEventListener('change', (e) => animationSettings.inversions.leftLeg = e.target.value);
document.getElementById('invert-right-leg-select').addEventListener('change', (e) => animationSettings.inversions.rightLeg = e.target.value);

// --- WEBSOCKET COMMUNICATION ---
function connectWebSocket() {
    socket = new WebSocket('ws://localhost:8765');
    connectionStatus.innerText = 'Connecting to backend...';
    connectionStatus.style.display = 'block';

    socket.onopen = () => {
        console.log('WebSocket connection established.');
        connectionStatus.style.display = 'none';
        updateStatus('status-websocket', true);
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.landmarks) {
                latestLandmarks = processLandmarks(data.landmarks);
                lastDataTimestamp = Date.now();
                updateStatus('status-data', true);

                const requiredLandmarks = ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'];
                const allRequiredPresent = requiredLandmarks.every(name => latestLandmarks[name]);
                updateStatus('status-tracking', allRequiredPresent);
            }
            if (data.mouth && typeof data.mouth.openness !== 'undefined') {
                latestMouthOpenness = data.mouth.openness;
            }
        } catch (e) {
            console.error('Error parsing WebSocket message:', e);
        }
    };

    socket.onclose = () => {
        console.log('WebSocket connection closed.');
        connectionStatus.innerText = 'Connection closed. Please restart the backend and refresh.';
        connectionStatus.style.display = 'block';
        socket = null;
        updateStatus('status-websocket', false);
        updateStatus('status-data', false);
        updateStatus('status-tracking', false);
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        connectionStatus.innerText = 'Connection error. Is the backend running?';
        connectionStatus.style.display = 'block';
        socket = null;
        updateStatus('status-websocket', false);
        updateStatus('status-data', false);
        updateStatus('status-tracking', false);
    };
}

function processLandmarks(landmarksArray) {
    const landmarkPoints = {};
    landmarksArray.forEach(lm => {
        // Invert Y-axis to match Three.js coordinate system (Y-up).
        // MediaPipe's world landmarks have Y-down. This fixes both the
        // upside-down pose viewer and model animation.
        const vec = new THREE.Vector3(lm.x, -lm.y, -lm.z);
        vec.visibility = lm.visibility; // Attach visibility to the vector object
        landmarkPoints[lm.name] = vec;
    });
    return landmarkPoints;
}

// --- AVATAR RETARGETING LOGIC ---

function applyInversion(vector, inversionType) {
    if (inversionType === 'negate') {
        vector.negate();
    } else if (inversionType === 'invertX') {
        vector.x *= -1;
    } else if (inversionType === 'invertY') {
        vector.y *= -1;
    } else if (inversionType === 'invertZ') {
        vector.z *= -1;
    }
    return vector;
}

const rotateBone = (bone, targetDirection, parent, smoothingFactor = 0.6) => {
    if (!bone || !parent) return;
    
    const boneDirection = new THREE.Vector3(0, 1, 0); 
    const q = new THREE.Quaternion().setFromUnitVectors(boneDirection, targetDirection);
    const parentWorldQuat = new THREE.Quaternion();
    parent.getWorldQuaternion(parentWorldQuat);
    const parentWorldQuatInv = parentWorldQuat.clone().invert();
    const localQuat = parentWorldQuatInv.multiply(q);
    bone.quaternion.slerp(localQuat, smoothingFactor);
};

function retargetAvatar() {
    if (!latestLandmarks || !model || !bones || Object.keys(boneMapping).length === 0) return;

    const rig = {};
    for (const role in boneMapping) {
        if (bones[boneMapping[role]]) {
            rig[role] = bones[boneMapping[role]];
        }
    }

    const landmarks = latestLandmarks;
    // Helper to check if all named landmarks are present and above the visibility threshold.
    const areVisible = (names) => names.every(name => landmarks[name] && landmarks[name].visibility > VISIBILITY_THRESHOLD);

    // Core body (Spine and Hips)
    if (areVisible(['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'])) {
        const ls = landmarks.left_shoulder, rs = landmarks.right_shoulder;
        const lh = landmarks.left_hip, rh = landmarks.right_hip;

        const midShoulder = new THREE.Vector3().addVectors(ls, rs).multiplyScalar(0.5);
        const midHip = new THREE.Vector3().addVectors(lh, rh).multiplyScalar(0.5);

        if (rig.hips) {
            if (animationSettings.trackHips) {
                rig.hips.position.lerp(midHip, 0.8);
            }
            
            // --- New Body Rotation Logic ---
            const bodyRight = new THREE.Vector3().subVectors(rs, ls).normalize();
            const bodyUpApprox = new THREE.Vector3().subVectors(midShoulder, midHip).normalize();
            
            const bodyForward = new THREE.Vector3().crossVectors(bodyUpApprox, bodyRight).normalize();
            const bodyUp = new THREE.Vector3().crossVectors(bodyRight, bodyForward).normalize();
            
            const rotationMatrix = new THREE.Matrix4();
            rotationMatrix.makeBasis(bodyRight, bodyUp, bodyForward.clone().negate());

            const bodyWorldQuaternion = new THREE.Quaternion().setFromRotationMatrix(rotationMatrix);

            const parent = rig.hips.parent;
            if (parent) {
                 const parentWorldQuat = new THREE.Quaternion();
                 parent.getWorldQuaternion(parentWorldQuat);
                 const parentWorldQuatInv = parentWorldQuat.clone().invert();
                 
                 const localBodyQuat = parentWorldQuatInv.multiply(bodyWorldQuaternion);
                 
                 const euler = new THREE.Euler().setFromQuaternion(localBodyQuat, 'YXZ');
                 euler.x = 0; euler.z = 0;
                 const yawOnlyQuat = new THREE.Quaternion().setFromEuler(euler);

                 const hipCorrection = new THREE.Quaternion().setFromEuler(
                    new THREE.Euler(
                        THREE.MathUtils.degToRad(animationSettings.offsets.hip.x),
                        THREE.MathUtils.degToRad(animationSettings.offsets.hip.y),
                        THREE.MathUtils.degToRad(animationSettings.offsets.hip.z)
                    )
                );
                const finalHipQuat = yawOnlyQuat.multiply(hipCorrection);
                rig.hips.quaternion.slerp(finalHipQuat, 0.6);
            }
        }
        
        if (rig.spine) {
            const spineDirection = new THREE.Vector3().subVectors(midShoulder, midHip).normalize();
            rotateBone(rig.spine, spineDirection, rig.spine.parent);
        }
    }

    // Head and Neck
    if (areVisible(['left_ear', 'right_ear', 'left_shoulder', 'right_shoulder'])) {
        const ls = landmarks.left_shoulder, rs = landmarks.right_shoulder;
        const le = landmarks.left_ear, re = landmarks.right_ear;

        const midShoulder = new THREE.Vector3().addVectors(ls, rs).multiplyScalar(0.5);
        const midEar = new THREE.Vector3().addVectors(le, re).multiplyScalar(0.5);
        if (rig.neck) {
            const neckDir = new THREE.Vector3().subVectors(midEar, midShoulder).normalize();
            rotateBone(rig.neck, neckDir, rig.neck.parent);
        }
        
        if (rig.head) {
            const headRight = new THREE.Vector3().subVectors(re, le).normalize();
            const headUpApprox = new THREE.Vector3().subVectors(midEar, midShoulder).normalize();
            
            const headForward = new THREE.Vector3().crossVectors(headUpApprox, headRight).normalize();
            const headUp = new THREE.Vector3().crossVectors(headRight, headForward).normalize();

            const rotationMatrix = new THREE.Matrix4();
            rotationMatrix.makeBasis(headRight, headUp, headForward.clone().negate());

            const headWorldQuaternion = new THREE.Quaternion().setFromRotationMatrix(rotationMatrix);

            const parent = rig.head.parent;
            if (parent) {
                const parentWorldQuat = new THREE.Quaternion();
                parent.getWorldQuaternion(parentWorldQuat);
                const parentWorldQuatInv = parentWorldQuat.clone().invert();
                
                const localHeadQuat = parentWorldQuatInv.multiply(headWorldQuaternion);
                
                const headCorrection = new THREE.Quaternion().setFromEuler(
                    new THREE.Euler(
                        THREE.MathUtils.degToRad(animationSettings.offsets.head.x),
                        THREE.MathUtils.degToRad(animationSettings.offsets.head.y),
                        THREE.MathUtils.degToRad(animationSettings.offsets.head.z)
                    )
                );
                const finalHeadQuat = localHeadQuat.multiply(headCorrection);
                rig.head.quaternion.slerp(finalHeadQuat, 0.6);
            }
        }
    }

    // Left Arm
    if (rig.leftUpperArm && areVisible(['left_shoulder', 'left_elbow'])) {
        const ls = landmarks.left_shoulder, lelb = landmarks.left_elbow;
        const leftUpperArmDir = new THREE.Vector3().subVectors(lelb, ls).normalize();
        applyInversion(leftUpperArmDir, animationSettings.inversions.leftArm);
        rotateBone(rig.leftUpperArm, leftUpperArmDir, rig.leftUpperArm.parent);
    }
    if (rig.leftLowerArm && areVisible(['left_elbow', 'left_wrist'])) {
        const lelb = landmarks.left_elbow, lw = landmarks.left_wrist;
        const leftLowerArmDir = new THREE.Vector3().subVectors(lw, lelb).normalize();
        applyInversion(leftLowerArmDir, animationSettings.inversions.leftArm);
        rotateBone(rig.leftLowerArm, leftLowerArmDir, rig.leftLowerArm.parent);
    }
    if (rig.leftHand && areVisible(['left_wrist', 'left_index'])) {
        const lw = landmarks.left_wrist, li = landmarks.left_index;
        const leftHandDir = new THREE.Vector3().subVectors(li, lw).normalize();
        applyInversion(leftHandDir, animationSettings.inversions.leftArm);
        rotateBone(rig.leftHand, leftHandDir, rig.leftHand.parent);
    }

    // Right Arm
    if (rig.rightUpperArm && areVisible(['right_shoulder', 'right_elbow'])) {
        const rs = landmarks.right_shoulder, relb = landmarks.right_elbow;
        const rightUpperArmDir = new THREE.Vector3().subVectors(relb, rs).normalize();
        applyInversion(rightUpperArmDir, animationSettings.inversions.rightArm);
        rotateBone(rig.rightUpperArm, rightUpperArmDir, rig.rightUpperArm.parent);
    }
    if (rig.rightLowerArm && areVisible(['right_elbow', 'right_wrist'])) {
        const relb = landmarks.right_elbow, rw = landmarks.right_wrist;
        const rightLowerArmDir = new THREE.Vector3().subVectors(rw, relb).normalize();
        applyInversion(rightLowerArmDir, animationSettings.inversions.rightArm);
        rotateBone(rig.rightLowerArm, rightLowerArmDir, rig.rightLowerArm.parent);
    }
    if (rig.rightHand && areVisible(['right_wrist', 'right_index'])) {
        const rw = landmarks.right_wrist, ri = landmarks.right_index;
        const rightHandDir = new THREE.Vector3().subVectors(ri, rw).normalize();
        applyInversion(rightHandDir, animationSettings.inversions.rightArm);
        rotateBone(rig.rightHand, rightHandDir, rig.rightHand.parent);
    }

    // Left Leg
    if (rig.leftUpperLeg && areVisible(['left_hip', 'left_knee'])) {
        const lh = landmarks.left_hip, lk = landmarks.left_knee;
        const leftUpperLegDir = new THREE.Vector3().subVectors(lk, lh).normalize();
        applyInversion(leftUpperLegDir, animationSettings.inversions.leftLeg);
        rotateBone(rig.leftUpperLeg, leftUpperLegDir, rig.leftUpperLeg.parent);
    }
    if (rig.leftLowerLeg && areVisible(['left_knee', 'left_ankle'])) {
        const lk = landmarks.left_knee, la = landmarks.left_ankle;
        const leftLowerLegDir = new THREE.Vector3().subVectors(la, lk).normalize();
        applyInversion(leftLowerLegDir, animationSettings.inversions.leftLeg);
        rotateBone(rig.leftLowerLeg, leftLowerLegDir, rig.leftLowerLeg.parent);
    }
    if (rig.leftFoot && areVisible(['left_ankle', 'left_foot_index'])) {
        const la = landmarks.left_ankle, lfi = landmarks.left_foot_index;
        const leftFootDir = new THREE.Vector3().subVectors(lfi, la).normalize();
        applyInversion(leftFootDir, animationSettings.inversions.leftLeg);
        rotateBone(rig.leftFoot, leftFootDir, rig.leftFoot.parent);
    }

    // Right Leg
    if (rig.rightUpperLeg && areVisible(['right_hip', 'right_knee'])) {
        const rh = landmarks.right_hip, rk = landmarks.right_knee;
        const rightUpperLegDir = new THREE.Vector3().subVectors(rk, rh).normalize();
        applyInversion(rightUpperLegDir, animationSettings.inversions.rightLeg);
        rotateBone(rig.rightUpperLeg, rightUpperLegDir, rig.rightUpperLeg.parent);
    }
    if (rig.rightLowerLeg && areVisible(['right_knee', 'right_ankle'])) {
        const rk = landmarks.right_knee, ra = landmarks.right_ankle;
        const rightLowerLegDir = new THREE.Vector3().subVectors(ra, rk).normalize();
        applyInversion(rightLowerLegDir, animationSettings.inversions.rightLeg);
        rotateBone(rig.rightLowerLeg, rightLowerLegDir, rig.rightLowerLeg.parent);
    }
    if (rig.rightFoot && areVisible(['right_ankle', 'right_foot_index'])) {
        const ra = landmarks.right_ankle, rfi = landmarks.right_foot_index;
        const rightFootDir = new THREE.Vector3().subVectors(rfi, ra).normalize();
        applyInversion(rightFootDir, animationSettings.inversions.rightLeg);
        rotateBone(rig.rightFoot, rightFootDir, rig.rightFoot.parent);
    }
    
    const jawBone = rig.jaw;
    if (jawBone && latestMouthOpenness !== null) {
        jawBone.rotation.x = latestMouthOpenness * 0.5;
    }

    isCurrentlyAnimating = true;
}

// --- POSE VIEWER & STATUS ---
const landmarkNames = [
    'nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner', 'right_eye', 'right_eye_outer', 'left_ear', 'right_ear', 'mouth_left', 'mouth_right',
    'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky', 'left_index', 'right_index', 'left_thumb', 'right_thumb',
    'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle', 'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index'
];
const POSE_CONNECTIONS_INDICES = [
    [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10], [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19], [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 29], [27, 31], [29, 31], [24, 26], [26, 28], [28, 30], [28, 32], [30, 32]
];
const POSE_CONNECTIONS = POSE_CONNECTIONS_INDICES.map(pair => [landmarkNames[pair[0]], landmarkNames[pair[1]]]);

const landmarkRequirements = {
    hips: ['left_hip', 'right_hip'],
    spine: ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'],
    neck: ['left_ear', 'right_ear', 'left_shoulder', 'right_shoulder'],
    head: ['left_ear', 'right_ear'],
    jaw: ['mouth_left', 'mouth_right'], // Based on mouth openness which needs face landmarks
    leftUpperArm: ['left_shoulder', 'left_elbow'],
    leftLowerArm: ['left_elbow', 'left_wrist'],
    leftHand: ['left_wrist', 'left_index'],
    rightUpperArm: ['right_shoulder', 'right_elbow'],
    rightLowerArm: ['right_elbow', 'right_wrist'],
    rightHand: ['right_wrist', 'right_index'],
    leftUpperLeg: ['left_hip', 'left_knee'],
    leftLowerLeg: ['left_knee', 'left_ankle'],
    leftFoot: ['left_ankle', 'left_foot_index'],
    rightUpperLeg: ['right_hip', 'right_knee'],
    rightLowerLeg: ['right_knee', 'right_ankle'],
    rightFoot: ['right_ankle', 'right_foot_index'],
};

function initPoseViewer() {
    poseScene = new THREE.Scene();
    poseScene.background = new THREE.Color(0x181818);

    const { clientWidth, clientHeight } = poseViewerContainer;
    poseCamera = new THREE.PerspectiveCamera(75, clientWidth / clientHeight, 0.1, 1000);
    poseCamera.position.set(0, 0.5, 2);

    poseRenderer = new THREE.WebGLRenderer({ antialias: true });
    poseRenderer.setSize(clientWidth, clientHeight);
    poseRenderer.setPixelRatio(window.devicePixelRatio);
    poseViewerContainer.appendChild(poseRenderer.domElement);

    poseControls = new OrbitControls(poseCamera, poseRenderer.domElement);
    poseControls.enableDamping = true;
    poseControls.target.set(0, 0, 0);

    const material = new THREE.LineBasicMaterial({ color: 0x00ff00 });
    const geometry = new THREE.BufferGeometry();
    const vertices = new Float32Array(POSE_CONNECTIONS.length * 2 * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

    poseSkeleton = new THREE.LineSegments(geometry, material);
    poseScene.add(poseSkeleton);
}

function updatePoseViewer() {
    if (!latestLandmarks || !poseSkeleton) return;

    const positions = poseSkeleton.geometry.attributes.position.array;
    let vertexIndex = 0;

    for (const connection of POSE_CONNECTIONS) {
        const start = latestLandmarks[connection[0]];
        const end = latestLandmarks[connection[1]];

        if (start && end && start.visibility > VISIBILITY_THRESHOLD && end.visibility > VISIBILITY_THRESHOLD) {
            positions[vertexIndex++] = start.x;
            positions[vertexIndex++] = start.y;
            positions[vertexIndex++] = start.z;
            positions[vertexIndex++] = end.x;
            positions[vertexIndex++] = end.y;
            positions[vertexIndex++] = end.z;
        } else {
            for (let i = 0; i < 6; i++) { positions[vertexIndex++] = 0; }
        }
    }
    poseSkeleton.geometry.attributes.position.needsUpdate = true;
}

function updatePoseStatusDashboard() {
    if (!latestLandmarks) return;
    
    for (const role in BONE_MAPPING_ROLES) {
        const statusEl = document.getElementById(`pose-status-${role}`);
        if (!statusEl) continue;

        const required = landmarkRequirements[role];
        let isTracked = false;

        if (role === 'jaw') {
            isTracked = latestMouthOpenness !== null;
        } else if (required) {
            isTracked = required.every(name => latestLandmarks[name] && latestLandmarks[name].visibility > VISIBILITY_THRESHOLD);
        }
        
        const light = statusEl.querySelector('.status-light');
        if (isTracked) {
            light.classList.remove('red');
            light.classList.add('green');
        } else {
            light.classList.remove('green');
            light.classList.add('red');
        }
    }
}


// --- ANIMATION LOOP ---
function animate() {
    requestAnimationFrame(animate);

    if (socket && Date.now() - lastDataTimestamp > 2000) {
        updateStatus('status-data', false);
        updateStatus('status-tracking', false);
    }

    isCurrentlyAnimating = false; // Reset before retargeting
    retargetAvatar();
    updateStatus('status-animating', isCurrentlyAnimating);
    updatePoseStatusDashboard();

    // Main renderer
    controls.update();
    renderer.render(scene, camera);

    // Pose viewer renderer
    if (poseRenderer) {
        updatePoseViewer();
        poseControls.update();
        poseRenderer.render(poseScene, poseCamera);
    }
}

// --- WINDOW RESIZE HANDLING ---
window.addEventListener('resize', () => {
    // Main renderer
    if (renderer && camera) {
        const { clientWidth, clientHeight } = mainRendererContainer;
        camera.aspect = clientWidth / clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(clientWidth, clientHeight);
    }
    // Pose viewer
    if (poseRenderer && poseCamera) {
        const { clientWidth, clientHeight } = poseViewerContainer;
        poseCamera.aspect = clientWidth / clientHeight;
        poseCamera.updateProjectionMatrix();
        poseRenderer.setSize(clientWidth, clientHeight);
    }
});
