# Project Development Plan

This project will be developed in four distinct, iterative phases. Each phase has a clear goal and a set of success criteria that must be met before proceeding to the next.

--- 

### Phase 1: Backend - Pose Landmark Extraction

* **Goal**: To successfully capture a webcam feed and extract 3D pose landmarks from it.
* **Tasks**:
    1.  Set up a Python environment with OpenCV and MediaPipe.
    2.  Write a script to initialize the webcam.
    3.  In a loop, read frames from the webcam.
    4.  Process each frame using `mediapipe.solutions.pose`.
    5.  If a pose is detected, extract the 3D world landmark data.
* **Success Criteria (Gate)**:
    * The script runs without errors.
    * A window appears showing the live webcam feed.
    * The console continuously prints the array of 33 world landmark coordinates (`x`, `y`, `z`) for each frame where a person is visible.

--- 

### Phase 2: Backend to Frontend - WebSocket Communication

* **Goal**: To transmit the landmark data from the Python backend to a JavaScript frontend in real-time.
* **Tasks**:
    1.  Integrate a WebSocket server library (e.g., `websockets`) into the Python script.
    2.  After landmarks are extracted, format them into a JSON string.
    3.  Broadcast the JSON data to all connected WebSocket clients.
    4.  Create a basic `index.html` and a `main.js` file.
    5.  In `main.js`, write the client-side code to connect to the Python WebSocket server.
    6.  Listen for incoming messages and log them to the browser's developer console.
* **Success Criteria (Gate)**:
    * The Python server starts and listens for WebSocket connections.
    * When the HTML file is opened, the JavaScript client successfully connects to the server.
    * The browser's developer console shows a continuous stream of incoming JSON objects containing the landmark data.

--- 

### Phase 3: Frontend - 3D Scene and Model Loading

* **Goal**: To set up a basic 3D environment and load a rigged humanoid model.
* **Tasks**:
    1.  Add the Three.js library to the frontend.
    2.  Create an HTML `<canvas>` element for rendering.
    3.  In `main.js`, set up a Three.js scene, camera, and renderer.
    4.  Obtain a standard, rigged 3D humanoid model in `.glb` or `.gltf` format (e.g., from Mixamo).
    5.  Use the `GLTFLoader` in Three.js to load the model into the scene.
    6.  Implement a basic animation loop to render the scene.
* **Success Criteria (Gate)**:
    * The web page displays the 3D scene.
    * The humanoid model is loaded and visible in its default T-pose or idle stance.
    * There are no errors in the browser console related to 3D rendering or model loading.

--- 

### Phase 4: Full Integration - Real-Time Avatar Retargeting

* **Goal**: To use the incoming landmark data to animate the 3D model's skeleton.
* **Tasks**:
    1.  Traverse the loaded 3D model to get a reference to all its major bones (e.g., `LeftUpperArm`, `RightForeArm`, `Spine`, etc.).
    2.  Modify the WebSocket message handler from Phase 2.
    3.  For each frame's data, calculate the necessary rotations to align the model's bones with the vectors derived from the landmarks (e.g., the vector from the `left_shoulder` landmark to the `left_elbow` landmark).
    4.  Apply these rotations to the corresponding bones in the Three.js model.
    5.  Fine-tune the animation to be smooth and responsive.
* **Success Criteria (Gate)**:
    * The 3D avatar in the browser moves in real-time, mirroring the user's movements from the webcam.
    * The animation is fluid, without significant lag or visual jitter.
    * The final application is stable and functions as a cohesive whole.