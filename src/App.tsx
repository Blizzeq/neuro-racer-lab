import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bot,
  BrainCircuit,
  Crosshair,
  Download,
  FileDown,
  FileUp,
  Gauge,
  Maximize2,
  Pause,
  PenLine,
  Play,
  RefreshCcw,
  Route,
  Save,
  Upload,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { CameraState, TrainingConfig, TrainingMode, TrainingStats } from './types';
import { DEFAULT_TRAINING_CONFIG } from './types';
import { RacerStage } from './components/RacerStage';
import type { RacerScene } from './sim/RacerScene';
import { snapshotTime } from './lib/storage';
import './styles.css';

const INITIAL_STATS: TrainingStats = {
  generation: 0,
  bestScore: 0,
  bestEver: 0,
  currentBestLapTicks: null,
  bestLapTicks: null,
  lapCompletions: 0,
  averageScore: 0,
  aliveCount: 0,
  populationSize: DEFAULT_TRAINING_CONFIG.populationSize,
  checkpointProgress: 0,
  maxCheckpoint: 0,
  crashRate: 0,
  bestProgress: 0,
  eliteCount: 0,
  teacherChildren: 0,
  trainingPhase: 'learningStart',
  activeSegmentIndex: null,
  segmentCoverage: 0,
  hardestSegmentIndex: null,
  recordAttempts: 0,
  validationLapTicks: null,
  goalTargetLapTicks: 0,
  goalProgress: 0,
  finalRoundsCompleted: 0,
  finalRoundTarget: DEFAULT_TRAINING_CONFIG.finalExamRounds,
  trainingComplete: false,
  history: [],
  status: 'ready',
};

const PLAN_PRESETS: Record<TrainingMode, Partial<TrainingConfig>> = {
  smartCoach: {
    mutationRate: 0.16,
    elitismRate: 0.14,
    teacherCloneRate: 0.34,
    randomImmigrantRate: 0.18,
    smartSegmentCount: 12,
    smartStartsPerGeneration: 5,
    fullLapValidationInterval: 5,
    targetLapTicks: null,
    finalExamRounds: 3,
    goalPatienceGenerations: 18,
    advancedTuningEnabled: false,
  },
  fullLap: {
    mutationRate: 0.14,
    elitismRate: 0.16,
    teacherCloneRate: 0.38,
    randomImmigrantRate: 0.14,
    targetLapTicks: null,
    finalExamRounds: 3,
    goalPatienceGenerations: 18,
    advancedTuningEnabled: false,
  },
  manualLab: {
    advancedTuningEnabled: true,
  },
};

export function App() {
  const sceneRef = useRef<RacerScene | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [stats, setStats] = useState<TrainingStats>(INITIAL_STATS);
  const [config, setConfig] = useState<TrainingConfig>(DEFAULT_TRAINING_CONFIG);
  const [camera, setCamera] = useState<CameraState>({ zoom: 1, scrollX: 0, scrollY: 0, followBest: false });
  const [running, setRunning] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [trackName, setTrackName] = useState('Neon Circuit');
  const [canLoad, setCanLoad] = useState(false);
  const [notice, setNotice] = useState('Ready');

  useEffect(() => {
    sceneRef.current?.applyConfig(config);
  }, [config]);

  useEffect(() => {
    sceneRef.current?.setRunning(running);
  }, [running]);

  useEffect(() => {
    sceneRef.current?.setDrawing(drawing);
  }, [drawing]);

  useEffect(() => {
    if (stats.status === 'complete') {
      setRunning(false);
      setNotice('Training complete');
    }
  }, [stats.status]);

  const chartPoints = useMemo(() => buildChartPoints(stats.history), [stats.history]);
  const trainingProgress = stats.goalProgress;
  const phaseText = formatTrainingPhase(stats);
  const planNote = formatPlanNote(config.trainingMode);

  function handleReady(scene: RacerScene | null): void {
    sceneRef.current = scene;
    if (scene) {
      setCamera(scene.getCameraState());
    }
  }

  function toggleRun(): void {
    if (!running && stats.status === 'complete') {
      setNotice('Run champion or reset');
      return;
    }
    setDrawing(false);
    setRunning((value) => !value);
    setNotice(running ? 'Paused' : 'Training');
  }

  function toggleDraw(): void {
    setRunning(false);
    setDrawing((value) => !value);
    setNotice(drawing ? 'Track locked' : 'Draw mode');
  }

  function loadPreset(): void {
    sceneRef.current?.loadPresetTrack();
    setRunning(false);
    setDrawing(false);
    setTrackName('Neon Circuit');
    setCamera(sceneRef.current?.getCameraState() ?? camera);
    setNotice('Preset loaded');
  }

  function resetTraining(): void {
    sceneRef.current?.resetTraining();
    setRunning(false);
    setNotice('Generation reset');
  }

  function runChampion(): void {
    const started = sceneRef.current?.runChampionDemo();
    if (started) {
      setDrawing(false);
      setRunning(true);
      setNotice('Champion run');
    } else {
      setNotice('No champion yet');
    }
  }

  function saveCurrent(): void {
    const snapshot = sceneRef.current?.saveCurrentSnapshot();
    if (snapshot) {
      setNotice(`Saved ${new Date(snapshot.timestamp).toLocaleTimeString()}`);
      setCanLoad(true);
    }
  }

  function loadSaved(): void {
    const snapshot = sceneRef.current?.loadSavedSnapshot();
    if (snapshot) {
      setRunning(false);
      setDrawing(false);
      if (snapshot.version === 2) {
        setConfig(snapshot.config);
      }
      setTrackName(snapshot.track.name);
      setCamera(sceneRef.current?.getCameraState() ?? camera);
      setNotice(`Loaded ${new Date(snapshotTime(snapshot)).toLocaleTimeString()}`);
    } else {
      setNotice('No save found');
    }
  }

  function applyTrainingMode(trainingMode: TrainingMode): void {
    setConfig((value) => ({
      ...value,
      trainingMode,
      ...PLAN_PRESETS[trainingMode],
    }));
    setNotice(formatPlanName(trainingMode));
  }

  function handleZoomIn(): void {
    sceneRef.current?.zoomIn();
    setCamera(sceneRef.current?.getCameraState() ?? camera);
  }

  function handleZoomOut(): void {
    sceneRef.current?.zoomOut();
    setCamera(sceneRef.current?.getCameraState() ?? camera);
  }

  function handleFit(): void {
    sceneRef.current?.fitToTrack();
    setCamera(sceneRef.current?.getCameraState() ?? camera);
    setNotice('Camera fitted');
  }

  function handleFollowBest(): void {
    const next = sceneRef.current?.toggleFollowBest();
    if (next) {
      setCamera(next);
      setNotice(next.followBest ? 'Following best' : 'Free camera');
    }
  }

  function exportSnapshot(): void {
    const snapshot = sceneRef.current?.exportCurrentSnapshot();
    if (!snapshot) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `neuro-racer-lab-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice('JSON exported');
  }

  function openImportPicker(): void {
    importInputRef.current?.click();
  }

  function importSnapshot(file: File | undefined): void {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const snapshot = sceneRef.current?.importSnapshot(String(reader.result ?? ''));
      if (snapshot) {
        setConfig(snapshot.config);
        setTrackName(snapshot.track.name);
        setRunning(false);
        setDrawing(false);
        setCamera(sceneRef.current?.getCameraState() ?? camera);
        setNotice('JSON imported');
      } else {
        setNotice('Import failed');
      }
      if (importInputRef.current) {
        importInputRef.current.value = '';
      }
    };
    reader.readAsText(file);
  }

  return (
    <main className="app-shell">
      <section className="workspace" aria-label="Neuro Racer Lab">
        <div className="stage-panel">
          <header className="topbar">
            <div>
              <p className="eyebrow">browser neuroevolution</p>
              <h1>Neuro Racer Lab</h1>
            </div>
            <div className="run-cluster">
              <button className="icon-button primary" type="button" onClick={toggleRun} title={running ? 'Pause' : 'Start'}>
                {running ? <Pause size={20} /> : <Play size={20} />}
                <span>{running ? 'Pause' : 'Start'}</span>
              </button>
              <button className="icon-button" type="button" onClick={resetTraining} title="Reset">
                <RefreshCcw size={18} />
              </button>
            </div>
          </header>

          <RacerStage
            onReady={handleReady}
            onStats={setStats}
            onTrackChange={(track) => {
              setTrackName(track.name);
              setNotice('Track generated');
              setCamera(sceneRef.current?.getCameraState() ?? camera);
            }}
            onStorageChange={setCanLoad}
            onCameraChange={setCamera}
          />

          <div className="camera-toolbar" aria-label="Camera controls">
            <button className="icon-button" type="button" onClick={handleZoomOut} title="Zoom out">
              <ZoomOut size={18} />
            </button>
            <button className="icon-button" type="button" onClick={handleZoomIn} title="Zoom in">
              <ZoomIn size={18} />
            </button>
            <button className="icon-button" type="button" onClick={handleFit} title="Fit track">
              <Maximize2 size={18} />
            </button>
            <button className={`icon-button ${camera.followBest ? 'active' : ''}`} type="button" onClick={handleFollowBest} title="Follow best car">
              <Crosshair size={18} />
            </button>
            <span>{Math.round(camera.zoom * 100)}%</span>
          </div>
        </div>

        <aside className="control-panel">
          <section className="panel-section status-section">
            <div className="status-line">
              <span className={`status-dot ${stats.status}`} />
              <strong>{notice}</strong>
            </div>
            <div className="track-name">
              <Route size={18} />
              <span>{trackName}</span>
            </div>
          </section>

          <section className="metrics-grid" aria-label="Training metrics">
            <Metric icon={<BrainCircuit size={18} />} label="Generation" value={stats.generation.toString()} />
            <Metric icon={<Gauge size={18} />} label="Best full lap" value={formatLapTime(stats.bestLapTicks)} />
            <Metric icon={<Zap size={18} />} label="Goal time" value={formatLapTime(stats.goalTargetLapTicks)} />
            <Metric icon={<Bot size={18} />} label="Alive" value={`${stats.aliveCount}/${stats.populationSize}`} />
            <Metric icon={<Crosshair size={18} />} label="Goal progress" value={`${Math.round(stats.goalProgress * 100)}%`} />
            <Metric icon={<RefreshCcw size={18} />} label="Crash rate" value={`${Math.round(stats.crashRate * 100)}%`} />
            <Metric icon={<Route size={18} />} label="Current phase" value={phaseText} />
            <Metric icon={<Gauge size={18} />} label="Final" value={`${stats.finalRoundsCompleted}/${stats.finalRoundTarget}`} />
          </section>

          <section className="panel-section">
            <div className="section-heading">
              <span>Goal: fastest full lap</span>
              <span>{Math.round(trainingProgress * 100)}%</span>
            </div>
            <div className="progress-track">
              <span style={{ width: `${Math.round(trainingProgress * 100)}%` }} />
            </div>
            <div className="goal-copy">
              <span>Beat {formatLapTime(stats.goalTargetLapTicks)} on a complete lap.</span>
              <span>Final exam: {stats.finalRoundTarget} full-lap runs by the best drivers.</span>
            </div>
            <svg className="fitness-chart" viewBox="0 0 220 72" role="img" aria-label="Best score history">
              <polyline points={chartPoints} />
            </svg>
          </section>

          {stats.status === 'complete' ? (
            <section className="panel-section completion-card">
              <strong>Training complete</strong>
              <span>Champion lap {formatLapTime(stats.bestLapTicks)} against goal {formatLapTime(stats.goalTargetLapTicks)}.</span>
              <button className="icon-button primary" type="button" onClick={runChampion}>
                <Play size={18} />
                <span>Run champion</span>
              </button>
            </section>
          ) : null}

          <section className="panel-section controls">
            <div className="control-row">
              <label htmlFor="mode">Training plan</label>
              <select
                id="mode"
                value={config.trainingMode}
                onChange={(event) => applyTrainingMode(event.target.value as TrainingMode)}
              >
                <option value="smartCoach">Smart Coach</option>
                <option value="fullLap">Full Lap Race</option>
                <option value="manualLab">Manual Lab</option>
              </select>
            </div>
            <div className="plan-note">{planNote}</div>
            <div className="control-row">
              <label htmlFor="speed">Speed</label>
              <input
                id="speed"
                type="range"
                min={1}
                max={8}
                step={1}
                value={config.speedMultiplier}
                onChange={(event) => setConfig((value) => ({ ...value, speedMultiplier: Number(event.target.value) }))}
              />
              <output>{config.speedMultiplier}x</output>
            </div>
            {config.trainingMode === 'manualLab' ? (
              <details className="advanced-tuning" open>
                <summary>Advanced tuning</summary>
                <div className="control-row">
                  <label htmlFor="population">Population</label>
                  <select
                    id="population"
                    value={config.populationSize}
                    onChange={(event) => setConfig((value) => ({ ...value, populationSize: Number(event.target.value) }))}
                  >
                    <option value={40}>40</option>
                    <option value={64}>64</option>
                    <option value={96}>96</option>
                    <option value={128}>128</option>
                  </select>
                </div>
                <div className="control-row">
                  <label htmlFor="mutation">Mutation</label>
                  <input
                    id="mutation"
                    type="range"
                    min={0.05}
                    max={0.35}
                    step={0.01}
                    value={config.mutationRate}
                    onChange={(event) => setConfig((value) => ({ ...value, mutationRate: Number(event.target.value) }))}
                  />
                  <output>{Math.round(config.mutationRate * 100)}%</output>
                </div>
              </details>
            ) : null}
          </section>

          <section className="panel-section command-grid">
            <button className={`icon-button ${drawing ? 'active' : ''}`} type="button" onClick={toggleDraw}>
              <PenLine size={18} />
              <span>Draw track</span>
            </button>
            <button className="icon-button" type="button" onClick={loadPreset}>
              <Download size={18} />
              <span>Preset</span>
            </button>
            <button className="icon-button" type="button" onClick={saveCurrent}>
              <Save size={18} />
              <span>Save</span>
            </button>
            <button className="icon-button" type="button" onClick={loadSaved} disabled={!canLoad}>
              <Upload size={18} />
              <span>Load</span>
            </button>
            <button className="icon-button" type="button" onClick={exportSnapshot}>
              <FileDown size={18} />
              <span>Export</span>
            </button>
            <button className="icon-button" type="button" onClick={openImportPicker}>
              <FileUp size={18} />
              <span>Import</span>
            </button>
          </section>

          <section className="panel-section algorithm-note">
            <strong>Coach</strong>
            <span>{phaseText} - goal {Math.round(stats.goalProgress * 100)}%</span>
            <span>Hardest sector {formatSector(stats.hardestSegmentIndex)} - coverage {Math.round(stats.segmentCoverage * 100)}%</span>
            <span>Best run = shortest completed lap; score fallback {formatScore(stats.bestScore)}</span>
            <span>8 sensor inputs - 7 hidden neurons - 2 driving outputs</span>
            <span>Elite {stats.eliteCount} - Teacher children {stats.teacherChildren} - Finishers {stats.lapCompletions}</span>
          </section>
        </aside>
      </section>
      <input
        ref={importInputRef}
        className="file-input"
        type="file"
        accept="application/json,.json"
        onChange={(event) => importSnapshot(event.target.files?.[0])}
      />
    </main>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="metric-tile">
      <div>
        {icon}
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
    </div>
  );
}

function formatScore(score: number): string {
  return Math.round(score).toLocaleString('en-US');
}

function formatLapTime(lapTicks: number | null): string {
  if (lapTicks === null) {
    return '--';
  }
  return `${(lapTicks / 60).toFixed(2)}s`;
}

function formatTrainingPhase(stats: TrainingStats): string {
  switch (stats.trainingPhase) {
    case 'learningStart':
      return 'Learning start';
    case 'trainingSector':
      return stats.activeSegmentIndex === null ? 'Training sector' : `Sector ${stats.activeSegmentIndex + 1}`;
    case 'hardCornerPractice':
      return stats.activeSegmentIndex === null ? 'Hard corner' : `Hard ${stats.activeSegmentIndex + 1}`;
    case 'fullLapValidation':
      return 'Full lap check';
    case 'recordAttempt':
      return 'Record attempt';
    case 'finalExam':
      return 'Final exam';
    case 'finalComplete':
      return 'Final complete';
  }
}

function formatPlanName(trainingMode: TrainingMode): string {
  switch (trainingMode) {
    case 'smartCoach':
      return 'Smart Coach';
    case 'fullLap':
      return 'Full Lap Race';
    case 'manualLab':
      return 'Manual Lab';
  }
}

function formatPlanNote(trainingMode: TrainingMode): string {
  switch (trainingMode) {
    case 'smartCoach':
      return 'Sectors + record checks';
    case 'fullLap':
      return 'Start line only';
    case 'manualLab':
      return 'Custom evolution';
  }
}

function formatSector(index: number | null): string {
  return index === null ? '--' : `${index + 1}`;
}

function buildChartPoints(history: number[]): string {
  const values = history.length > 1 ? history : [0, ...history];
  const max = Math.max(1, ...values);
  return values
    .map((value, index) => {
      const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 220;
      const y = 68 - (value / max) * 62;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
