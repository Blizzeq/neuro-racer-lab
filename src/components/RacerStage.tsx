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

    let game: Phaser.Game | null = null;
    let ready = false;
    let destroyed = false;
    let bootTimer: number | undefined;
    let retryCount = 0;
    let bootToken = 0;

    const bootGame = () => {
      if (destroyed || !containerRef.current) {
        return;
      }

      ready = false;
      const currentBootToken = ++bootToken;
      const scene = new RacerScene({
        onReady: (readyScene) => {
          if (destroyed || currentBootToken !== bootToken) {
            return;
          }
          ready = true;
          if (bootTimer !== undefined) {
            window.clearTimeout(bootTimer);
            bootTimer = undefined;
          }
          propsRef.current.onReady(readyScene);
        },
        onStats: (stats) => propsRef.current.onStats(stats),
        onTrackChange: (track) => propsRef.current.onTrackChange(track),
        onStorageChange: (hasSave) => propsRef.current.onStorageChange(hasSave),
        onCameraChange: (camera) => propsRef.current.onCameraChange(camera),
      });

      game = new Phaser.Game({
        type: Phaser.CANVAS,
        parent: containerRef.current,
        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,
        backgroundColor: '#090b10',
        scene,
        scale: {
          mode: Phaser.Scale.NONE,
        },
        render: {
          clearBeforeRender: true,
          transparent: false,
        },
        physics: {
          default: 'matter',
          matter: {
            gravity: { x: 0, y: 0 },
            debug: false,
          },
        },
      });

      bootTimer = window.setTimeout(() => {
        if (ready || destroyed || retryCount >= 1) {
          return;
        }
        retryCount += 1;
        game?.destroy(true);
        game = null;
        propsRef.current.onReady(null);
        window.setTimeout(bootGame, 0);
      }, 8000);
    };

    bootGame();

    return () => {
      destroyed = true;
      if (bootTimer !== undefined) {
        window.clearTimeout(bootTimer);
      }
      game?.destroy(true);
      propsRef.current.onReady(null);
    };
  }, []);

  return <div ref={containerRef} className="racer-stage" aria-label="Neuro racer simulator canvas" />;
}
