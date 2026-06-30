import numpy as np

def autotune(audio, sample_rate, strength=1.0, stretch=1.0):
    if len(audio) < sample_rate * 0.01:
        return audio.copy()

    corrected = _pitch_correct(audio, sample_rate, strength)
    if abs(stretch - 1.0) > 0.001:
        corrected = _time_stretch(corrected, stretch)
    return corrected


def _pitch_correct(audio, sr, strength):
    frame_ms = 30
    hop_ms = 10
    frame_size = int(frame_ms * sr / 1000)
    hop_size = int(hop_ms * sr / 1000)

    n = len(audio)
    if n < frame_size:
        return audio.copy()

    n_frames = max(1, (n - frame_size) // hop_size + 1)
    needed = (n_frames - 1) * hop_size + frame_size
    if needed > n:
        audio = np.pad(audio, (0, needed - n))

    window = np.hanning(frame_size)

    pitches = np.zeros(n_frames)
    for i in range(n_frames):
        start = i * hop_size
        frame = audio[start:start + frame_size] - np.mean(audio[start:start + frame_size])
        frame = frame * window
        pitches[i] = _detect_pitch(frame, sr)

    targets = np.zeros(n_frames)
    for i in range(n_frames):
        if pitches[i] > 0:
            midi = 12 * np.log2(pitches[i] / 440.0) + 69
            midi = np.clip(np.round(midi), 0, 127)
            snapped = 440.0 * (2 ** ((midi - 69) / 12))
            targets[i] = pitches[i] + strength * (snapped - pitches[i])

    output = np.zeros(needed + frame_size)
    for i in range(n_frames):
        start = i * hop_size
        frame = audio[start:start + frame_size] * window

        if pitches[i] > 0 and targets[i] > 0:
            ratio = pitches[i] / targets[i]
            ratio = np.clip(ratio, 0.5, 2.0)
            frame = _resample(frame, ratio) * window

        output[start:start + frame_size] += frame

    return output[:n]


def _detect_pitch(frame, sr):
    n = len(frame)
    if n < 2:
        return 0.0

    corr = np.correlate(frame, frame, mode='full')
    corr = corr[n - 1:]

    min_freq = 50.0
    max_freq = 2000.0
    min_lag = max(1, int(sr / max_freq))
    max_lag = min(int(sr / min_freq), n - 1)

    if min_lag >= max_lag:
        return 0.0

    segment = corr[min_lag:max_lag + 1]
    if len(segment) < 2:
        return 0.0

    peak_idx = np.argmax(segment) + min_lag
    confidence = corr[peak_idx] / (corr[0] + 1e-10)

    if confidence < 0.2:
        return 0.0

    pitch = sr / peak_idx
    if pitch < min_freq or pitch > max_freq:
        return 0.0

    return pitch


def _resample(frame, ratio):
    n = len(frame)
    new_n = max(2, int(round(n / ratio)))

    x_old = np.linspace(0, 1, n)
    x_new = np.linspace(0, 1, new_n)
    resampled = np.interp(x_new, x_old, frame)

    if new_n < n:
        result = np.pad(resampled, (0, n - new_n), mode='reflect')
    else:
        result = resampled[:n]

    return result


def _time_stretch(audio, stretch):
    if stretch == 1.0:
        return audio.copy()

    n = len(audio)
    frame_size = 2048
    analysis_hop = frame_size // 4

    if n < frame_size:
        return audio.copy()

    synthesis_hop = max(1, int(round(analysis_hop * stretch)))
    n_frames = max(1, (n - frame_size) // analysis_hop + 1)

    window = np.hanning(frame_size)

    out_len = int((n_frames - 1) * synthesis_hop + frame_size)
    output = np.zeros(out_len + frame_size, dtype=np.float64)
    norm = np.zeros(out_len + frame_size, dtype=np.float64)

    for i in range(n_frames):
        ana_pos = i * analysis_hop
        syn_pos = i * synthesis_hop

        frame = audio[ana_pos:ana_pos + frame_size].copy()
        frame = frame * window

        end = syn_pos + frame_size
        output[syn_pos:end] += frame
        norm[syn_pos:end] += window

    norm = np.where(norm > 0.001, norm, 1.0)
    output = output / norm

    target_len = min(int(round(n / stretch)), len(output))
    return output[:target_len]
