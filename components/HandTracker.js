import { useEffect, useRef, useState } from 'react';

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function touchFromPinchDistance(pinchDistance) {
  // 엄지-검지 거리가 가까울수록(손가락이 닿을수록) 값을 1에 가깝게 만듭니다.
  // pinchDistance는 mediapipe의 정규화 좌표(0~1) 기반이라 대략적인 스케일링이 필요합니다.
  return clamp01(1 - pinchDistance * 6.0);
}

export default function HandTracker({ handDataRef }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const overlayRef = useRef(null);
  const overlayRectRef = useRef(null);
  const layoutRef = useRef({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    mirrorX: false
  });
  const videoDimsRef = useRef({ w: 0, h: 0 });
  const dprRef = useRef(1);
  const [status, setStatus] = useState('카메라를 준비 중...');

  useEffect(() => {
    let cancelled = false;
    let stream = null;
    let camera = null;

    function updateOverlayRect() {
      try {
        const el = overlayRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        overlayRectRef.current = {
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height
        };
        recomputeLayout();
      } catch (_) {}
    }

    function recomputeLayout() {
      try {
        const overlayRect = overlayRectRef.current;
        const videoEl = videoRef.current;
        const canvasEl = canvasRef.current;
        const { w, h } = videoDimsRef.current;
        if (!overlayRect || !videoEl || !canvasEl || !w || !h) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        dprRef.current = dpr;

        // display 비율에 맞춰 “늘리지(contain)”로 맞춥니다.
        const scale = Math.min(overlayRect.width / w, overlayRect.height / h);
        const dispW = Math.max(1, Math.round(w * scale));
        const dispH = Math.max(1, Math.round(h * scale));

        const offsetX = Math.round((overlayRect.width - dispW) / 2);
        const offsetY = Math.round((overlayRect.height - dispH) / 2);

        layoutRef.current.left = overlayRect.left + offsetX;
        layoutRef.current.top = overlayRect.top + offsetY;
        layoutRef.current.width = dispW;
        layoutRef.current.height = dispH;

        // 2D 스켈레톤 캔버스는 화면에서 보이는 크기와 동일하게 맞춰야 늘어짐이 없습니다.
        videoEl.style.left = `${offsetX}px`;
        videoEl.style.top = `${offsetY}px`;
        videoEl.style.width = `${dispW}px`;
        videoEl.style.height = `${dispH}px`;

        canvasEl.style.left = `${offsetX}px`;
        canvasEl.style.top = `${offsetY}px`;
        canvasEl.style.width = `${dispW}px`;
        canvasEl.style.height = `${dispH}px`;

        // 내부 픽셀 해상도는 dpr로 올려 선/점이 더 선명해지도록 합니다.
        canvasEl.width = Math.round(dispW * dpr);
        canvasEl.height = Math.round(dispH * dpr);
      } catch (_) {}
    }

    async function start() {
      try {
        const videoEl = videoRef.current;
        const canvasEl = canvasRef.current;
        if (!videoEl || !canvasEl) return;

        // Mediapipe 패키지는 Next/Turbopack에서 정적 named import가 깨질 수 있어
        // 여기서 런타임 동적 로딩으로 해결합니다.
        const handsMod = await import('@mediapipe/hands');
        const cameraMod = await import('@mediapipe/camera_utils');
        const drawingMod = await import('@mediapipe/drawing_utils');

        const Hands = handsMod.Hands;
        const HAND_CONNECTIONS = handsMod.HAND_CONNECTIONS;
        const Camera = cameraMod.Camera;
        const drawConnectors = drawingMod.drawConnectors;
        const drawLandmarks = drawingMod.drawLandmarks;

        setStatus('카메라 권한을 요청 중...');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false
        });
        if (cancelled) return;

        videoEl.srcObject = stream;
        await videoEl.play();

        // 비디오 원본 크기 저장 후, 화면에 늘리지 않고 맞춥니다.
        const w = videoEl.videoWidth || 640;
        const h = videoEl.videoHeight || 480;
        videoDimsRef.current = { w, h };
        recomputeLayout();

        setStatus('손을 화면에 비춰주세요.');

        const hands = new Hands({
          locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
        });

        hands.setOptions({
          maxNumHands: 2,
          modelComplexity: 1,
          minDetectionConfidence: 0.6,
          minTrackingConfidence: 0.6,
          selfieMode: true
        });

        hands.onResults((results) => {
          const now = Date.now();

          const prevHitById = handDataRef.current?.hitById || {};

          const ctx = canvasEl.getContext('2d');
          ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

          const multiLandmarks = results.multiHandLandmarks || [];
          const multiHandedness = results.multiHandedness || [];

          if (multiLandmarks.length === 0) {
            handDataRef.current = { hands: [], updatedAt: now, hitById: prevHitById };
            return;
          }

          const rect = overlayRectRef.current;
          const layout = layoutRef.current;

          const handsOut = multiLandmarks.slice(0, 2).map((landmarks, idx) => {
            // 사용자가 말한 대로 좌/우 손 인식이 반대로 느껴질 수 있어, handedness를 스왑합니다.
            const rawHandedness = multiHandedness?.[idx]?.label || String(idx);
            const swapHands = true;
            const handedness = swapHands
              ? rawHandedness === 'Left'
                ? 'Right'
                : rawHandedness === 'Right'
                  ? 'Left'
                  : rawHandedness
              : rawHandedness;

            // landmarks는 normalized 좌표(0~1)입니다.
            // index(8), thumb(4), middle(12), wrist(0), pinky(20) 사용
            const wrist = landmarks[0];
            const thumbTip = landmarks[4];
            const indexTip = landmarks[8];
            const middleTip = landmarks[12];
            const pinkyTip = landmarks[20];

            const pinchDistance = dist(thumbTip, indexTip);
            const touch = touchFromPinchDistance(pinchDistance);
            const spreadX = Math.abs(indexTip.x - pinkyTip.x); // 손가락 벌어짐(대략)
            const vertical = Math.abs(wrist.y - middleTip.y); // 손 높이/펼침 정도

            // Raycast에 쓸 수 있도록, “패널 화면 좌표(px)”도 같이 저장합니다.
            // 캔버스를 화면 비율에 맞춰 맞춰두었기 때문에, 아래 mapping이 좌우 늘어짐 없이 안정적입니다.
            const mirrorX = layout.mirrorX;
            // canvas/video는 CSS로 이미 좌우 미러링되고 있으므로,
            // 3D 레이캐스트 매핑은 “보이는 방향”과 일치하도록 반대로 적용합니다.
            const x01 = mirrorX ? indexTip.x : 1 - indexTip.x;
            const palmX = (mirrorX ? wrist.x : 1 - wrist.x) - 0.5; // mirror 기준 좌우 위치( -0.5..0.5 )
            const y01 = indexTip.y;

            let indexScreen = null;
            let indexScreenNorm = null;
            if (layout.width > 10 && layout.height > 10) {
              indexScreen = {
                x: layout.left + x01 * layout.width,
                y: layout.top + y01 * layout.height
              };
              indexScreenNorm = { x: x01, y: y01 };
            }

            return {
              id: handedness,
              handedness,
              metrics: {
                pinch: touch,
                touch,
                spreadX: clamp01(spreadX * 1.6),
                palmX: clamp01((palmX + 0.5) / 1), // 0~1로 정규화
                vertical: clamp01(vertical * 1.6),
                wrist,
                indexTip,
                middleTip,
                thumbTip,
                pinkyTip
              },
              landmarks,
              indexScreen,
              indexScreenNorm
            };
          });

          handDataRef.current = { hands: handsOut, updatedAt: now, hitById: prevHitById };

          // 2D 손 구조도 렌더링(패널 내부)
          for (let i = 0; i < handsOut.length; i++) {
            const { landmarks, id, handedness } = handsOut[i];
            const handKey = handedness || id || String(i);
            const hit = prevHitById?.[handKey];
            const touch = hit?.active ? (hit.touch ?? 0) : 0;
            const yellowN = hit?.yellowN ?? 0.5;

            // 노랑/파랑은 “어느 영역에서 닿았는지”를 3D에서 받아 사용합니다.
            const isYellow = yellowN >= 0.5;
            const color = isYellow ? '#ffd24a' : '#3b82f6';

            const dpr = dprRef.current || 1;
            const baseLine = 0.95 * dpr;
            // 점(끝마디)은 작게 유지하고, 터치됐을 때만 tipScale로 커짐/작아짐이 반영되게 합니다.
            const baseRadius = 0.65 * dpr;
            const fingerTipIndices = new Set([4, 8, 12, 16, 20]);
            const tipScale = hit?.tipScale ?? 1;
            const lineFactor = hit?.lineFactor ?? 1;

            // 기본 골격(선/점)은 더 작게, 선명하게
            drawConnectors(ctx, landmarks, HAND_CONNECTIONS, { color, lineWidth: baseLine });
            drawLandmarks(ctx, landmarks, {
              color,
              lineWidth: 0.9 * dpr,
              radius: ({ index }) => {
                const isTip = fingerTipIndices.has(index);
                // 점은 손가락 끝(끝마디)만 보여주고, 나머지는 거의 0으로 숨깁니다.
                if (!isTip) return 0;
                // 터치됐던 상태(tipScale)는 release 후에도 유지됩니다.
                const r = baseRadius * tipScale;
                return Math.max(0.08 * dpr, r);
              }
            });

            // 손가락이 닿는 동안(또는 닿아서 deform 상태를 유지하는 동안) 해당 부위의 “선”이
            // 푹 들어가거나/살짝 펴지게 보이도록 오버레이합니다.
            const shouldDrawFingerDeform = Math.abs(lineFactor - 1) > 0.015;
            if (shouldDrawFingerDeform && landmarks?.[8]) {
              const cw = ctx.canvas.width;
              const ch = ctx.canvas.height;
              const tip = landmarks[8];
              const cx = tip.x * cw;
              const cy = tip.y * ch;

              const factor = lineFactor;
              const lineW = baseLine * (isYellow ? 0.86 : 1.05);
              ctx.save();
              ctx.strokeStyle = color;
              ctx.lineWidth = lineW;
              ctx.beginPath();

              for (const [a, b] of HAND_CONNECTIONS) {
                if (!fingerTipIndices.has(a) && !fingerTipIndices.has(b)) continue;
                const p0 = landmarks[a];
                const p1 = landmarks[b];
                if (!p0 || !p1) continue;
                const x0 = cx + (p0.x * cw - cx) * factor;
                const y0 = cy + (p0.y * ch - cy) * factor;
                const x1 = cx + (p1.x * cw - cx) * factor;
                const y1 = cy + (p1.y * ch - cy) * factor;
                ctx.moveTo(x0, y0);
                ctx.lineTo(x1, y1);
              }
              ctx.stroke();
              ctx.restore();
            }
          }
        });

        camera = new Camera(videoEl, {
          onFrame: async () => {
            await hands.send({ image: videoEl });
          },
          width: w,
          height: h
        });

        camera.start();
      } catch (e) {
        if (cancelled) return;
        setStatus(`카메라 초기화 실패: ${e?.message || String(e)}`);
      }
    }

    // 사용자 요청: 좌우 반전
    layoutRef.current.mirrorX = true;
    updateOverlayRect();
    window.addEventListener('resize', updateOverlayRect);
    start();

    return () => {
      cancelled = true;
      window.removeEventListener('resize', updateOverlayRect);
      try {
        if (camera && camera.stop) camera.stop();
      } catch (_) {}
      try {
        if (stream) stream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
    };
  }, [handDataRef]);

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        pointerEvents: 'none'
      }}
    >
      <video
        ref={videoRef}
        style={{
          position: 'absolute',
          objectFit: 'cover',
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          transform: 'scaleX(-1)', // 2D 스켈레톤과 같은 방향으로 맞추기
          opacity: 0.0
        }}
        playsInline
        muted
      />
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: '100%',
          height: '100%',
          transform: 'scaleX(-1)'
        }}
      />

      <div
        style={{
          position: 'absolute',
          left: 16,
          top: 16,
          right: 16,
          fontSize: 12,
          lineHeight: 1.35,
          color: 'rgba(255,255,255,0.85)',
          textShadow: '0 1px 0 rgba(0,0,0,0.4)'
        }}
      >
        {status}
      </div>
    </div>
  );
}

