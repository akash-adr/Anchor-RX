import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Camera, CameraOff } from 'lucide-react';

type CameraStatus =
  | { state: 'idle' }
  | { state: 'starting' }
  | { state: 'scanning' }
  | { state: 'decoded'; at: number }
  | { state: 'error'; title: string; detail: string };

const DECODE_INTERVAL_MS = 180;
const MAX_DECODE_WIDTH = 720; // downscale large camera frames before decoding

function describeCameraError(err: unknown): { title: string; detail: string } {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { title: 'Camera permission denied', detail: 'Allow camera access for this site, or paste the payload manually.' };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { title: 'No camera found', detail: 'This device has no usable camera. Paste the payload manually.' };
    case 'NotReadableError':
    case 'AbortError':
      return { title: 'Camera is busy', detail: 'Another app may be using the camera. Close it and try again, or paste manually.' };
    default:
      return { title: 'Camera could not start', detail: err instanceof Error ? err.message : 'Unknown camera error.' };
  }
}

/**
 * Camera QR input. On the first successful decode it stops the camera and hands the RAW decoded text to
 * onDecode — the exact same submission path as manual paste. It never interprets the payload itself.
 */
export default function CameraScanner({ disabled, onDecode }: { disabled: boolean; onDecode: (raw: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;
  const [status, setStatus] = useState<CameraStatus>({ state: 'idle' });

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => stop, [stop]); // release the camera when leaving the screen

  const decodeFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;
    const scale = Math.min(1, MAX_DECODE_WIDTH / video.videoWidth);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    const canvas = (canvasRef.current ??= document.createElement('canvas'));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(video, 0, 0, width, height);
    const code = jsQR(context.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: 'dontInvert' });
    if (code && code.data) {
      stop();
      setStatus({ state: 'decoded', at: Date.now() });
      onDecodeRef.current(code.data);
    }
  }, [stop]);

  const start = useCallback(async () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setStatus({
        state: 'error',
        title: 'Camera needs a secure page',
        detail: 'Browsers only allow the camera on https:// or localhost. Open the portal via localhost, or paste the payload manually.',
      });
      return;
    }
    stop();
    setStatus({ state: 'starting' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stop();
        return;
      }
      video.srcObject = stream;
      await video.play();
      setStatus({ state: 'scanning' });
      timerRef.current = window.setInterval(decodeFrame, DECODE_INTERVAL_MS);
    } catch (err) {
      stop();
      setStatus({ state: 'error', ...describeCameraError(err) });
    }
  }, [decodeFrame, stop]);

  const live = status.state === 'starting' || status.state === 'scanning';

  return (
    <section aria-labelledby="camera-title" className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <Camera aria-hidden className="h-5 w-5 text-teal-700" />
        <h2 id="camera-title" className="font-semibold">
          Scan with camera
        </h2>
      </div>
      <p className="mt-1 text-sm text-slate-600">Hold the prescription QR code steady inside the frame.</p>

      <div className="relative mt-4 aspect-[4/3] w-full overflow-hidden rounded-xl bg-slate-900">
        <video ref={videoRef} muted playsInline aria-label="Camera preview" data-testid="camera-preview" className={`h-full w-full object-cover ${live ? '' : 'invisible'}`} />
        {live && <div aria-hidden className="pointer-events-none absolute inset-[18%] rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(15,23,42,0.35)]" />}
        {!live && (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-slate-300">
            {status.state === 'error' ? <CameraOff aria-hidden className="h-8 w-8" /> : <Camera aria-hidden className="h-8 w-8" />}
            <p className="mt-2 text-sm">{status.state === 'decoded' ? 'QR captured — camera stopped.' : 'Camera is off'}</p>
          </div>
        )}
        {status.state === 'starting' && (
          <p className="absolute inset-x-0 bottom-3 text-center text-sm text-white">Starting camera…</p>
        )}
        {status.state === 'scanning' && (
          <p className="absolute inset-x-0 bottom-3 text-center text-sm text-white" data-testid="camera-scanning">
            Looking for a QR code…
          </p>
        )}
      </div>

      {status.state === 'error' && (
        <div role="alert" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="camera-error">
          <p className="font-semibold">{status.title}</p>
          <p>{status.detail}</p>
        </div>
      )}

      <div className="mt-4 flex gap-3">
        {live ? (
          <button type="button" onClick={() => { stop(); setStatus({ state: 'idle' }); }} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100">
            Stop camera
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            disabled={disabled}
            className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Camera aria-hidden className="h-4 w-4" />
            {status.state === 'decoded' ? 'Scan again with camera' : status.state === 'error' ? 'Try camera again' : 'Start camera'}
          </button>
        )}
      </div>
    </section>
  );
}
