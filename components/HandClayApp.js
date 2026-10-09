import { useRef, useState } from 'react';
import HandTracker from './HandTracker';
import HandClayScene from './HandClaySceneV2';
import styles from '../styles/HandClayApp.module.css';

export default function HandClayApp() {
  // React re-render를 유발하지 않기 위해 가장 최근 손 데이터를 ref에만 유지합니다.
  const handDataRef = useRef({
    hands: [],
    updatedAt: 0,
    hitById: {}
  });

  const ceramicColors = [
    { id: 'white', name: 'White', hex: '#f6f7f8' },
    { id: 'cream', name: 'Cream', hex: '#f5e6c8' },
    { id: 'sand', name: 'Sand', hex: '#e9d2a6' },
    { id: 'pearl', name: 'Pearl', hex: '#dce6ea' },
    { id: 'ivory', name: 'Ivory', hex: '#f3efe6' },
    { id: 'sky', name: 'Sky', hex: '#cfe7ff' }
  ];

  const [ceramicColor, setCeramicColor] = useState(ceramicColors[0].hex);

  return (
    <div className={styles.root}>
      <div className={styles.threeWrap}>
        <HandClayScene handDataRef={handDataRef} ceramicColor={ceramicColor} />
      </div>

      <div className={styles.overlay}>
        <HandTracker handDataRef={handDataRef} />

        <div className={styles.palette} role="group" aria-label="Ceramic color palette">
          <div className={styles.paletteTitle}>Color</div>
          <div className={styles.paletteSwatches}>
            {ceramicColors.map((c) => (
              <button
                key={c.id}
                type="button"
                className={styles.swatch}
                aria-label={c.name}
                style={{
                  background: c.hex,
                  outline: ceramicColor === c.hex ? '2px solid rgba(255,255,255,0.95)' : '2px solid rgba(255,255,255,0.18)'
                }}
                onClick={() => setCeramicColor(c.hex)}
              />
            ))}
          </div>
        </div>

        <div className={styles.hud}>
          <div className={styles.title}>Potter Hands</div>
          <div className={styles.sub}>손을 화면에 비추면 도자기 형태가 실시간으로 변형됩니다.</div>
        </div>
      </div>
    </div>
  );
}

