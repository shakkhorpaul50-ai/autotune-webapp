let audioContext = null;
let originalBuffer = null;
let correctedBuffer = null;
let source = null;
let isPlaying = false;
let recording = false;
let mediaRecorder = null;
let recordedChunks = [];
let animFrame = null;

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
const statusBadge = $('statusBadge');
const downloadPanel = $('downloadPanel');
const downloadBtn = $('downloadBtn');
const processingTime = $('processingTime');

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
    const w = parseInt(waveform.style.width);
    const step = Math.max(1, Math.floor(data.length / w));
    const mid = offsetY + height / 2;
    const ampScale = height * 0.9;

    ctx.globalAlpha = alpha || 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    for (let x = 0; x < w; x++) {
        const idx = Math.floor(x * step);
        const s = data[idx] || 0;
        if (x === 0) ctx.moveTo(x, mid - s * ampScale / 2);
        else ctx.lineTo(x, mid - s * ampScale / 2);
    }
    ctx.stroke();

    ctx.beginPath();
    for (let x = 0; x < w; x++) {
        const idx = Math.floor(x * step);
        const s = data[idx] || 0;
        if (x === 0) ctx.moveTo(x, mid + s * ampScale / 2);
        else ctx.lineTo(x, mid + s * ampScale / 2);
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
    fileInfo.textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
    setStatus('Loaded', 'ready');

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = await getAudioContext().decodeAudioData(e.target.result);
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
    if (e.dataTransfer.files.length > 0) loadFile(e.dataTransfer.files[0]);
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
            loadFile(new File([blob], 'recording.webm', { type: 'audio/webm' }));
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

// ─── Pure JS Autotune Engine ────────────────────────────────────────────────

function hannWindow(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    }
    return w;
}

function detectPitch(frame, sr) {
    const n = frame.length;
    if (n < 4) return 0;

    const mean = frame.reduce((a, b) => a + b, 0) / n;
    const centered = new Float64Array(n);
    for (let i = 0; i < n; i++) centered[i] = frame[i] - mean;

    const corr = new Float64Array(n);
    for (let lag = 0; lag < n; lag++) {
        let sum = 0;
        for (let i = 0; i < n - lag; i++) {
            sum += centered[i] * centered[i + lag];
        }
        corr[lag] = sum;
    }

    const minFreq = 50;
    const maxFreq = 2000;
    const minLag = Math.max(1, Math.floor(sr / maxFreq));
    const maxLag = Math.min(Math.floor(sr / minFreq), n - 1);

    if (minLag >= maxLag) return 0;

    let peakIdx = minLag;
    let peakVal = corr[minLag];
    for (let i = minLag + 1; i <= maxLag; i++) {
        if (corr[i] > peakVal) {
            peakVal = corr[i];
            peakIdx = i;
        }
    }

    const confidence = peakVal / (corr[0] + 1e-10);
    if (confidence < 0.2 || peakIdx === 0) return 0;

    const pitch = sr / peakIdx;
    if (pitch < minFreq || pitch > maxFreq) return 0;

    return pitch;
}

function snapToChromatic(freq) {
    if (freq <= 0) return 0;
    let midi = 12 * Math.log2(freq / 440) + 69;
    midi = Math.round(Math.max(0, Math.min(127, midi)));
    return 440 * Math.pow(2, (midi - 69) / 12);
}

function resampleFrame(frame, ratio) {
    const n = frame.length;
    const newN = Math.max(2, Math.round(n / ratio));
    const result = new Float64Array(n);

    for (let i = 0; i < newN && i < n; i++) {
        const srcPos = (i / newN) * n;
        const idx = Math.floor(srcPos);
        const frac = srcPos - idx;
        const next = Math.min(idx + 1, n - 1);
        result[i] = frame[idx] + frac * (frame[next] - frame[idx]);
    }

    return result;
}

function overlapAdd(frames, window, hopSize, outLen) {
    const frameSize = window.length;
    const output = new Float64Array(outLen);

    for (let i = 0; i < frames.length; i++) {
        const start = i * hopSize;
        for (let j = 0; j < frameSize; j++) {
            if (start + j < outLen) {
                output[start + j] += frames[i][j] * window[j];
            }
        }
    }

    return output;
}

function pitchCorrect(audio, sr, strength) {
    const frameMs = 30;
    const hopMs = 10;
    const frameSize = Math.round(frameMs * sr / 1000);
    const hopSize = Math.round(hopMs * sr / 1000);

    const n = audio.length;
    if (n < frameSize) return audio;

    const nFrames = Math.max(1, Math.floor((n - frameSize) / hopSize) + 1);
    const needed = (nFrames - 1) * hopSize + frameSize;

    const window = hannWindow(frameSize);
    const pitches = new Float64Array(nFrames);

    for (let i = 0; i < nFrames; i++) {
        const start = i * hopSize;
        const frame = new Float64Array(frameSize);
        for (let j = 0; j < frameSize; j++) {
            frame[j] = audio[Math.min(start + j, n - 1)];
        }
        pitches[i] = detectPitch(frame, sr);
    }

    const targets = new Float64Array(nFrames);
    for (let i = 0; i < nFrames; i++) {
        if (pitches[i] > 0) {
            const snapped = snapToChromatic(pitches[i]);
            targets[i] = pitches[i] + strength * (snapped - pitches[i]);
        }
    }

    const outLen = Math.max(n, needed);
    const outputFrames = [];

    for (let i = 0; i < nFrames; i++) {
        const start = i * hopSize;
        const frame = new Float64Array(frameSize);
        for (let j = 0; j < frameSize; j++) {
            frame[j] = audio[Math.min(start + j, n - 1)];
        }

        if (pitches[i] > 0 && targets[i] > 0) {
            let ratio = pitches[i] / targets[i];
            ratio = Math.max(0.5, Math.min(2.0, ratio));
            const shifted = resampleFrame(frame, ratio);
            for (let j = 0; j < frameSize; j++) {
                frame[j] = shifted[j] * window[j];
            }
        } else {
            for (let j = 0; j < frameSize; j++) {
                frame[j] = frame[j] * window[j];
            }
        }

        outputFrames.push(frame);
    }

    const result = overlapAdd(outputFrames, window, hopSize, outLen + frameSize);

    if (result.length > n) {
        return result.slice(0, n);
    }
    return result;
}

function timeStretch(audio, stretch) {
    if (stretch === 1.0) return audio.slice();

    const n = audio.length;
    const frameSize = 2048;
    const analysisHop = Math.floor(frameSize / 4);

    if (n < frameSize) return audio.slice();

    const synthesisHop = Math.max(1, Math.round(analysisHop * stretch));
    const nFrames = Math.max(1, Math.floor((n - frameSize) / analysisHop) + 1);
    const window = hannWindow(frameSize);

    const outLen = Math.round((nFrames - 1) * synthesisHop + frameSize);
    const output = new Float64Array(outLen + frameSize);
    const norm = new Float64Array(outLen + frameSize);

    for (let i = 0; i < nFrames; i++) {
        const anaPos = i * analysisHop;
        const synPos = Math.round(i * synthesisHop);

        for (let j = 0; j < frameSize; j++) {
            const val = audio[Math.min(anaPos + j, n - 1)] * window[j];
            output[synPos + j] += val;
            norm[synPos + j] += window[j];
        }
    }

    for (let i = 0; i < outLen; i++) {
        output[i] = output[i] / Math.max(0.001, norm[i]);
    }

    const targetLen = Math.min(Math.round(n / stretch), outLen);
    return output.slice(0, targetLen);
}

function autotune(audio, sr, strength, stretch) {
    if (audio.length < sr * 0.01) return audio.slice();
    let result = pitchCorrect(audio, sr, strength);
    if (Math.abs(stretch - 1.0) > 0.001) {
        result = timeStretch(result, stretch);
    }
    return result;
}

// ─── Processing ─────────────────────────────────────────────────────────────

async function processAudio() {
    if (!originalBuffer) return;

    stopPlayback();
    overlay.hidden = false;
    overlayText.textContent = 'Processing...';
    setStatus('Processing', 'busy');
    processBtn.disabled = true;
    const processingStart = performance.now();

    try {
        await new Promise(resolve => setTimeout(resolve, 50));

        const src = originalBuffer.getChannelData(0);
        const sr = originalBuffer.sampleRate;
        const strength = strengthSlider.value / 100;
        const stretch = stretchSlider.value / 100;

        const audio = new Float64Array(src.length);
        for (let i = 0; i < src.length; i++) audio[i] = src[i];

        const result = autotune(audio, sr, strength, stretch);

        const ctx_ = getAudioContext();
        correctedBuffer = ctx_.createBuffer(1, result.length, sr);
        const channel = correctedBuffer.getChannelData(0);
        for (let i = 0; i < result.length; i++) {
            channel[i] = Math.max(-1, Math.min(1, result[i]));
        }

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

// ─── Playback ───────────────────────────────────────────────────────────────

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

// ─── Download ───────────────────────────────────────────────────────────────

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

// ─── Keyboard ───────────────────────────────────────────────────────────────

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
    if (document.hidden && isPlaying) stopPlayback();
});
