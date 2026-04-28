import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bot,
  BrainCircuit,
  Download,
  Gauge,
  Pause,
  PenLine,
  Play,
  RefreshCcw,
  Route,
  Save,
  Upload,
  Zap,
} from 'lucide-react';
import type { TrainingConfig, TrainingStats } from './types';
import { DEFAULT_TRAINING_CONFIG } from './types';
import { RacerStage } from './components/RacerStage';
import type { RacerScene } from './sim/RacerScene';
import './styles.css';

const INITIAL_STATS: TrainingStats = {
  generation: 0,
  bestScore: 0,
  bestEver: 0,
  averageScore: 0,
  aliveCount: 0,
  populationSize: DEFAULT_TRAINING_CONFIG.populationSize,
  checkpointProgress: 0,
  maxCheckpoint: 0,
  history: [],
  status: 'ready',
};

export function App() {
  const sceneRef = useRef<RacerScene | null>(null);
  const [stats, setStats] = useState<TrainingStats>(INITIAL_STATS);
  const [config, setConfig] = useState<TrainingConfig>(DEFAULT_TRAINING_CONFIG);
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

  const chartPoints = useMemo(() => buildChartPoints(stats.history), [stats.history]);

  function handleReady(scene: RacerScene | null): void {
    sceneRef.current = scene;
  }

  function toggleRun(): void {
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
    setNotice('Preset loaded');
  }

  function resetTraining(): void {
    sceneRef.current?.resetTraining();
    setRunning(false);
    setNotice('Generation reset');
  }

  function saveCurrent(): void {
    const snapshot = sceneRef.current?.saveCurrentSnapshot();
    if (snapshot) {
      setNotice(`Saved ${new Date(snapshot.savedAt).toLocaleTimeString()}`);
      setCanLoad(true);
    }
  }

  function loadSaved(): void {
    const snapshot = sceneRef.current?.loadSavedSnapshot();
    if (snapshot) {
      setRunning(false);
      setDrawing(false);
      setTrackName(snapshot.track.name);
      setNotice('Save loaded');
    } else {
      setNotice('No save found');
    }
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
            }}
            onStorageChange={setCanLoad}
          />
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
            <Metric icon={<Gauge size={18} />} label="Best" value={formatScore(stats.bestScore)} />
            <Metric icon={<Zap size={18} />} label="Best ever" value={formatScore(stats.bestEver)} />
            <Metric icon={<Bot size={18} />} label="Alive" value={`${stats.aliveCount}/${stats.populationSize}`} />
          </section>

          <section className="panel-section">
            <div className="section-heading">
              <span>Training</span>
              <span>{Math.round(stats.checkpointProgress * 100)}%</span>
            </div>
            <div className="progress-track">
              <span style={{ width: `${Math.round(stats.checkpointProgress * 100)}%` }} />
            </div>
            <svg className="fitness-chart" viewBox="0 0 220 72" role="img" aria-label="Best score history">
              <polyline points={chartPoints} />
            </svg>
          </section>

          <section className="panel-section controls">
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
          </section>

          <section className="panel-section algorithm-note">
            <strong>Genome</strong>
            <span>8 sensor inputs · 7 hidden neurons · 2 driving outputs</span>
          </section>
        </aside>
      </section>
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
