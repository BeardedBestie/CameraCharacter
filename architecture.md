# System Architecture

This project is built on a client-server model that decouples the computer vision (CV) processing from the 3D rendering. The backend is responsible for all CV-related tasks, while the frontend is a lightweight client that only handles rendering.

### Data Flow Diagram

```
+-----------------+      +------------------------+      +--------------------+      +-----------------------+      +-------------------+
|                 |      |                        |      |                    |      |                       |      |                   |
|   Webcam Feed   |----->|  Python Backend (CV)   |----->|  WebSocket Server  |----->|  JavaScript Frontend  |----->|  Rendered Avatar  |
| (Raw Frames)    |      | (OpenCV + MediaPipe)   |      |  (Transmits JSON)  |      |   (Three.js)          |      |  (On HTML Canvas) |
|                 |      |                        |      |                    |      |                       |      |                   |
+-----------------+      +------------------------+      +--------------------+      +-----------------------+      +-------------------+
```

### Component Breakdown

1.  **Webcam Feed Capture (Backend)**
    * **Technology**: OpenCV (`cv2` library) in Python.
    * **Responsibility**: Accesses the default system camera and captures video frames at a consistent rate (e.g., 30 FPS).

2.  **Pose Estimation (Backend)**
    * **Technology**: Google's MediaPipe Pose library for Python.
    * **Responsibility**: Processes each raw frame from OpenCV. It detects a human in the frame and returns a list of 33 pose landmarks. Each landmark contains `x`, `y`, `z`, and `visibility` coordinates. The `x, y, z` coordinates represent a position in a 3D metric space, which is ideal for direct application to a 3D model.

3.  **WebSocket Server (Backend)**
    * **Technology**: A Python WebSocket library (e.g., `websockets`, `FastAPI`).
    * **Responsibility**: After the 3D landmarks are extracted, the backend formats them into a structured JSON object. This JSON object is then broadcasted to all connected clients (our web browser) over the WebSocket connection.
    * **Data Format**: A typical JSON message will look like this:
        ```json
        {
          "landmarks": [
            {"name": "nose", "x": 0.1, "y": 0.2, "z": -0.5, "visibility": 0.99},
            {"name": "left_shoulder", "x": -0.3, "y": 0.1, "z": -0.4, "visibility": 0.98},
            // ... 31 more landmarks
          ]
        }
        ```

4.  **WebSocket Client & 3D Rendering (Frontend)**
    * **Technology**: JavaScript, Three.js.
    * **Responsibility**: The frontend establishes a WebSocket connection to the Python server. It listens for incoming JSON messages. When a message is received, it parses the landmark data and uses it to update the rotation and position of the corresponding bones in a loaded 3D humanoid model (`.glb` or `.gltf` format). Three.js handles the rendering of the model to an HTML `<canvas>` element.

### Deployment

* The Python backend is run as a standalone script from the command line.
* The frontend consists of simple static files (`index.html`, `main.js`) that can be opened directly in a browser or served by a basic web server.