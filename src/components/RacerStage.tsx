import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import type { CameraState, TrackDefinition, TrainingStats } from '../types';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../lib/geometry';
import { RacerScene } from '../sim/RacerScene';

type RacerStageProps = {
  onReady: (scene: RacerScene | null) => void;
  onStats: (stats: TrainingStats) => void;
  onTrackChange: (track: TrackDefinition) => void;
  onStorageChange: (hasSave: boolean) => void;
  onCameraChange: (camera: CameraState) => void;
};

export function RacerStage(props: RacerStageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    const scene = new RacerScene({
      onReady: (readyScene) => propsRef.current.onReady(readyScene),
      onStats: (stats) => propsRef.current.onStats(stats),
      onTrackChange: (track) => propsRef.current.onTrackChange(track),
      onStorageChange: (hasSave) => propsRef.current.onStorageChange(hasSave),
      onCameraChange: (camera) => propsRef.current.onCameraChange(camera),
    });

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      backgroundColor: '#090b10',
      scene,
      scale: {
        mode: Phaser.Scale.NONE,
      },
      physics: {
        default: 'matter',
        matter: {
          gravity: { x: 0, y: 0 },
          debug: false,
        },
      },
    });

    return () => {
      game.destroy(true);
      propsRef.current.onReady(null);
    };
  }, []);

  return <div ref={containerRef} className="racer-stage" aria-label="Neuro racer simulator canvas" />;
}
