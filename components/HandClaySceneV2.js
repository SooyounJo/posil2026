import { useEffect, useRef } from 'react';
import * as THREE from 'three';

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function clamp01(v) {
  return clamp(v, 0, 1);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function computeClayProfile(metrics, opts = {}) {
  const cylinder = opts?.cylinder ?? false;

  const pinch = metrics?.pinch ?? 0.25; // 손을 강하게 누르는 정도
  const spreadX = metrics?.spreadX ?? 0.5; // 양손 벌림(0..1)
  const palmX = (metrics?.palmX ?? 0.5) - 0.5; // -0.5 ~ 0.5

  const spreadT = smoothstep(0.06, 0.85, spreadX);

  // 양손 벌림에 따라 도자기 폭이 결정되고, pinch는 “배/질감” 쪽으로 반영
  const baseRadius = lerp(0.14, 0.58, spreadT);
  const bellyAmp = lerp(0.68, 1.95, pinch);
  const heightScale = lerp(0.96, 1.12, spreadT);
  const wobble = 0.008 + 0.035 * pinch;

  const n = 28;
  const profile = [];

  for (let i = 0; i < n; i++) {
    const u = i / (n - 1); // 0..1
    const y = lerp(-0.78, 0.78, u) * heightScale;

    if (cylinder) {
      // 완전한 원통: 높이 방향으로 반지름이 일정합니다.
      profile.push(new THREE.Vector2(Math.max(0.02, baseRadius), y));
      continue;
    }

    const footTaper = lerp(0.55, 1.0, smoothstep(0.0, 0.2, u));
    const neckTaper = lerp(1.0, 0.55, smoothstep(0.65, 1.0, u));

    const bellyShape = 0.35 + 0.65 * Math.sin(Math.PI * u);
    const bellyBoost = 1.0 + (bellyAmp - 1.0) * 0.55 * Math.sin(Math.PI * u);

    // 시간이 아닌 손 위치로만 약간 비틀림을 주어 “꿀렁거림”을 줄입니다.
    const twistWobble = wobble * Math.sin(u * Math.PI * 2 + palmX * 3.0);
    const r = baseRadius * bellyShape * bellyBoost * footTaper * neckTaper + twistWobble;

    profile.push(new THREE.Vector2(Math.max(0.02, r), y));
  }

  return profile;
}

function sampleRadiusFromProfile(profile, u) {
  if (!profile || profile.length < 2) return 0.2;
  const uu = clamp01(u);
  const x = uu * (profile.length - 1);
  const i0 = Math.floor(x);
  const i1 = Math.min(profile.length - 1, i0 + 1);
  const t = x - i0;
  return lerp(profile[i0].x, profile[i1].x, t);
}

export default function HandClaySceneV2({ handDataRef, ceramicColor }) {
  const mountRef = useRef(null);

  const ceramicMaterialRef = useRef(null);
  const ceramicColorRef = useRef(ceramicColor);

  // 컬러만 바뀌었을 때 재질만 업데이트합니다.
  useEffect(() => {
    ceramicColorRef.current = ceramicColor;
    if (ceramicMaterialRef.current && ceramicColor) {
      ceramicMaterialRef.current.color = new THREE.Color(ceramicColor);
    }
  }, [ceramicColor]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    camera.position.set(0, 0.25, 2.35);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setClearColor(0x000000, 1);
    mount.appendChild(renderer.domElement);

    // 좌측 위에서 강하게: 도자기 재질감을 위해 ambient은 낮게, key light는 강하게
    const ambient = new THREE.AmbientLight(0xffffff, 0.12);
    scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(-2.2, 2.8, 1.6);
    scene.add(key);

    const fill = new THREE.DirectionalLight(0x9fd6ff, 0.55);
    fill.position.set(-1.0, 0.4, -2.2);
    scene.add(fill);

    const material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(ceramicColorRef.current ?? '#f6f7f8'),
      roughness: 0.28,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      sheen: 0.35,
      sheenRoughness: 0.25
    });
    ceramicMaterialRef.current = material;

    const initialMetrics = { pinch: 0.04, spreadX: 0.18, palmX: 0.5 };
    // 시작할 때는 손이 없어도 “완전 원통”으로 유지합니다.
    const cylinderProfile = computeClayProfile(initialMetrics, { cylinder: true });
    let currentProfile = cylinderProfile.map((v) => v.clone());
    let lastTargetProfile = cylinderProfile.map((v) => v.clone());
    let lastHandsSeenAt = Date.now();
    let geometry = new THREE.LatheGeometry(currentProfile, 96);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, material);

    // 손이 “정확히 닿지 않아도” 영역 안으로 들어오면 홈이 생기도록,
    // 실제 메쉬보다 조금 크게 만든 소프트 콜라이더를 사용합니다.
    // (y축 높이는 유지하고 xz 반경만 확장해서 목~아래 구간 매핑이 흔들리지 않게 함)
    const colliderScaleXZ = 1.35;
    const colliderMesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.0 })
    );
    colliderMesh.scale.set(colliderScaleXZ, 1.0, colliderScaleXZ);
    colliderMesh.visible = false;
    scene.add(colliderMesh);

    const clayGroup = new THREE.Group();
    clayGroup.position.y = -0.05;
    clayGroup.add(mesh);
    // 도자기가 화면에서 더 잘 보이도록 살짝 확대합니다.
    clayGroup.scale.setScalar(1.08);
    scene.add(clayGroup);

    // 물레(바닥) - 도자기가 처음부터 “물레 위 타원”처럼 보이게 합니다.
    const wheelMat = new THREE.MeshStandardMaterial({
      color: 0x0b0b0b,
      roughness: 0.65,
      metalness: 0.25
    });
    const wheelGeo = new THREE.CylinderGeometry(0.45, 0.62, 0.08, 64);
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    // 클레이가 위에 있고 물레가 완전히 아래로 들어가 보이도록 내립니다.
    wheel.position.y = -0.38;
    scene.add(wheel);

    // 물레가 “도는 것”이 눈에 보이도록, 회전하는 스포크를 추가합니다.
    const spokesGroup = new THREE.Group();
    scene.add(spokesGroup);
    // wheelHeight/TopY는 아래에서 wheel이 재배치될 수 있어서, 스포크의 y는 animate()에서 맞추지 않고도
    // “틀어짐” 없이 따라가도록 clayBottom 기준으로 재배치합니다(아래 yMin 계산 뒤).
    const wheelHeight = 0.08;
    const spokeGeo = new THREE.BoxGeometry(0.012, 0.008, 0.13);
    const spokeMat = new THREE.MeshStandardMaterial({
      color: 0x8e99a8,
      roughness: 0.6,
      metalness: 0.35
    });
    const spokeCount = 8;
    const spokeRadius = 0.36;
    for (let i = 0; i < spokeCount; i++) {
      const angle = (i / spokeCount) * Math.PI * 2;
      const spoke = new THREE.Mesh(spokeGeo, spokeMat);
      spoke.position.set(Math.cos(angle) * spokeRadius, 0, Math.sin(angle) * spokeRadius);
      spoke.rotation.y = angle;
      spokesGroup.add(spoke);
    }

    // “돌고 있음”을 보여주기 위한 상단 회전 라인(얇은 세그먼트)
    const wheelTopY = wheel.position.y + 0.04;
    const indicatorRadius = 0.56;
    const indicatorHeight = 0.0025;
    const indicatorGeo = new THREE.BufferGeometry();
    const indicatorVerts = new Float32Array([
      indicatorRadius * 0.15, wheelTopY, 0,
      indicatorRadius, wheelTopY, 0
    ]);
    indicatorGeo.setAttribute('position', new THREE.BufferAttribute(indicatorVerts, 3));
    const indicatorPosAttr = indicatorGeo.getAttribute('position');
    const indicatorMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    const indicatorLine = new THREE.Line(indicatorGeo, indicatorMat);
    // 기본은 x축 방향 세그먼트. 실제 회전은 Y축(물레 축)으로 같이 돌립니다.
    indicatorLine.rotation.x = 0;
    indicatorLine.rotation.y = 0;
    indicatorLine.renderOrder = 10;
    scene.add(indicatorLine);

    // 노란/파란 “조각 영역” 마커
    const ringGeo = new THREE.RingGeometry(0.03, 1.0, 96);
    const yellowMat = new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.35 });
    const blueMat = new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.28 });

    const yellowMarker = new THREE.Mesh(ringGeo, yellowMat);
    yellowMarker.rotation.x = Math.PI / 2;
    clayGroup.add(yellowMarker);

    const blueMarker = new THREE.Mesh(ringGeo, blueMat);
    blueMarker.rotation.x = Math.PI / 2;
    clayGroup.add(blueMarker);

    // 손이 도자기 표면에 “닿는 지점”을 보여주는 마커(두 손)
    const markerGeo = new THREE.SphereGeometry(0.055, 22, 16);
    const handHitMarkers = [
      new THREE.Mesh(
        markerGeo,
        new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.95 })
      ),
      new THREE.Mesh(
        markerGeo,
        new THREE.MeshBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.95 })
      )
    ];
    for (const m of handHitMarkers) {
      m.visible = false;
      scene.add(m);
    }

    const posAttr = geometry.attributes.position;
    const normalAttr = geometry.attributes.normal;

    const basePositions = new Float32Array(posAttr.array);
    const baseNormals = new Float32Array(normalAttr.array);
    const vertexCount = posAttr.count;

    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
      const y = basePositions[i * 3 + 1];
      yMin = Math.min(yMin, y);
      yMax = Math.max(yMax, y);
    }
    const ySpan = Math.max(1e-5, yMax - yMin);

    // 물레를 도자기 “바로 밑”에 더 가깝게 맞춥니다.
    const wheelThickness = 0.08;
    const clayBottomWorldY = clayGroup.position.y + yMin;
    wheel.position.y = clayBottomWorldY - wheelThickness / 2 - 0.01;
    const nextWheelTopY = wheel.position.y + wheelThickness / 2;
    spokesGroup.position.y = nextWheelTopY;
    // indicatorLine의 y좌표(2개 버텍스)를 갱신합니다.
    {
      const arr = indicatorPosAttr.array;
      arr[1] = nextWheelTopY;
      arr[4] = nextWheelTopY;
      indicatorPosAttr.needsUpdate = true;
    }

    // dentOffsets[i]는 “base normal 방향”으로의 추가 변형 깊이(안쪽은 음수)
    const dentOffsets = new Float32Array(vertexCount);
    const maxDent = -0.12;

    const raycaster = new THREE.Raycaster();
    const prevIndexByKeyRef = { current: {} };
    const spinRef = { current: 0 };
    const wheelAngleRef = { current: 0 };
    const baseRotRef = { current: 0 };
    const lastSculptAtRef = { current: {} };

    // 조각 영역(클레이 높이 기준 u: 0..1)
    // 노랑: 파임(상부/목 근처), 파랑: 눌림(하부)
    const uYellowCenter = 0.46;
    const uYellowHalfWidth = 0.14;
    const uBlueCenter = 0.72;
    const uBlueHalfWidth = 0.14;

    function resize() {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    }
    resize();

    function ndcFromScreenPoint(screenX, screenY) {
      const x = (screenX / window.innerWidth) * 2 - 1;
      const y = -(screenY / window.innerHeight) * 2 + 1;
      return { x, y };
    }

    let raf = 0;
    const clock = new THREE.Clock();

    function updateClay(targetProfile) {
      const pos = posAttr.array;

      for (let i = 0; i < vertexCount; i++) {
        const bi = i * 3;
        const bx = basePositions[bi];
        const by = basePositions[bi + 1];
        const bz = basePositions[bi + 2];

        const baseR = Math.hypot(bx, bz);
        const u = (by - yMin) / ySpan;
        const targetR = sampleRadiusFromProfile(targetProfile, u);
        const scale = baseR > 1e-5 ? targetR / baseR : 1;

        pos[bi] = bx * scale + baseNormals[bi] * dentOffsets[i];
        pos[bi + 1] = by + baseNormals[bi + 1] * dentOffsets[i];
        pos[bi + 2] = bz * scale + baseNormals[bi + 2] * dentOffsets[i];
      }

      posAttr.needsUpdate = true;
      geometry.computeVertexNormals();
    }

    function sculptAtHand(hand, targetProfile) {
      const key = hand.handedness || hand.id || 'hand';
      const hit = handDataRef.current.hitById?.[key];
      if (!hit?.active) return false;

      const strength01 = clamp01(hit.touch ?? 0);
      const uHit = hit.uHit ?? 0.5;
      const yellowN = hit.yellowN ?? 0.5;

      if (strength01 < 0.03) return false;

      const now = Date.now();
      const last = lastSculptAtRef.current[key] || 0;
      // 노랑(pull)은 비교적 빠르게 반영하고, 파랑(push)은 과부풀림을 줄이기 위해 더 느리게 반영합니다.
      const cooldown = yellowN >= 0.5 ? 85 : 120;
      if (now - last < cooldown) return false; // 같은 손이 연속으로 너무 빠르게 변형되는 것 방지

      const p = Math.pow(strength01, 1.25);

      // uHit가 노랑/파랑 “대역”에 가까울수록 가중치를 키워줍니다.
      // 이렇게 하면 목~아래 전 구간에서 더 섬세하게 컨트롤이 됩니다(하드 컷 제거).
      const yellowW = Math.exp(-Math.pow((uHit - uYellowCenter) / uYellowHalfWidth, 2));
      const blueW = Math.exp(-Math.pow((uHit - uBlueCenter) / uBlueHalfWidth, 2));
      const wSum = yellowW + blueW;
      if (wSum < 0.06) return false;
      const yellowNN = yellowW / (wSum || 1); // 0..1
      const zoneT = Math.max(yellowW, blueW); // 0..1

      // 노랑(잡아당김): 안으로(음수)
      // 파랑(밀기): 바깥으로(양수)인데, 과하게 솟지 않도록 약하게 둡니다.
      const pullCoeff = 0.085; // 노랑(파임) 중심 강도
      const pushCoeff = 0.06; // 파랑(펴짐) 중심 강도(상단 과부풀림 완화용)
      // yellowNN=1 => -pullCoeff, yellowNN=0 => +pushCoeff
      const depthMag = (pushCoeff * (1 - yellowNN) - pullCoeff * yellowNN) * p;

      // 중앙에 닿을수록 더 좁고 섬세하게
      const sigmaBase = 0.085 * yellowN + 0.11 * (1 - yellowN);
      const sigma = sigmaBase * (1.0 - 0.5 * zoneT) * 0.85;
      const falloffPower = 2.2 * yellowN + 1.7 * (1 - yellowN);

      // 질량 보존(커널 보상): 중심 dent는 깊게, 주변 bulge는 더 넓게 + 약하게
      const outerSigmaMultiplier = 2.1;
      // push(파랑, yellowNN 낮음)은 “복원/펴짐” 쪽이므로 주변으로 덜 퍼지게(더 채우게) 합니다.
      // pull(노랑, yellowNN 높음)은 주변 보상 퍼짐을 더 크게 둡니다.
      const outerStrength = lerp(0.35, 0.75, yellowNN);
      const outerPower = 1.25;

      // 좌우 대칭(회전 다듬기)을 위해, “각도”는 무시하고 높이(u) 기준으로만 ring 형태로 dentOffsets를 만듭니다.
      // 즉, 해당 높이 근처의 띠가 균일하게 들어가거나(노랑) 눌립니다(파랑).
      const inv2Sigma2 = 1 / (2 * sigma * sigma);
      const outerSigma = sigma * outerSigmaMultiplier;
      const inv2OuterSigma2 = 1 / (2 * outerSigma * outerSigma);
      for (let i = 0; i < vertexCount; i++) {
        const bi = i * 3;
        const by = basePositions[bi + 1];
        const u = (by - yMin) / ySpan;
        const du = u - uHit;
        const d2 = du * du;

        if (Math.abs(du) > 3 * sigma) continue;

        const centerFalloff = Math.exp(-d2 * inv2Sigma2);
        const outerFalloff = Math.exp(-d2 * inv2OuterSigma2);

        // depthMag는 음수(안으로)이고, outer 항은 -depthMag 방향(바깥)으로 보상합니다.
        // delta = depthMag * (center - outerStrength * outer) 형태로 만들어,
        // 중심에서는 음수, 주변에서는 양수로 뒤집히게 합니다.
        const centerInfluence = Math.pow(centerFalloff, falloffPower);
        const outerInfluence = Math.pow(outerFalloff, falloffPower * outerPower);
        const delta = depthMag * (centerInfluence - outerStrength * outerInfluence);

        const next = dentOffsets[i] + delta;
        const maxBulge = 0.035;
        dentOffsets[i] = clamp(next, maxDent, maxBulge);
      }

      lastSculptAtRef.current[key] = now;

      // sculpt 결과를 즉시 반영할 거라서 updateClay는 상위에서 한 번 더 호출합니다.
      return true;
    }

    function animate() {
      raf = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      const dt = clock.getDelta();

      const state = handDataRef.current;
      const hands = state?.hands || [];
      const now = Date.now();
      const fresh = state?.updatedAt ? now - state.updatedAt < 900 : false;
      const activeHands = fresh ? hands : [];

      // 2D 오버레이에서 사용할 “손-도자기 히트” 정보를 공유합니다.
      const hitById = handDataRef.current.hitById || (handDataRef.current.hitById = {});
      const activeKeys = new Set(activeHands.map((h) => h.handedness || h.id || 'hand'));
      const defaultHitState = { active: false, touch: 0, yellowN: 0.5, tipScale: 1, lineFactor: 1, uHit: 0 };
      for (const key of activeKeys) {
        const prev = hitById[key] || defaultHitState;
        hitById[key] = {
          ...prev,
          active: false,
          touch: 0
        };
      }
      // activeHands에 없는 손은 히트를 꺼둡니다(단, 이전 deform 값은 유지).
      for (const k of Object.keys(hitById)) {
        if (!activeKeys.has(k)) {
          const prev = hitById[k] || defaultHitState;
          hitById[k] = { ...prev, active: false, touch: 0 };
        }
      }

      const avg = (arr, fn, fallback) => {
        if (!arr.length) return fallback;
        let sum = 0;
        let count = 0;
        for (const it of arr) {
          const v = fn(it);
          if (typeof v === 'number' && Number.isFinite(v)) {
            sum += v;
            count++;
          }
        }
        return count ? sum / count : fallback;
      };

      const pinch = avg(activeHands, (h) => h.metrics?.pinch, initialMetrics.pinch);

      // 양손 “벌림/좁아짐”은 패널 기준 indexScreenNorm.x 차이로 계산합니다.
      const handsWithX = activeHands
        .map((h) => ({ h, x: h.indexScreenNorm?.x }))
        .filter((it) => typeof it.x === 'number' && Number.isFinite(it.x))
        .sort((a, b) => a.x - b.x);

      let interHandSpread = initialMetrics.spreadX;
      if (handsWithX.length >= 2) {
        const leftX = handsWithX[0].x;
        const rightX = handsWithX[1].x;
        interHandSpread = clamp01((rightX - leftX) * 1.35);
      }

      const palmX = avg(activeHands, (h) => h.metrics?.palmX, initialMetrics.palmX);

      // 손이 만드는 형태 변화도 과격해지지 않도록 스케일합니다.
      const pinchK = 0.55;
      const spreadK = 0.55;
      const targetMetrics = { pinch: pinch * pinchK, spreadX: interHandSpread * spreadK, palmX };
      // 손이 없어도 바로 원통으로 되돌아가지 않게: 마지막 손 감지 시점 이후 짧은 공백은 형태 유지
      let targetProfile = lastTargetProfile;
      if (activeHands.length) {
        targetProfile = computeClayProfile(targetMetrics);
        lastTargetProfile = targetProfile;
        lastHandsSeenAt = now;
      } else {
        const elapsedSinceHands = now - lastHandsSeenAt;
        if (elapsedSinceHands > 2000) targetProfile = cylinderProfile;
      }

      // 매 프레임 silhouette을 부드럽게 블렌딩합니다.
      // (갑자기 변하면 조각이 너무 과격하게 보일 수 있어서 완충합니다.)
      const profileBlend = 0.07; // 손 입력에 의해 형태가 과하게 바뀌지 않게 완충
      for (let i = 0; i < currentProfile.length; i++) {
        currentProfile[i].x = lerp(currentProfile[i].x, targetProfile[i].x, profileBlend);
        currentProfile[i].y = lerp(currentProfile[i].y, targetProfile[i].y, profileBlend);
      }

      // 매 프레임 silhouette 업데이트 (dentOffsets는 누적된 상태로 유지)
      updateClay(currentProfile);

      // 마커 위치/크기 업데이트
      const yYellow = lerp(yMin, yMax, uYellowCenter);
      const yBlue = lerp(yMin, yMax, uBlueCenter);
      yellowMarker.position.y = yYellow;
      blueMarker.position.y = yBlue;
      yellowMarker.scale.setScalar(sampleRadiusFromProfile(currentProfile, uYellowCenter));
      blueMarker.scale.setScalar(sampleRadiusFromProfile(currentProfile, uBlueCenter));

      // 손이 도자기 표면에 닿는 위치(파임/누름 영역)를 3D에서 보여줍니다.
      const sortedForMarkers = activeHands
        .slice()
        .sort((a, b) => (a.indexScreenNorm?.x ?? 0.5) - (b.indexScreenNorm?.x ?? 0.5))
        .slice(0, 2);

      for (let i = 0; i < 2; i++) {
        const marker = handHitMarkers[i];
        const hand = sortedForMarkers[i];
        if (!hand?.indexScreen) {
          marker.visible = false;
          continue;
        }

        const key = hand.handedness || hand.id || 'hand';

        const ndc = ndcFromScreenPoint(hand.indexScreen.x, hand.indexScreen.y);
        raycaster.setFromCamera(ndc, camera);
        const hitsSoft = raycaster.intersectObject(colliderMesh, false);
        if (!hitsSoft || hitsSoft.length === 0) {
          marker.visible = false;
          continue;
        }

        const hitsHard = raycaster.intersectObject(mesh, false);

        const hitPoint = hitsSoft[0].point;
        const hitLocal = mesh.worldToLocal(hitPoint.clone()); // 높이(uHit)는 “실제 클레이” 기준으로 읽습니다.
        const uHit = (hitLocal.y - yMin) / ySpan;
        const yellowW = Math.exp(-Math.pow((uHit - uYellowCenter) / uYellowHalfWidth, 2));
        const blueW = Math.exp(-Math.pow((uHit - uBlueCenter) / uBlueHalfWidth, 2));
        const wSum = yellowW + blueW;
        if (wSum < 0.06) {
          marker.visible = false;
          continue;
        }
        const yellowN = yellowW / (wSum || 1);

        // “들어가있는 정도”를 레이 관통 깊이로 추정합니다.
        // hard 히트가 있으면 더 정확하고, 없으면 soft로 근사합니다.
        const penMax = 0.5;
        const pen =
          hitsHard && hitsHard.length >= 2
            ? hitsHard[1].distance - hitsHard[0].distance
            : hitsSoft.length >= 2
              ? hitsSoft[1].distance - hitsSoft[0].distance
              : 0;
        const penN = clamp01(pen / penMax);

        // pinch은 “손가락을 누르는 의도” 정도로만 보정합니다.
        const pinchPress = clamp01(hand.metrics?.touch ?? 0);
        const strength01Raw = clamp01(pinchPress * 0.25 + penN * 0.75);
        // 손 입력의 전체 운동량을 줄여 도자기 중심이 더 안정적으로 보이게 합니다.
        const handKineticScale = 0.55;
        const strength01 = clamp01(strength01Raw * handKineticScale);

        // 너무 멀면(관통 깊이 작으면) 영향 주지 않음
        if (strength01 < 0.03) {
          marker.visible = false;
          continue;
        }

        // 손가락 점/선이 “푹 들어가거나/펴지는” 효과를 2D에 주기 위한 정보 기록
        const isYellow = yellowN >= 0.5;
        const t = strength01;
        const tipScale = isYellow ? 1 - 0.55 * t : 0.75 + 0.35 * t;
        const lineFactor = isYellow ? 1 - 0.42 * t : 1 + 0.28 * t;
        hitById[key] = {
          active: true,
          touch: strength01,
          yellowN,
          uHit,
          tipScale,
          lineFactor
        };

        marker.material.color.setHex(yellowN > 0.5 ? 0xffd24a : 0x3b82f6);
        marker.position.copy(hitPoint);
        marker.scale.setScalar(0.7 + strength01 * 1.8);
        marker.visible = true;
      }

      // wheel 느낌: 손 좌우 이동을 회전으로
      let deltaXSum = 0;
      let deltaCount = 0;
      for (const h of activeHands) {
        const key = h.handedness || h.id || 'hand';
        const curX = h.indexScreenNorm?.x ?? h.metrics?.indexTip?.x ?? 0.5;
        if (typeof curX !== 'number' || !Number.isFinite(curX)) continue;
        const prev = prevIndexByKeyRef.current[key];
        if (typeof prev === 'number') {
          deltaXSum += curX - prev;
          deltaCount++;
        }
        prevIndexByKeyRef.current[key] = curX;
      }
      const pressAvg = avg(activeHands, (h) => h.metrics?.touch ?? 0, 0);
      const pressT = smoothstep(0.15, 0.85, pressAvg);
      // 강하게 누르면 물레 회전이 느려지고(마찰↑), 입력도 감소합니다.
      const spinScale = lerp(1.0, 0.35, pressT);

      // 기본 모터 회전: 손을 멈춰도 물레는 계속 돕니다.
      // 강하게 누를수록(pressT↑) spinScale이 줄어 회전도 함께 느려집니다.
      const autoSpeed = 0.75; // rad/s
      wheelAngleRef.current += dt * autoSpeed * spinScale;

      if (deltaCount) {
        const deltaX = deltaXSum / deltaCount;
        spinRef.current = spinRef.current * (0.92 + 0.06 * pressT) + deltaX * 3.8 * spinScale;
      } else {
        spinRef.current *= 0.92 + 0.06 * pressT;
      }

      const palmCentered = ((palmX ?? 0.5) - 0.5) * 2; // -1..1
      baseRotRef.current = lerp(baseRotRef.current, palmCentered * 0.85, 0.08);

      const targetRotY = wheelAngleRef.current + baseRotRef.current + spinRef.current * 0.9 * spinScale;
      const rotLerp = lerp(0.18, 0.12, pressT);
      clayGroup.rotation.y = lerp(clayGroup.rotation.y, targetRotY, rotLerp);

      // 상단 표시 라인은 물레/클레이 회전과 동일하게 회전시켜 “돌고 있음”을 직관적으로 보여줍니다.
      indicatorLine.rotation.y = clayGroup.rotation.y;
      wheel.rotation.y = clayGroup.rotation.y;
      spokesGroup.rotation.y = clayGroup.rotation.y;

      // 위아래로 꿀렁거리지 않게 X/Z 흔들림을 줄입니다.
      clayGroup.rotation.x = lerp(clayGroup.rotation.x, palmCentered * 0.03, 0.12);
      clayGroup.rotation.z = lerp(clayGroup.rotation.z, 0, 0.12);

      // “터치 중일 때만 작아지고/커지고”, 놓으면 그 상태가 오래 유지되게 합니다.
      let anyHitActive = false;
      for (const key of activeKeys) {
        if (hitById[key]?.active) {
          anyHitActive = true;
          break;
        }
      }
      const relaxHole = activeHands.length
        ? anyHitActive
          ? 0.9992
          : 0.99998
        : 0.995;
      // bulge(양수)가 쌓여 과부풀림이 생기지 않게 더 빨리 가라앉힙니다.
      const relaxBulge = activeHands.length
        ? anyHitActive
          ? 0.9986
          : 0.99895
        : 0.992;

      for (let i = 0; i < vertexCount; i++) {
        const r = dentOffsets[i] > 0 ? relaxBulge : relaxHole;
        dentOffsets[i] *= r;
      }

      // 2손 조각: 노랑(파임) / 파랑(누름)
      let sculpted = false;
      for (const h of activeHands) {
        const ok = sculptAtHand(h, currentProfile);
        sculpted = sculpted || ok;
      }
      if (sculpted) {
        // sculpt 결과를 즉시 반영
        updateClay(currentProfile);
      }

      renderer.render(scene, camera);
    }

    function onResize() {
      resize();
    }
    window.addEventListener('resize', onResize);

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

