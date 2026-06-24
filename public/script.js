document.addEventListener('DOMContentLoaded', () => {
    const uploadForm = document.getElementById('uploadForm');
    const videoInput = document.getElementById('videoInput');
    const photosInput = document.getElementById('photosInput');
    const videoDropZone = document.getElementById('videoDropZone');
    const photosDropZone = document.getElementById('photosDropZone');
    const videoInfo = document.getElementById('videoInfo');
    const photosInfo = document.getElementById('photosInfo');
    const submitBtn = document.getElementById('submitBtn');
    const statusSection = document.getElementById('statusSection');
    const statusTitle = document.getElementById('statusTitle');
    const progressFill = document.querySelector('.fill');
    const steps = document.querySelectorAll('.step-item');
    const resultArea = document.getElementById('resultArea');
    const downloadBtn = document.getElementById('downloadBtn');
    const resetBtn = document.getElementById('resetBtn');

    // Handle Drop Zones
    [videoDropZone, photosDropZone].forEach(zone => {
        zone.addEventListener('click', () => {
            const input = zone.querySelector('input');
            input.click();
        });

        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('dragover');
        });

        zone.addEventListener('dragleave', () => {
            zone.classList.remove('dragover');
        });

        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('dragover');
            const input = zone.querySelector('input');
            input.files = e.dataTransfer.files;
            input.dispatchEvent(new Event('change'));
        });
    });

    videoInput.addEventListener('change', () => {
        if (videoInput.files.length > 0) {
            videoInfo.textContent = `Selected: ${videoInput.files[0].name}`;
        }
    });

    photosInput.addEventListener('change', () => {
        if (photosInput.files.length > 0) {
            photosInfo.textContent = `${photosInput.files.length} photos selected`;
        }
    });

    // Form Submission
    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const formData = new FormData();
        formData.append('video', videoInput.files[0]);
        for (let i = 0; i < photosInput.files.length; i++) {
            formData.append('photos', photosInput.files[i]);
        }

        // UI State: Loading
        submitBtn.disabled = true;
        submitBtn.classList.add('loading');
        statusSection.classList.remove('hidden');
        resultArea.classList.add('hidden');
        resetProgress();

        // Start Fake Progress
        const progressInterval = simulateProgress();

        try {
            const response = await fetch('/upload-and-process', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Upload failed');
            }

            const { requestId } = await response.json();
            
            // Polling loop
            const poll = async () => {
                try {
                    const statusRes = await fetch(`/status/${requestId}`);
                    const data = await statusRes.json();
                    
                    if (data.status === 'completed') {
                        clearInterval(progressInterval);
                        completeProgress();
                        showResult(data.result.downloadUrl);
                    } else if (data.status === 'failed') {
                        clearInterval(progressInterval);
                        throw new Error(data.error || 'Processing failed');
                    } else {
                        // Still processing or queued
                        setTimeout(poll, 2000); // Poll every 2 seconds
                    }
                } catch (err) {
                    clearInterval(progressInterval);
                    alert(`Error: ${err.message}`);
                    submitBtn.disabled = false;
                    submitBtn.classList.remove('loading');
                    statusSection.classList.add('hidden');
                }
            };
            
            poll();

        } catch (error) {
            clearInterval(progressInterval);
            alert(`Error: ${error.message}`);
            submitBtn.disabled = false;
            submitBtn.classList.remove('loading');
            statusSection.classList.add('hidden');
        }
    });

    resetBtn.addEventListener('click', () => {
        uploadForm.reset();
        videoInfo.textContent = '';
        photosInfo.textContent = '';
        statusSection.classList.add('hidden');
        submitBtn.disabled = false;
        submitBtn.classList.remove('loading');
    });

    function resetProgress() {
        progressFill.style.width = '0%';
        steps.forEach(s => s.classList.remove('active', 'done'));
    }

    function simulateProgress() {
        let percent = 0;
        const interval = setInterval(() => {
            if (percent < 90) {
                percent += Math.random() * 2;
                progressFill.style.width = `${percent}%`;
                
                // Update steps based on percentage
                if (percent > 10) setActiveStep(1);
                if (percent > 30) setActiveStep(2);
                if (percent > 60) setActiveStep(3);
                if (percent > 80) setActiveStep(4);
            }
        }, 1500);
        return interval;
    }

    function setActiveStep(stepNum) {
        steps.forEach((s, idx) => {
            if (idx + 1 < stepNum) {
                s.classList.add('done');
                s.classList.remove('active');
            } else if (idx + 1 === stepNum) {
                s.classList.add('active');
            }
        });
    }

    function completeProgress() {
        progressFill.style.width = '100%';
        steps.forEach(s => {
            s.classList.add('done');
            s.classList.remove('active');
        });
    }

    function showResult(url) {
        statusTitle.textContent = "Processing Complete!";
        resultArea.classList.remove('hidden');
        downloadBtn.href = url;
    }
});
