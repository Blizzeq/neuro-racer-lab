import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import type { CameraState, TrackDefinition, TrainingStats } from '../types';
import { RacerScene } from '../sim/RacerScene';

type RacerStageProps = {
  onReady: (scene: RacerScene | null) => void;
  onStats: (stats: TrainingStats) => void;
  onTrackChange: (track: TrackDefinition) => void;
  onStorageChange: (hasSave: boolean) => void;
  onCameraChange: (camera: CameraState) => void;
  onMessage: (message: string) => void;
};

/** Device pixel ratio used for the canvas backing store; capped to keep fill-rate reasonable. */
const MAX_PIXEL_RATIO = 2;

export function RacerStage(props: RacerStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const pixelRatio = Math.min(MAX_PIXEL_RATIO, Math.max(1, window.devicePixelRatio || 1));
    let scene: RacerScene | null = null;
    const racerScene = new RacerScene({
      onReady: (readyScene) => {
        scene = readyScene;
        propsRef.current.onReady(readyScene);
      },
      onStats: (stats) => propsRef.current.onStats(stats),
      onTrackChange: (track) => propsRef.current.onTrackChange(track),
      onStorageChange: (hasSave) => propsRef.current.onStorageChange(hasSave),
      onCameraChange: (camera) => propsRef.current.onCameraChange(camera),
      onMessage: (message) => propsRef.current.onMessage(message),
    });

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: container,
      width: Math.max(1, Math.round(container.clientWidth * pixelRatio)),
      height: Math.max(1, Math.round(container.clientHeight * pixelRatio)),
      backgroundColor: '#090b10',
      banner: false,
      scene: racerScene,
      scale: {
        mode: Phaser.Scale.NONE,
        zoom: 1 / pixelRatio,
      },
      render: {
        antialias: true,
        powerPreference: 'high-performance',
      },
    });

    const resizeObserver = new ResizeObserver(() => {
      scene?.resizeViewport(container.clientWidth, container.clientHeight);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      scene = null;
      game.destroy(true);
      propsRef.current.onReady(null);
    };
  }, []);

  return <div ref={containerRef} className="racer-stage" aria-label="Neuro racer simulator canvas" />;
}
