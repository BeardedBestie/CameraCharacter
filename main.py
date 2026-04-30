import cv2
import numpy as np

def main():
    # 1) Ask for which camera before starting so it does not default
    cam_idx_str = input("Enter camera index to use (e.g., 0, 1) [Default: 0]: ")
    cam_idx = int(cam_idx_str) if cam_idx_str.strip().isdigit() else 0

    cap = cv2.VideoCapture(cam_idx)
    if not cap.isOpened():
        print(f"Error: Could not open camera {cam_idx}")
        return

    window_name = "3D Character Controller"
    cv2.namedWindow(window_name)

    # 2) Slider for Hip Y Offset
    # We start at an estimated base offset to raise the hips off the standing plane
    initial_offset = 100
    # Max offset of 300; the lambda acts as an empty callback
    cv2.createTrackbar("Hip Offset Y", window_name, initial_offset, 300, lambda x: None)

    print("Press 'q' to quit.")

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # --- Mock pose estimation logic (replace with your actual hip coordinates) ---
        base_hip_x = 320
        base_hip_y = 400

        # Get the current offset from the slider for tweaking
        offset_y = cv2.getTrackbarPos("Hip Offset Y", window_name)

        # Apply offset to raise the hips up from the ground/bottom plane
        # Subtracting offset_y because in OpenCV, a lower Y coordinate is physically higher on screen
        adjusted_hip_y = base_hip_y - offset_y

        # Draw the adjusted hip position for visualization
        cv2.circle(frame, (base_hip_x, adjusted_hip_y), 10, (0, 255, 0), -1)
        cv2.putText(frame, f"Adjusted Hip Y: {adjusted_hip_y}", (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)

        cv2.imshow(window_name, frame)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
