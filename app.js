let pyodide = null;
let audioContext = null;
let originalBuffer = null;
let correctedBuffer = null;
let source = null;
let isPlaying = false;
let recording = false;
let mediaRecorder = null;
let recordedChunks = [];
let animFrame = null;
let processingStart = 0;
let audioFile = null;

const $ = id => document.getElementById(id);
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const recordBtn = $('recordBtn');
const processBtn = $('processBtn');
const playBtn = $('playBtn');
const stopBtn = $('stopBtn');
const waveform = $('waveform');
const ctx = waveform.getContext('2d');
const strengthSlider = $('strengthSlider');
const stretchSlider = $('stretchSlider');
const strengthValue = $('strengthValue');
const stretchValue = $('stretchValue');
const currentTimeEl = $('currentTime');
const durationEl = $('duration');
const progressFill = $('progressFill');
const progressBar = $('progressBar');
const fileInfo = $('fileInfo');
const overlay = $('overlay');
const overlayText = $('overlayText');
const initOverlay = $('initOverlay');
const initText = $('initText');
const initProgressFill = $('initProgressFill');
const statusBadge = $('statusBadge');
const downloadPanel = $('downloadPanel');
const downloadBtn = $('downloadBtn');
const processingTime = $('processingTime');

async function init() {
    initText.textContent = 'Loading Python engine (Pyodide)...';
    initProgressFill.style.width = '10%';

    try {
        pyodide = await loadPyodide({
            indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.29.4/full/'
        });
        initProgressFill.style.width = '40%';
        initText.textContent = 'Loading NumPy and SciPy...';

        await pyodide.loadPackage(['numpy', 'scipy']);
        initProgressFill.style.width = '70%';
        initText.textContent = 'Loading autotune engine...';

        const resp = await fetch('autotune.py');
        const code = await resp.text();
        await pyodide.runPythonAsync(code);
        initProgressFill.style.width = '100%';

        setTimeout(() => {
            initOverlay.hidden = true;
            statusBadge.textContent = 'Ready';
            statusBadge.className = 'status-badge ready';
        }, 400);
    } catch (err) {
        initText.textContent = 'Failed to load: ' + err.message;
        initText.style.color = 'var(--red)';
        console.error(err);
    }
}

function getAudioContext() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
    return audioContext;
}

function setStatus(text, type) {
    statusBadge.textContent = text;
    statusBadge.className = 'status-badge' + (type ? ' ' + type : '');
}

function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
}

function drawWaveform(buffer, color, offsetY, height, alpha) {
    const data = buffer.getChannelData(0);
    const w = waveform.width;
    const h = waveform.height;
    const step = Math.max(1, Math.floor(data.length / w));
    const mid = offsetY + height / 2;
    const ampScale = height * 0.9;

    ctx.globalAlpha = alpha || 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    for (let x = 0; x < w; x++) {
        const idx = Math.floor(x * step);
        const sample = data[idx] || 0;
        const y = mid - sample * ampScale / 2;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    for (let x = 0; x < w; x++) {
        const idx = Math.floor(x * step);
        const sample = data[idx] || 0;
        const y = mid + sample * ampScale / 2;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
}

function renderWaveforms() {
    const rect = waveform.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    waveform.width = (rect.width - 32) * dpr;
    waveform.height = (rect.height - 48) * dpr;
    waveform.style.width = (rect.width - 32) + 'px';
    waveform.style.height = (rect.height - 48) + 'px';

    ctx.clearRect(0, 0, waveform.width, waveform.height);
    ctx.scale(dpr, dpr);

    const w = parseInt(waveform.style.width);
    const h = parseInt(waveform.style.height);

    if (originalBuffer) {
        drawWaveform(originalBuffer, 'var(--wave-original)', 0, h / 2, 0.7);
    }
    if (correctedBuffer) {
        drawWaveform(correctedBuffer, 'var(--wave-corrected)', h / 2, h / 2, 0.9);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function loadFile(file) {
    audioFile = file;
    fileInfo.textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
    setStatus('Loaded', 'ready');

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const ctx_ = getAudioContext();
            const data = await ctx_.decodeAudioData(e.target.result);
            originalBuffer = data;
            correctedBuffer = null;
            downloadPanel.hidden = true;
            processBtn.disabled = false;

            durationEl.textContent = formatTime(data.duration);
            currentTimeEl.textContent = '0:00';
            progressFill.style.width = '0%';
            renderWaveforms();
        } catch (err) {
            fileInfo.textContent = 'Error: ' + err.message;
        }
    };
    reader.readAsArrayBuffer(file);
}

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0) loadFile(files[0]);
});

fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) loadFile(fileInput.files[0]);
});

recordBtn.addEventListener('click', async () => {
    if (recording) {
        mediaRecorder.stop();
        return;
    }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        recordedChunks = [];

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop());
            const blob = new Blob(recordedChunks, { type: 'audio/webm' });
            recording = false;
            recordBtn.textContent = 'Record';
            recordBtn.classList.remove('active');

            const file = new File([blob], 'recording.webm', { type: 'audio/webm' });
            loadFile(file);
        };

        mediaRecorder.start();
        recording = true;
        recordBtn.innerHTML = '<span class="record-dot"></span> Stop';
        recordBtn.classList.add('active');
    } catch (err) {
        fileInfo.textContent = 'Mic error: ' + err.message;
    }
});

strengthSlider.addEventListener('input', () => {
    strengthValue.textContent = strengthSlider.value + '%';
});

stretchSlider.addEventListener('input', () => {
    stretchValue.textContent = stretchSlider.value + '%';
});

processBtn.addEventListener('click', processAudio);

async function processAudio() {
    if (!originalBuffer || !pyodide) return;

    stopPlayback();
    overlay.hidden = false;
    overlayText.textContent = 'Processing...';
    setStatus('Processing', 'busy');
    processBtn.disabled = true;
    processingStart = performance.now();

    try {
        const src = originalBuffer.getChannelData(0);
        const sr = originalBuffer.sampleRate;
        const strength = strengthSlider.value / 100;
        const stretch = stretchSlider.value / 100;

        pyodide.globals.set('_aud_src', new Float64Array(src));
        pyodide.globals.set('_aud_sr', sr);
        pyodide.globals.set('_aud_str', strength);
        pyodide.globals.set('_aud_stretch', stretch);

        await pyodide.runPythonAsync(`
            import numpy as np
            audio = np.frombuffer(_aud_src, dtype=np.float64)
            result = autotune(audio, _aud_sr, _aud_str, _aud_stretch)
            result_list = result.tolist()
        `);

        const resultList = pyodide.globals.get('result_list');
        const correctedSamples = new Float32Array(resultList);
        pyodide.globals.delete('_aud_src');
        pyodide.globals.delete('_aud_sr');
        pyodide.globals.delete('_aud_str');
        pyodide.globals.delete('_aud_stretch');
        pyodide.globals.delete('result_list');

        const ctx_ = getAudioContext();
        correctedBuffer = ctx_.createBuffer(1, correctedSamples.length, originalBuffer.sampleRate);
        correctedBuffer.getChannelData(0).set(correctedSamples);

        const elapsed = ((performance.now() - processingStart) / 1000).toFixed(1);
        processingTime.hidden = false;
        processingTime.textContent = 'Processed in ' + elapsed + 's';
        setStatus('Done', 'done');
        downloadPanel.hidden = false;
        renderWaveforms();
    } catch (err) {
        overlayText.textContent = 'Error: ' + err.message;
        setStatus('Error', '');
        console.error(err);
        setTimeout(() => { overlay.hidden = true; }, 2000);
    } finally {
        overlay.hidden = true;
        processBtn.disabled = false;
    }
}

function playBuffer(buffer) {
    stopPlayback();
    if (!buffer || !audioContext) return;

    const ctx_ = getAudioContext();
    source = ctx_.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx_.destination);
    source.start(0);
    isPlaying = true;
    playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28"><rect x="5" y="5" width="5" height="14" fill="currentColor"/><rect x="14" y="5" width="5" height="14" fill="currentColor"/></svg>';

    const startTime = ctx_.currentTime;
    const duration = buffer.duration;

    function updatePlayback() {
        if (!isPlaying) return;
        const elapsed = ctx_.currentTime - startTime;
        const pct = Math.min(100, (elapsed / duration) * 100);
        progressFill.style.width = pct + '%';
        currentTimeEl.textContent = formatTime(Math.min(elapsed, duration));

        if (elapsed >= duration) {
            stopPlayback();
            return;
        }
        animFrame = requestAnimationFrame(updatePlayback);
    }
    animFrame = requestAnimationFrame(updatePlayback);

    source.onended = () => {
        stopPlayback();
    };
}

function stopPlayback() {
    if (source) {
        try { source.stop(); } catch (e) {}
        source = null;
    }
    if (animFrame) {
        cancelAnimationFrame(animFrame);
        animFrame = null;
    }
    isPlaying = false;
    playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28"><polygon points="6,3 20,12 6,21" fill="currentColor"/></svg>';
    progressFill.style.width = '0%';
    currentTimeEl.textContent = '0:00';
}

playBtn.addEventListener('click', () => {
    if (isPlaying) {
        stopPlayback();
    } else {
        const buffer = correctedBuffer || originalBuffer;
        if (buffer) {
            playBuffer(buffer);
            stopBtn.disabled = false;
        }
    }
});

stopBtn.addEventListener('click', () => {
    stopPlayback();
    stopBtn.disabled = true;
    if (correctedBuffer || originalBuffer) {
        playBtn.disabled = false;
    }
});

progressBar.addEventListener('click', (e) => {
    if (!isPlaying || !source || !audioContext) return;
    const rect = progressBar.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const buffer = correctedBuffer || originalBuffer;
    if (!buffer) return;

    stopPlayback();
    const ctx_ = getAudioContext();
    source = ctx_.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx_.destination);
    source.start(0, pct * buffer.duration);
    isPlaying = true;
    playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28"><rect x="5" y="5" width="5" height="14" fill="currentColor"/><rect x="14" y="5" width="5" height="14" fill="currentColor"/></svg>';
    stopBtn.disabled = false;

    const startTime = ctx_.currentTime - pct * buffer.duration;

    function updateSeek() {
        if (!isPlaying) return;
        const elapsed = ctx_.currentTime - startTime;
        const p = Math.min(100, (elapsed / buffer.duration) * 100);
        progressFill.style.width = p + '%';
        currentTimeEl.textContent = formatTime(Math.min(elapsed, buffer.duration));

        if (elapsed >= buffer.duration) {
            stopPlayback();
            return;
        }
        animFrame = requestAnimationFrame(updateSeek);
    }
    animFrame = requestAnimationFrame(updateSeek);

    source.onended = () => stopPlayback();
});

function downloadWAV(buffer, filename) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const length = buffer.length;
    const bitsPerSample = 16;
    const data = new DataView(new ArrayBuffer(44 + length * numChannels * 2));

    function writeString(offset, str) {
        for (let i = 0; i < str.length; i++) data.setUint8(offset + i, str.charCodeAt(i));
    }

    writeString(0, 'RIFF');
    data.setUint32(4, 36 + length * numChannels * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    data.setUint32(16, 16, true);
    data.setUint16(20, 1, true);
    data.setUint16(22, numChannels, true);
    data.setUint32(24, sampleRate, true);
    data.setUint32(28, sampleRate * numChannels * 2, true);
    data.setUint16(32, numChannels * 2, true);
    data.setUint16(34, bitsPerSample, true);
    writeString(36, 'data');
    data.setUint32(40, length * numChannels * 2, true);

    const channelData = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
        const s = Math.max(-1, Math.min(1, channelData[i]));
        data.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    const blob = new Blob([data], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

downloadBtn.addEventListener('click', () => {
    if (correctedBuffer) downloadWAV(correctedBuffer, 'autotuned.wav');
});

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.code) {
        case 'Space':
            e.preventDefault();
            playBtn.click();
            break;
        case 'KeyR':
            e.preventDefault();
            recordBtn.click();
            break;
        case 'Escape':
            overlay.hidden = true;
            break;
    }
});

window.addEventListener('resize', () => {
    if (originalBuffer) renderWaveforms();
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden && isPlaying) {
        stopPlayback();
    }
});

init();
