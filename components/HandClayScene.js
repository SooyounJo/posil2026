import { useEffect, useRef } from 'react';
import * as THREE from 'three';

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function computeClayProfile(metrics, timeSec) {
  // metrics는 0~1 범위의 정규화된 값들이 들어옵니다.
  const pinch = metrics?.pinch ?? 0.25;
  const spreadX = metrics?.spreadX ?? 0.25;
  const palmX = (metrics?.palmX ?? 0.5) - 0.5; // -0.5 ~ 0.5
  const vertical = metrics?.vertical ?? 0.25;

  const baseRadius = lerp(0.16, 0.56, pinch);
  const bellyAmp = lerp(0.65, 1.85, spreadX);
  const heightScale = lerp(0.85, 1.35, vertical);
  const wobble = 0.02 + 0.08 * pinch;

  const n = 20;
  const profile = [];

  for (let i = 0; i < n; i++) {
    const u = i / (n - 1); // 0..1
    const y = lerp(-0.95, 0.95, u) * heightScale;

    // 바닥/목/배 부분을 비슷하게 잡아 “도자기” 느낌을 만듭니다.
    const footTaper = lerp(0.55, 1.0, smoothstep(0.0, 0.2, u));
    const neckTaper = lerp(1.0, 0.55, smoothstep(0.65, 1.0, u));

    const bellyShape = 0.35 + 0.65 * Math.sin(Math.PI * u); // 아래/위는 작고 중간이 큼
    const bellyBoost = 1.0 + (bellyAmp - 1.0) * 0.55 * Math.sin(Math.PI * u);

    const twistWobble = wobble * Math.sin(u * Math.PI * 2 + timeSec * 1.25 + palmX * 3.0);
    const r = baseRadius * bellyShape * bellyBoost * footTaper * neckTaper + twistWobble;

    profile.push(new THREE.Vector2(Math.max(0.02, r), y));
  }

  return profile;
}

function profileDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i].x - b[i].x) + Math.abs(a[i].y - b[i].y);
  return sum / a.length;
}

export default function HandClayScene({ handDataRef }) {
  const mountRef = useRef(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    camera.position.set(0, 0.25, 2.35);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    mount.appendChild(renderer.domElement);

    const ambient = new THREE.HemisphereLight(0xfff3d6, 0x203040, 1.2);
    scene.add(ambient);

    const dir = new THREE.DirectionalLight(0xffffff, 1.05);
    dir.position.set(1.2, 2.0, 1.0);
    scene.add(dir);

    const material = new THREE.MeshStandardMaterial({
      color: 0xd7b38c,
      roughness: 0.92,
      metalness: 0.05
    });

    let geometry = new THREE.LatheGeometry(computeClayProfile(null, 0), 96);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = -0.05;
    scene.add(mesh);

    const clock = new THREE.Clock();
    const lastProfileRef = { current: null };
    const lastRebuildAtRef = { current: 0 };
    const spinRef = { current: 0 };
    const baseRotRef = { current: 0 };
    const prevIndexTipRef = { current: null };

    function resize() {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    }
    resize();

    const onResize = () => resize();
    window.addEventListener('resize', onResize);

    let raf = 0;
    function animate() {
      raf = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();

      const now = Date.now();
      const hand = handDataRef.current;
      const metrics = hand?.metrics || null;
      const fresh = hand?.updatedAt && now - hand.updatedAt < 900;

      // 손이 사라지면 천천히 원래 모양으로 복귀합니다.
      const effectiveMetrics = fresh ? metrics : null;

      // 회전(“물레” 느낌): 좌우 이동 델타로 스핀 속도를 만듭니다.
      if (fresh && metrics?.indexTip) {
        const prev = prevIndexTipRef.current;
        const cur = metrics.indexTip;
        if (prev) {
          const deltaX = cur.x - prev.x; // -..1
          spinRef.current = spinRef.current * 0.92 + deltaX * 3.5;
        }
        prevIndexTipRef.current = cur;
      } else {
        prevIndexTipRef.current = null;
        spinRef.current *= 0.92;
      }

      // 베이스 회전: 손 위치(palmX)에 따라 우측 회전감 부여
      const palmCentered = ((effectiveMetrics?.palmX ?? 0.5) - 0.5) * 2; // -1..1
      baseRotRef.current = lerp(baseRotRef.current, palmCentered * 0.85, 0.08);

      const targetRotY = baseRotRef.current + spinRef.current * 0.9;
      mesh.rotation.y = lerp(mesh.rotation.y, targetRotY, 0.18);
      mesh.rotation.x = lerp(mesh.rotation.x, (effectiveMetrics ? (effectiveMetrics.vertical - 0.5) * 0.16 : 0), 0.12);

      // 도자기 shape: 프로파일을 생성하고, 너무 자주 rebuild하지 않도록 제한합니다.
      const targetProfile = computeClayProfile(effectiveMetrics, t);
      const diff = profileDiff(lastProfileRef.current, targetProfile);
      const canRebuild = t - lastRebuildAtRef.current > 0.12 && diff > 0.0015;

      if (!lastProfileRef.current) {
        // 초기 1회는 바로 생성
        lastProfileRef.current = targetProfile;
        lastRebuildAtRef.current = t;
      }

      if (canRebuild) {
        // rebuild: geometry 교체 전에 dispose하여 메모리 누수를 줄입니다.
        lastProfileRef.current = targetProfile;
        lastRebuildAtRef.current = t;

        const nextGeo = new THREE.LatheGeometry(targetProfile, 96);
        nextGeo.computeVertexNormals();
        geometry.dispose();
        geometry = nextGeo;
        mesh.geometry = geometry;
      }

      // 부드러운 스케일 변화(손 크기/높이 느낌)
      const scaleTarget = effectiveMetrics ? lerp(0.92, 1.1, effectiveMetrics.vertical) : 0.98;
      mesh.scale.setScalar(lerp(mesh.scale.x, scaleTarget, 0.08));

      // 느린 흔들림(점토 느낌)
      mesh.rotation.z = Math.sin(t * 0.55) * 0.02 * (effectiveMetrics ? 1 : 0.35);

      renderer.render(scene, camera);
    }

    animate();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      try {
        geometry.dispose();
        material.dispose();
      } catch (_) {}
      try {
        renderer.dispose();
      } catch (_) {}
      try {
        if (renderer.domElement && renderer.domElement.parentNode) {
          renderer.domElement.parentNode.removeChild(renderer.domElement);
        }
      } catch (_) {}
    };
  }, [handDataRef]);

  return (
    <div
      ref={mountRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative'
      }}
    />
  );
}

