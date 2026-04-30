import cv2
import mediapipe as mp
import webview
import threading
import json
import base64
import time
import os
import asyncio
import websockets
import numpy as np
import random

# --- WebSocket Server Setup ---
async def broadcast(message):
    """Helper coroutine to broadcast a message to all connected clients."""
    if CONNECTED_CLIENTS:
        # Create a list of send tasks and wait for them to complete.
        tasks = [client.send(message) for client in CONNECTED_CLIENTS]
        await asyncio.gather(*tasks, return_exceptions=True)

# Global set to store connected WebSocket clients
CONNECTED_CLIENTS = set()
# Reference to the asyncio event loop for the WebSocket server
websocket_loop = None
# Flag to ensure the WebSocket server is started only once
websocket_server_started = False
websocket_server_thread = None

async def register(websocket):
    """Adds a client to the connected set."""
    CONNECTED_CLIENTS.add(websocket)
    print(f"Client connected. Total clients: {len(CONNECTED_CLIENTS)}")
    try:
        await websocket.wait_closed()
    finally:
        CONNECTED_CLIENTS.remove(websocket)
        print(f"Client disconnected. Total clients: {len(CONNECTED_CLIENTS)}")

async def websocket_main():
    """The main coroutine for the WebSocket server."""
    global websocket_loop
    websocket_loop = asyncio.get_running_loop()
    # The server will run until the task is cancelled
    async with websockets.serve(register, "localhost", 8765):
        print("WebSocket server started on ws://localhost:8765")
        await asyncio.Future()  # run forever

def start_websocket_server_in_thread():
    """Starts the WebSocket server in a new thread."""
    def run_server():
        try:
            asyncio.run(websocket_main())
        except (asyncio.CancelledError, RuntimeError):
            print("WebSocket server has been stopped.")
        except Exception as e:
            print(f"WebSocket server error: {e}")

    thread = threading.Thread(target=run_server, daemon=True)
    thread.start()
    print("WebSocket server thread started.")
    return thread


def broadcast_landmarks(landmarks_json):
    """
    Broadcasts landmark data to all connected WebSocket clients.
    This function is called from a non-async thread.
    """
    if CONNECTED_CLIENTS and websocket_loop and websocket_loop.is_running():
        coro = broadcast(landmarks_json)
        future = asyncio.run_coroutine_threadsafe(coro, websocket_loop)
        try:
            future.result(timeout=1)
        except Exception:
            # This can happen if the loop is shutting down
            pass


# --- Helper function for Comic Mode ---
def apply_comic_effect(src_img):
    """
    Applies a halftone/comic book dot effect to an image.
    """
    # Create a high-contrast black and white base image
    levels = 2
    div = 256 // levels
    if div == 0: div = 1
    posterized_img = np.uint8((src_img // div) * div + div // 2)
    gray = cv2.cvtColor(posterized_img, cv2.COLOR_BGR2GRAY)
    _, base_img = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)

    # Halftone effect settings
    height, width = base_img.shape
    output_canvas = np.full((height, width, 3), 255, dtype=np.uint8)  # White canvas
    step = 8  # Grid size for dots

    # Iterate over the image in a grid
    for y in range(0, height, step):
        for x in range(0, width, step):
            # Get the average brightness in the corresponding block of the source image
            block = base_img[y:y+step, x:x+step]
            if block.size == 0: continue
            avg_brightness = np.mean(block)

            # Calculate dot radius based on darkness (darker area = bigger dot)
            radius = int((step / 2.5) * (1 - avg_brightness / 255))

            # Draw the dot if it has a radius
            if radius > 0:
                cv2.circle(output_canvas, (x + step//2, y + step//2), radius, (0, 0, 0), -1)

    return output_canvas

# Global variable to signal the thread to stop
stop_thread = False
# Global variable for the visual mode
VISUAL_MODE = 1
# Global dictionary for video filter settings
FILTER_SETTINGS = {
    'posterize_enabled': False,
    'posterize_levels': 8,
    'threshold_enabled': False,
    'threshold_value': 127,
    'video_opacity': 1.0,
    'mirror_video': True
}

# Initialize MediaPipe components
mp_holistic = mp.solutions.holistic
mp_drawing = mp.solutions.drawing_utils

def list_cameras():
    """Tries to find all available camera devices."""
    index = 0
    arr = []
    while index < 10:  # Check up to 10 devices
        cap = cv2.VideoCapture(index)
        if cap.isOpened():
            arr.append(index)
            cap.release()
        index += 1
    return arr

def cv_thread_logic(window, camera_index):
    """
    This function runs in a separate thread.
    It captures video, processes landmarks, sends frames to the UI,
    and broadcasts landmark data via WebSockets.
    """
    global stop_thread, VISUAL_MODE, FILTER_SETTINGS
    cap = cv2.VideoCapture(int(camera_index))

    # Reduce frame size for performance
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

    # State for various modes
    particles = [] # Mode 4
    prev_pose_landmarks = None # Mode 4 & 8
    bubbles = [] # Mode 6
    matrix_streams = [] # Mode 7
    emoji_particles = [] # Mode 8

    # Cache to detect mode change and reset state
    last_visual_mode = -1
    start_time = time.time()

    with mp_holistic.Holistic(
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5
    ) as holistic:
        while not stop_thread:
            # On mode change, reset states
            if last_visual_mode != VISUAL_MODE:
                particles.clear()
                bubbles.clear()
                matrix_streams.clear()
                emoji_particles.clear()
                prev_pose_landmarks = None
                last_visual_mode = VISUAL_MODE

            success, image = cap.read()
            if not success:
                time.sleep(0.1)
                continue

            # Flip the image horizontally for a selfie-view display, if enabled
            if FILTER_SETTINGS['mirror_video']:
                image = cv2.flip(image, 1)

            # --- APPLY CUSTOM FILTERS ---
            if FILTER_SETTINGS['posterize_enabled']:
                levels = max(2, FILTER_SETTINGS['posterize_levels'])
                div = 256 // levels
                if div == 0: div = 1
                image = np.uint8((image // div) * div + div // 2)

            if FILTER_SETTINGS['threshold_enabled']:
                gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
                _, thresh_img = cv2.threshold(gray, FILTER_SETTINGS['threshold_value'], 255, cv2.THRESH_BINARY)
                image = cv2.cvtColor(thresh_img, cv2.COLOR_GRAY2BGR)

            # --- VIDEO OPACITY --- 
            opacity = FILTER_SETTINGS.get('video_opacity', 1.0)
            output_image = (image * opacity).astype(np.uint8)

            # For performance, mark the image as not writeable to pass by reference.
            image.flags.writeable = False
            image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

            # Process the image and find landmarks
            results = holistic.process(image_rgb)

            image.flags.writeable = True

            # --- VISUAL MODE LOGIC ---
            height, width, _ = image.shape

            if VISUAL_MODE == 1: # Default: Video feed with pose
                mp_drawing.draw_landmarks(
                    output_image,
                    results.pose_landmarks,
                    mp_holistic.POSE_CONNECTIONS,
                    landmark_drawing_spec=mp_drawing.DrawingSpec(color=(245,117,66), thickness=2, circle_radius=2),
                    connection_drawing_spec=mp_drawing.DrawingSpec(color=(245,66,230), thickness=2, circle_radius=2)
                )
                if results.face_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.face_landmarks, mp_holistic.FACEMESH_CONTOURS, landmark_drawing_spec=None, connection_drawing_spec=mp_drawing.DrawingSpec(color=(80,255,121), thickness=1))
                if results.left_hand_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.left_hand_landmarks, mp_holistic.HAND_CONNECTIONS, landmark_drawing_spec=mp_drawing.DrawingSpec(color=(245,117,66), thickness=2, circle_radius=2), connection_drawing_spec=mp_drawing.DrawingSpec(color=(245,66,230), thickness=2, circle_radius=2))
                if results.right_hand_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.right_hand_landmarks, mp_holistic.HAND_CONNECTIONS, landmark_drawing_spec=mp_drawing.DrawingSpec(color=(245,117,66), thickness=2, circle_radius=2), connection_drawing_spec=mp_drawing.DrawingSpec(color=(245,66,230), thickness=2, circle_radius=2))

            elif VISUAL_MODE == 2: # Black background with pose
                mp_drawing.draw_landmarks(
                    output_image,
                    results.pose_landmarks,
                    mp_holistic.POSE_CONNECTIONS,
                    landmark_drawing_spec=mp_drawing.DrawingSpec(color=(245,117,66), thickness=2, circle_radius=2),
                    connection_drawing_spec=mp_drawing.DrawingSpec(color=(245,66,230), thickness=2, circle_radius=2)
                )
                if results.face_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.face_landmarks, mp_holistic.FACEMESH_CONTOURS, landmark_drawing_spec=None, connection_drawing_spec=mp_drawing.DrawingSpec(color=(80,255,121), thickness=1))
                if results.left_hand_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.left_hand_landmarks, mp_holistic.HAND_CONNECTIONS, landmark_drawing_spec=mp_drawing.DrawingSpec(color=(245,117,66), thickness=2, circle_radius=2), connection_drawing_spec=mp_drawing.DrawingSpec(color=(245,66,230), thickness=2, circle_radius=2))
                if results.right_hand_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.right_hand_landmarks, mp_holistic.HAND_CONNECTIONS, landmark_drawing_spec=mp_drawing.DrawingSpec(color=(245,117,66), thickness=2, circle_radius=2), connection_drawing_spec=mp_drawing.DrawingSpec(color=(245,66,230), thickness=2, circle_radius=2))

            elif VISUAL_MODE == 3: # Neon mode
                if results.pose_landmarks:
                    glow_canvas = np.zeros_like(output_image)
                    # Draw thick lines for the glow effect
                    mp_drawing.draw_landmarks(
                        glow_canvas, results.pose_landmarks, mp_holistic.POSE_CONNECTIONS,
                        connection_drawing_spec=mp_drawing.DrawingSpec(color=(255,0,255), thickness=10)
                    )
                    mp_drawing.draw_landmarks(
                        glow_canvas, results.pose_landmarks, mp_holistic.POSE_CONNECTIONS,
                        connection_drawing_spec=mp_drawing.DrawingSpec(color=(0,255,255), thickness=10)
                    )
                    # Blur the thick lines to create a glow
                    blurred_glow = cv2.GaussianBlur(glow_canvas, (55, 55), 0)
                    output_image = cv2.addWeighted(output_image, 1, blurred_glow, 1, 0)
                    # Draw the main skeleton on top
                    mp_drawing.draw_landmarks(
                        output_image, results.pose_landmarks, mp_holistic.POSE_CONNECTIONS,
                        landmark_drawing_spec=mp_drawing.DrawingSpec(color=(255,255,255), thickness=1, circle_radius=1),
                        connection_drawing_spec=mp_drawing.DrawingSpec(color=(255,255,255), thickness=2)
                    )
                    if results.face_landmarks:
                        mp_drawing.draw_landmarks(output_image, results.face_landmarks, mp_holistic.FACEMESH_CONTOURS, landmark_drawing_spec=None, connection_drawing_spec=mp_drawing.DrawingSpec(color=(255,255,255), thickness=1))
                    if results.left_hand_landmarks:
                        mp_drawing.draw_landmarks(output_image, results.left_hand_landmarks, mp_holistic.HAND_CONNECTIONS, landmark_drawing_spec=mp_drawing.DrawingSpec(color=(255,255,255), thickness=1, circle_radius=1), connection_drawing_spec=mp_drawing.DrawingSpec(color=(255,255,255), thickness=2))
                    if results.right_hand_landmarks:
                        mp_drawing.draw_landmarks(output_image, results.right_hand_landmarks, mp_holistic.HAND_CONNECTIONS, landmark_drawing_spec=mp_drawing.DrawingSpec(color=(255,255,255), thickness=1, circle_radius=1), connection_drawing_spec=mp_drawing.DrawingSpec(color=(255,255,255), thickness=2))

            elif VISUAL_MODE == 4: # Gh0st M0de
                # Update and draw particles
                particles_to_keep = []
                for p in particles:
                    p['x'] += p['vx']
                    p['y'] += p['vy']
                    p['vy'] += 0.3  # Gravity
                    p['lifespan'] -= 1
                    if p['lifespan'] > 0:
                        particles_to_keep.append(p)
                        cv2.circle(output_image, (int(p['x']), int(p['y'])), radius=2, color=(200, 200, 200), thickness=-1)
                particles = particles_to_keep

                if results.pose_landmarks:
                    pose_canvas = np.zeros_like(output_image)
                    mp_drawing.draw_landmarks(
                        pose_canvas, results.pose_landmarks, mp_holistic.POSE_CONNECTIONS,
                        landmark_drawing_spec=mp_drawing.DrawingSpec(color=(255,255,255), thickness=-1, circle_radius=4),
                        connection_drawing_spec=mp_drawing.DrawingSpec(color=(255,255,255), thickness=8)
                    )
                    blurred_pose = cv2.GaussianBlur(pose_canvas, (101, 101), 0)
                    output_image = cv2.add(output_image, blurred_pose)

                    if prev_pose_landmarks:
                        for lm_enum in [mp_holistic.PoseLandmark.LEFT_WRIST, mp_holistic.PoseLandmark.RIGHT_WRIST]:
                            current_lm = results.pose_landmarks.landmark[lm_enum.value]
                            prev_lm = prev_pose_landmarks.landmark[lm_enum.value]
                            if current_lm.visibility > 0.5 and prev_lm.visibility > 0.5:
                                cx, cy = int(current_lm.x * width), int(current_lm.y * height)
                                px, py = int(prev_lm.x * width), int(prev_lm.y * height)
                                if ((cx - px)**2 + (cy - py)**2)**0.5 > 15:
                                    for _ in range(5):
                                        particles.append({'x': cx, 'y': cy, 'vx': random.uniform(-2, 2) + (cx - px) * 0.1, 'vy': random.uniform(-3, 1) + (cy - py) * 0.1, 'lifespan': random.randint(30, 60)})
                    prev_pose_landmarks = results.pose_landmarks
                else:
                    prev_pose_landmarks = None

            elif VISUAL_MODE == 5: # Rainbow Unicorn Mode
                elapsed_time = time.time() - start_time
                if results.pose_landmarks:
                    for i, conn in enumerate(mp_holistic.POSE_CONNECTIONS):
                        start_idx = conn[0]
                        end_idx = conn[1]
                        start_lm = results.pose_landmarks.landmark[start_idx]
                        end_lm = results.pose_landmarks.landmark[end_idx]
                        if start_lm.visibility > 0.5 and end_lm.visibility > 0.5:
                            p1 = (int(start_lm.x * width), int(start_lm.y * height))
                            p2 = (int(end_lm.x * width), int(end_lm.y * height))
                            hue = int((elapsed_time * 50 + i * 10) % 180)
                            color_bgr = cv2.cvtColor(np.uint8([[[hue, 255, 255]]]), cv2.COLOR_HSV2BGR)[0][0]
                            cv2.line(output_image, p1, p2, color_bgr.tolist(), 3)
                    mp_drawing.draw_landmarks(output_image, results.pose_landmarks, landmark_drawing_spec=mp_drawing.DrawingSpec(color=(255, 255, 255), thickness=2, circle_radius=2))
                
                pink_spec = mp_drawing.DrawingSpec(color=(255, 192, 203), thickness=2, circle_radius=2)
                if results.face_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.face_landmarks, mp_holistic.FACEMESH_CONTOURS, landmark_drawing_spec=None, connection_drawing_spec=mp_drawing.DrawingSpec(color=(255, 192, 203), thickness=1))
                if results.left_hand_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.left_hand_landmarks, mp_holistic.HAND_CONNECTIONS, landmark_drawing_spec=pink_spec, connection_drawing_spec=pink_spec)
                if results.right_hand_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.right_hand_landmarks, mp_holistic.HAND_CONNECTIONS, landmark_drawing_spec=pink_spec, connection_drawing_spec=pink_spec)

            elif VISUAL_MODE == 6: # Underwater Mode
                overlay = output_image.copy()
                cv2.rectangle(overlay, (0, 0), (width, height), (100, 60, 0), -1)
                output_image = cv2.addWeighted(overlay, 0.6, output_image, 0.4, 0)
                if random.random() < 0.3:
                    bubbles.append({'x': random.randint(0, width), 'y': height, 'r': random.randint(2, 8), 'vy': random.uniform(-4, -1)})
                bubbles_to_keep = []
                for b in bubbles:
                    b['y'] += b['vy']; b['x'] += random.uniform(-1, 1)
                    if b['y'] > 0:
                        bubbles_to_keep.append(b)
                        cv2.circle(output_image, (int(b['x']), int(b['y'])), b['r'], (200, 200, 200), 1)
                bubbles = bubbles_to_keep
                mp_drawing.draw_landmarks(output_image, results.pose_landmarks, mp_holistic.POSE_CONNECTIONS, landmark_drawing_spec=mp_drawing.DrawingSpec(color=(200,200,200), thickness=2, circle_radius=2), connection_drawing_spec=mp_drawing.DrawingSpec(color=(255,255,255), thickness=2, circle_radius=2))
                if results.face_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.face_landmarks, mp_holistic.FACEMESH_CONTOURS, landmark_drawing_spec=None, connection_drawing_spec=mp_drawing.DrawingSpec(color=(200,200,200), thickness=1))
                hand_spec = {'landmark_drawing_spec': mp_drawing.DrawingSpec(color=(200,200,200), thickness=2, circle_radius=2), 'connection_drawing_spec': mp_drawing.DrawingSpec(color=(255,255,255), thickness=2, circle_radius=2)}
                if results.left_hand_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.left_hand_landmarks, mp_holistic.HAND_CONNECTIONS, **hand_spec)
                if results.right_hand_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.right_hand_landmarks, mp_holistic.HAND_CONNECTIONS, **hand_spec)

            elif VISUAL_MODE == 7: # Matrix Mode
                if not matrix_streams:
                    matrix_chars = [chr(i) for i in range(0x30A0, 0x30FF)]
                    matrix_streams = [{'x': random.randint(0, width), 'y': random.randint(-height, 0), 's': random.randint(2, 6), 'c': random.choice(matrix_chars)} for _ in range(100)]
                for stream in matrix_streams:
                    cv2.putText(output_image, stream['c'], (stream['x'], stream['y']), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
                    stream['y'] += stream['s']
                    if stream['y'] > height:
                        stream['y'] = random.randint(-100, 0); stream['x'] = random.randint(0, width)
                mp_drawing.draw_landmarks(output_image, results.pose_landmarks, mp_holistic.POSE_CONNECTIONS, landmark_drawing_spec=mp_drawing.DrawingSpec(color=(0,255,0), thickness=1, circle_radius=1), connection_drawing_spec=mp_drawing.DrawingSpec(color=(0,255,0), thickness=2))
                if results.face_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.face_landmarks, mp_holistic.FACEMESH_CONTOURS, landmark_drawing_spec=None, connection_drawing_spec=mp_drawing.DrawingSpec(color=(0,255,0), thickness=1))
                hand_spec = {'landmark_drawing_spec': mp_drawing.DrawingSpec(color=(0,255,0), thickness=1, circle_radius=1), 'connection_drawing_spec': mp_drawing.DrawingSpec(color=(0,255,0), thickness=2)}
                if results.left_hand_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.left_hand_landmarks, mp_holistic.HAND_CONNECTIONS, **hand_spec)
                if results.right_hand_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.right_hand_landmarks, mp_holistic.HAND_CONNECTIONS, **hand_spec)

            elif VISUAL_MODE == 8: # Party Mode
                particles_to_keep = []
                for p in emoji_particles:
                    p['x'] += p['vx']; p['y'] += p['vy']; p['vy'] += 0.2; p['life'] -= 1
                    if p['life'] > 0:
                        particles_to_keep.append(p)
                        overlay = output_image.copy()
                        cv2.circle(overlay, (int(p['x']), int(p['y'])), p['r'], p['color'], -1)
                        output_image = cv2.addWeighted(overlay, p['life']/60.0, output_image, 1-p['life']/60.0, 0)
                emoji_particles = particles_to_keep
                if results.pose_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.pose_landmarks, mp_holistic.POSE_CONNECTIONS, landmark_drawing_spec=mp_drawing.DrawingSpec(color=(255,192,203), thickness=2, circle_radius=4), connection_drawing_spec=mp_drawing.DrawingSpec(color=(255,255,0), thickness=3))
                    if results.face_landmarks:
                        mp_drawing.draw_landmarks(output_image, results.face_landmarks, mp_holistic.FACEMESH_CONTOURS, landmark_drawing_spec=None, connection_drawing_spec=mp_drawing.DrawingSpec(color=(255,255,0), thickness=1))
                    hand_spec = {'landmark_drawing_spec': mp_drawing.DrawingSpec(color=(255,192,203), thickness=2, circle_radius=4), 'connection_drawing_spec': mp_drawing.DrawingSpec(color=(255,255,0), thickness=3)}
                    if results.left_hand_landmarks:
                        mp_drawing.draw_landmarks(output_image, results.left_hand_landmarks, mp_holistic.HAND_CONNECTIONS, **hand_spec)
                    if results.right_hand_landmarks:
                        mp_drawing.draw_landmarks(output_image, results.right_hand_landmarks, mp_holistic.HAND_CONNECTIONS, **hand_spec)

                    if prev_pose_landmarks:
                        for lm_enum in [mp_holistic.PoseLandmark.LEFT_WRIST, mp_holistic.PoseLandmark.RIGHT_WRIST]:
                            curr = results.pose_landmarks.landmark[lm_enum.value]
                            prev = prev_pose_landmarks.landmark[lm_enum.value]
                            if curr.visibility > 0.5 and prev.visibility > 0.5:
                                cx, cy = int(curr.x * width), int(curr.y * height)
                                px, py = int(prev.x * width), int(prev.y * height)
                                if ((cx-px)**2 + (cy-py)**2)**0.5 > 10:
                                    for _ in range(3):
                                        emoji_particles.append({'x': cx, 'y': cy, 'vx': random.uniform(-3,3), 'vy': random.uniform(-4,-1), 'life': random.randint(30,60), 'r': random.randint(5,15), 'color': (random.randint(100,255), random.randint(100,255), random.randint(100,255))})
                    prev_pose_landmarks = results.pose_landmarks
                else:
                    prev_pose_landmarks = None

            elif VISUAL_MODE == 9: # P for Punk Mode
                # Apply high contrast filters: posterize @ 2 and threshold @ 127
                levels = 2
                div = 256 // levels
                if div == 0: div = 1
                posterized_img = np.uint8((image // div) * div + div // 2)

                gray = cv2.cvtColor(posterized_img, cv2.COLOR_BGR2GRAY)
                _, thresh_img = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
                output_image_base = cv2.cvtColor(thresh_img, cv2.COLOR_GRAY2BGR)

                # Blend with the main output_image based on opacity
                output_image = cv2.addWeighted(output_image, 1.0, output_image_base, 1.0, 0)

                # Draw a high-contrast skeleton on top
                mp_drawing.draw_landmarks(
                    output_image, results.pose_landmarks, mp_holistic.POSE_CONNECTIONS,
                    landmark_drawing_spec=mp_drawing.DrawingSpec(color=(255,0,0), thickness=2, circle_radius=3),
                    connection_drawing_spec=mp_drawing.DrawingSpec(color=(255,255,255), thickness=4)
                )
                if results.face_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.face_landmarks, mp_holistic.FACEMESH_CONTOURS, landmark_drawing_spec=None, connection_drawing_spec=mp_drawing.DrawingSpec(color=(255,255,255), thickness=1))
                hand_spec = {'landmark_drawing_spec': mp_drawing.DrawingSpec(color=(255,0,0), thickness=2, circle_radius=3), 'connection_drawing_spec': mp_drawing.DrawingSpec(color=(255,255,255), thickness=4)}
                if results.left_hand_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.left_hand_landmarks, mp_holistic.HAND_CONNECTIONS, **hand_spec)
                if results.right_hand_landmarks:
                    mp_drawing.draw_landmarks(output_image, results.right_hand_landmarks, mp_holistic.HAND_CONNECTIONS, **hand_spec)

            elif VISUAL_MODE == 10: # C for Comic Mode
                comic_effect_image = apply_comic_effect(image)
                # Blend with the main output_image based on opacity
                output_image = cv2.addWeighted(output_image, 1.0, comic_effect_image, 1.0, 0)

                # Draw skeleton on top with thick black lines to match comic style
                if results.pose_landmarks:
                    mp_drawing.draw_landmarks(
                        output_image, results.pose_landmarks, mp_holistic.POSE_CONNECTIONS,
                        landmark_drawing_spec=mp_drawing.DrawingSpec(color=(0,0,0), thickness=-1, circle_radius=5),
                        connection_drawing_spec=mp_drawing.DrawingSpec(color=(0,0,0), thickness=6)
                    )
                    if results.face_landmarks:
                        mp_drawing.draw_landmarks(output_image, results.face_landmarks, mp_holistic.FACEMESH_CONTOURS, landmark_drawing_spec=None, connection_drawing_spec=mp_drawing.DrawingSpec(color=(0,0,0), thickness=2))
                    hand_spec = {'landmark_drawing_spec': mp_drawing.DrawingSpec(color=(0,0,0), thickness=-1, circle_radius=5), 'connection_drawing_spec': mp_drawing.DrawingSpec(color=(0,0,0), thickness=6)}
                    if results.left_hand_landmarks:
                        mp_drawing.draw_landmarks(output_image, results.left_hand_landmarks, mp_holistic.HAND_CONNECTIONS, **hand_spec)
                    if results.right_hand_landmarks:
                        mp_drawing.draw_landmarks(output_image, results.right_hand_landmarks, mp_holistic.HAND_CONNECTIONS, **hand_spec)

            # --- Data Broadcasting --- 
            final_data = {}

            # Extract and format world landmarks
            if results.pose_world_landmarks:
                landmark_names = [landmark.name for landmark in mp_holistic.PoseLandmark]
                landmarks_data = [{'name': landmark_names[i].lower(), 'x': lm.x, 'y': lm.y, 'z': lm.z, 'visibility': lm.visibility} for i, lm in enumerate(results.pose_world_landmarks.landmark)]
                final_data['landmarks'] = landmarks_data

            # Calculate mouth openness from face landmarks
            if results.face_landmarks:
                face_landmarks = results.face_landmarks.landmark
                # Relevant landmarks for mouth openness calculation
                upper_lip_lm = face_landmarks[13] # Upper lip inner
                lower_lip_lm = face_landmarks[14] # Lower lip inner
                left_corner_lm = face_landmarks[61] # Left mouth corner
                right_corner_lm = face_landmarks[291] # Right mouth corner

                # Calculate vertical distance between lips (mouth height)
                lip_dist_y = abs(upper_lip_lm.y - lower_lip_lm.y)
                # Calculate horizontal distance between mouth corners (mouth width)
                mouth_width_x = abs(left_corner_lm.x - right_corner_lm.x)

                mouth_openness = 0.0
                if mouth_width_x > 0.01: # Avoid division by zero
                    # Normalize openness ratio
                    ratio = lip_dist_y / mouth_width_x
                    # Scale and clamp the value for a more usable 0-1 range
                    mouth_openness = np.clip((ratio - 0.15) * 4, 0, 1)
                
                final_data['mouth'] = {'openness': mouth_openness}

            # Broadcast if there is any data to send
            if final_data:
                broadcast_landmarks(json.dumps(final_data))

            # Encode the final frame to send to the pywebview UI
            _, buffer = cv2.imencode('.jpg', output_image)
            b64_frame = base64.b64encode(buffer).decode('utf-8')

            try:
                window.evaluate_js(f'update_video_feed("{b64_frame}")')
            except Exception as e:
                if not stop_thread: print(f"Error calling JS: {e}")
                stop_thread = True

            time.sleep(0.03)

    cap.release()
    print("CV thread finished.")

class Api:
    def __init__(self):
        self.cv_thread = None
        self.window = None

    def get_cameras(self):
        print("Scanning for cameras...")
        cameras = list_cameras()
        print(f"Found cameras: {cameras}")
        return json.dumps([{"id": i, "name": f"Camera {i}"} for i in cameras])

    def start_capture(self, camera_index):
        global stop_thread, websocket_server_started, websocket_server_thread
        if self.cv_thread and self.cv_thread.is_alive():
            return
        print(f"Starting capture on camera index: {camera_index}")
        if not websocket_server_started:
            websocket_server_thread = start_websocket_server_in_thread()
            websocket_server_started = True
            time.sleep(1)
        stop_thread = False
        self.window = webview.windows[0]
        self.cv_thread = threading.Thread(target=cv_thread_logic, args=(self.window, camera_index,))
        self.cv_thread.start()

    def stop_capture(self):
        global stop_thread
        print("Signaling CV thread to stop...")
        stop_thread = True

    def toggle_fullscreen(self):
        if self.window:
            self.window.toggle_fullscreen()

    def set_visual_mode(self, mode):
        global VISUAL_MODE
        mode_map = {
            '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
            'p': 9, 'c': 10
        }
        mode_key = str(mode).lower()
        if mode_key in mode_map:
            VISUAL_MODE = mode_map[mode_key]
            print(f"Visual mode set to: {VISUAL_MODE} (key: {mode_key})")
        else:
            print(f"Invalid mode key: {mode}")

    def set_filter_settings(self, settings):
        global FILTER_SETTINGS
        try:
            FILTER_SETTINGS['posterize_enabled'] = bool(settings.get('posterize_enabled', False))
            FILTER_SETTINGS['posterize_levels'] = int(settings.get('posterize_levels', 8))
            FILTER_SETTINGS['threshold_enabled'] = bool(settings.get('threshold_enabled', False))
            FILTER_SETTINGS['threshold_value'] = int(settings.get('threshold_value', 127))
            FILTER_SETTINGS['video_opacity'] = float(settings.get('video_opacity', 100)) / 100.0
            if 'mirror_video' in settings:
                FILTER_SETTINGS['mirror_video'] = bool(settings['mirror_video'])
            # print(f"Filter settings updated: {FILTER_SETTINGS}") # Optional: for debugging
        except Exception as e:
            print(f"Error updating filter settings: {e}")

api = Api()

def on_closing():
    api.stop_capture()

if __name__ == '__main__':
    script_dir = os.path.dirname(os.path.abspath(__file__))
    gui_path = os.path.join(script_dir, 'gui', 'index.html')
    window = webview.create_window('Camera Character', url=gui_path, js_api=api, width=800, height=700, resizable=True)
    window.events.closing += on_closing
    webview.start(debug=True)
    print("Main window closed. Exiting application.")
    if api.cv_thread and api.cv_thread.is_alive():
        api.cv_thread.join()
