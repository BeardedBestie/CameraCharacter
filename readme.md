# CameraCharacter: Real-Time Vision-Driven 3D Avatars

## 🌟 Overview

**CameraCharacter** is an open-source, low-latency motion capture and puppet system. It enables anyone with a standard webcam to animate a fully rigged 3D humanoid avatar in real-time, without the need for specialized depth cameras (like Kinect) or expensive inertial MoCap suits.

By leveraging Google's **MediaPipe** for high-fidelity pose estimation and **Three.js** for browser-based 3D rendering, this project bridges the gap between raw computer vision and interactive character animation.

---

## 🚀 Why Use This?

-   **Accessibility**: Use the hardware you already own. No sensors, no suits—just a camera.
-   **Decoupled Architecture**: The project separates the intensive AI processing (Python) from the visual rendering (JavaScript/WebGL). This allows the backend to run on a dedicated machine or locally while keeping the frontend lightweight and portable.
-   **Live Retargeting**: Unlike static animation playback, this system calculates bone rotations on-the-fly. You can swap models, adjust offsets, and fix limb inversions without restarting the stream.
-   **Creative Expression**: Includes a variety of 'Visual Modes' (Matrix, Neon, Punk, Comic) for the backend feed, making it a powerful tool for streamers and digital performers.

---

## 🏗️ System Architecture & Data Pipeline

### 1. The Backend (Python)
-   **Capture**: Uses OpenCV to stream frames from any detected webcam.
-   **Processing**: MediaPipe Holistic processes each frame to identify 33 3D 'World Landmarks' (X, Y, Z in metric space) and facial geometry.
-   **The Pipeline**: The backend calculates mouth openness (ratio-based) and packages all coordinate data into a compact JSON payload.
-   **Communication**: A high-speed WebSocket server (`websockets` library) broadcasts this data to any connected client at ~30 FPS.

### 2. The Frontend (Three.js)
-   **Reception**: Connects to the local WebSocket and parses the landmark stream.
-   **Coordinate Translation**: MediaPipe uses a Y-down coordinate system, while Three.js uses Y-up. The frontend automatically normalizes this data.
-   **Retargeting Engine**: Using a series of mathematical operations (Vector math, Quaternions, and Matrix4 rotations), the system aligns the 'bones' of a loaded 3D model with the vectors formed by the human user's limbs.
-   **UI & Mapping**: Provides a robust interface to load `.glb` or `.fbx` models, map specific bones to tracking roles, and save these configurations to `localStorage`.

---

## 🛠️ Installation & Setup

### Prerequisites
-   Python 3.9+
-   A modern web browser (Chrome or Edge recommended for WebGL performance)

### Step 1: Backend Setup
1.  Navigate to the project root.
2.  Install dependencies:
    ```bash
    pip install -r requirements.txt
    ```
3.  Run the backend:
    ```bash
    python backend/main.py
    ```
    *This will open a GUI window where you can select your camera and apply filters.*

### Step 2: Frontend Setup
1.  Open `frontend/index.html` in your browser.
2.  Ensure the status light for **WebSocket** turns green (indicating it has connected to the Python backend).
3.  Upload a rigged humanoid `.glb` or `.fbx` file.

--- 

## 🎮 Core Features

-   **Dynamic Bone Mapping**: Manually assign which model bone corresponds to the 'Left Upper Arm', 'Hips', etc. Works with various rigging naming conventions (Mixamo, Blender, Rigify).
-   **Retargeting Offsets**: Every model is rigged differently. If your character's head is looking at the floor while you are looking forward, use the **Head Offset** sliders to calibrate the rotation in real-time.
-   **Limb Inversion Fixes**: Models can have different local axes for bones. If an arm bends backward, use the **Inversion Selectors** to flip the X, Y, or Z axis for that specific limb group.
-   **Dual-View Monitoring**: 
    -   **Main View**: The fully rendered 3D avatar.
    -   **Pose Input View**: A live 'stick-figure' representation of the raw data being received from the backend, essential for troubleshooting occlusion or lighting issues.
-   **Tracking Dashboard**: Real-time status lights indicate which body parts have high enough tracking confidence (visibility) to animate.

---

## ⚠️ Current Issues & Challenges

-   **Rotational Accuracy**: Because MediaPipe provides point coordinates (landmarks) rather than rotational orientation (quaternions) for joints, rotations must be inferred. This can lead to "flipping" or jank if the user's arm is perfectly aligned with the camera (loss of depth perspective).
-   **Model Squashing**: If the user moves too close to the camera, the hip tracking might incorrectly interpret the scale, causing the model to "squash." (Current workaround: Disable 'Track Hip Position' in the settings).
-   **Occlusion**: If a hand moves behind the back, the confidence score drops, and the limb will "freeze" or snap back to the T-Pose until visible again.
-   **Head Twist**: Complex head rotations (tilting + nodding + turning) are difficult to solve with only ear/eye/shoulder points.

---

## 🗺️ Future Roadmap

1.  **Inverse Kinematics (IK) Integration**: Move from simple forward-kinematics (vector-based) to a full IK solver to ensure feet stay planted on the floor and limbs move more naturally.
2.  **VRM Support**: Better integration for `.vrm` files, including support for SpringBones (hair/clothing physics) and BlendShape-based facial expressions.
-   **Advanced Face Tracking**: Transition from simple mouth openness to a full 52-shape ARKit blendshape mapping (eye blinking, eyebrow raising, sneering).
-   **Recording & Playback**: The ability to record the raw landmark stream to a file and play it back later to render animations without a live actor.
-   **Multi-User Support**: Allowing the backend to track multiple people and transmit data for multiple avatars simultaneously.

---

## 🤝 Contributing

This project is in active development. If you encounter "janky" movements or have ideas for better rotation math, please contribute! 

**Special Note on 3D Models**: For best results, use models from [Adobe Mixamo](https://www.mixamo.com/) as they follow a standard rigging structure that the default mapping handles well.