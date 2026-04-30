window.addEventListener('pywebviewready', () => {
    const selectorView = document.getElementById('selector-view');
    const captureView = document.getElementById('capture-view');
    const cameraSelect = document.getElementById('camera-select');
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const changeCameraBtn = document.getElementById('change-camera-btn');
    
    // Filter controls
    const mirrorToggle = document.getElementById('mirror-toggle');
    const posterizeToggle = document.getElementById('posterize-toggle');
    const posterizeSlider = document.getElementById('posterize-slider');
    const posterizeValue = document.getElementById('posterize-value');
    const thresholdToggle = document.getElementById('threshold-toggle');
    const thresholdSlider = document.getElementById('threshold-slider');
    const thresholdValue = document.getElementById('threshold-value');
    const opacitySlider = document.getElementById('opacity-slider');
    const opacityValue = document.getElementById('opacity-value');

    function populateCameras() {
        return pywebview.api.get_cameras().then(camerasJson => {
            const cameras = JSON.parse(camerasJson);
            cameraSelect.innerHTML = ''; // Clear previous options
            if (cameras.length > 0) {
                cameras.forEach(camera => {
                    const option = document.createElement('option');
                    option.value = camera.id;
                    option.textContent = camera.name;
                    cameraSelect.appendChild(option);
                });
                startBtn.disabled = false;
            } else {
                const option = document.createElement('option');
                option.textContent = 'No cameras found';
                option.disabled = true;
                cameraSelect.appendChild(option);
                startBtn.disabled = true;
            }
        }).catch(e => {
            console.error('Failed to get cameras:', e);
            startBtn.disabled = true;
            startBtn.textContent = 'Error loading cameras';
        });
    }

    // Auto-start with camera 2
    pywebview.api.start_capture(2);
    selectorView.classList.remove('active');
    captureView.classList.add('active');

    // Handle start button click (from selector view)
    startBtn.addEventListener('click', () => {
        const selectedCameraIndex = cameraSelect.value;
        if (selectedCameraIndex !== null && selectedCameraIndex !== '') {
            pywebview.api.start_capture(selectedCameraIndex);
            selectorView.classList.remove('active');
            captureView.classList.add('active');
        }
    });

    // Handle change camera button click
    changeCameraBtn.addEventListener('click', () => {
        pywebview.api.stop_capture().then(() => {
            // Switch views
            captureView.classList.remove('active');
            selectorView.classList.add('active');
            // Populate camera list for selection
            populateCameras();
        });
    });

    // Handle stop button click
    stopBtn.addEventListener('click', () => {
        // This will trigger the 'on_closing' event in Python, allowing for graceful shutdown.
        window.close();
    });

    // Handle fullscreen button click
    fullscreenBtn.addEventListener('click', () => {
        pywebview.api.toggle_fullscreen();
    });

    // Handle keyboard shortcuts for visual modes
    window.addEventListener('keydown', (e) => {
        // Check for number keys 1-8, 'p', or 'c' (case-insensitive)
        if (/^[1-8pc]$/i.test(e.key)) {
            // Only send command if capture view is active and not typing in an input
            if (captureView.classList.contains('active') && !e.target.matches('input')) {
                pywebview.api.set_visual_mode(e.key);
            }
        }
    });

    // --- Filter Controls Logic ---
    function sendFilterSettings() {
        const settings = {
            mirror_video: mirrorToggle.checked,
            posterize_enabled: posterizeToggle.checked,
            posterize_levels: parseInt(posterizeSlider.value, 10),
            threshold_enabled: thresholdToggle.checked,
            threshold_value: parseInt(thresholdSlider.value, 10),
            video_opacity: parseInt(opacitySlider.value, 10)
        };
        pywebview.api.set_filter_settings(settings);
    }

    function setupFilterListeners() {
        mirrorToggle.addEventListener('change', sendFilterSettings);
        
        posterizeSlider.addEventListener('input', () => {
            posterizeValue.textContent = posterizeSlider.value;
            sendFilterSettings();
        });
        posterizeToggle.addEventListener('change', sendFilterSettings);

        thresholdSlider.addEventListener('input', () => {
            thresholdValue.textContent = thresholdSlider.value;
            sendFilterSettings();
        });
        thresholdToggle.addEventListener('change', sendFilterSettings);

        opacitySlider.addEventListener('input', () => {
            opacityValue.textContent = opacitySlider.value;
            sendFilterSettings();
        });
    }

    setupFilterListeners();
});

// This function is called from Python to update the video feed image
function update_video_feed(base64_frame) {
    const videoFeed = document.getElementById('video-feed');
    if (videoFeed) {
        videoFeed.src = 'data:image/jpeg;base64,' + base64_frame;
    }
}
