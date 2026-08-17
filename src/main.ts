/** Bootstrap. Wires the engine, boots into the first playable surface. */
import { Engine } from '@/core/Engine';
import { events } from '@/core/EventBus';
import { settings } from '@/core/Settings';

interface BootUi {
  set(t: number, label: string): void;
  done(): void;
}

function bootUi(): BootUi {
  const bar = document.getElementById('boot-bar') as HTMLElement | null;
  const label = document.getElementById('boot-label') as HTMLElement | null;
  const boot = document.getElementById('boot') as HTMLElement | null;
  return {
    set(t, text) {
      if (bar) bar.style.width = `${Math.round(Math.max(0, Math.min(1, t)) * 100)}%`;
      if (label) label.textContent = text;
    },
    done() {
      boot?.classList.add('hidden');
      window.setTimeout(() => boot?.remove(), 700);
    },
  };
}

function hasWebGL2(canvas: HTMLCanvasElement): boolean {
  try {
    return !!canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  if (!canvas || !hasWebGL2(canvas)) {
    const el = document.getElementById('nosupport');
    if (el) el.style.display = 'grid';
    return;
  }

  const ui = bootUi();
  ui.set(0.04, 'Booting engine');

  const engine = new Engine(canvas);
  // Exposed for the automated visual-critic harness and for debugging.
  (window as unknown as { GF: unknown }).GF = { engine, settings, events };

  const { installGame } = await import('@/core/Game');
  await installGame(engine, (t, label) => ui.set(0.05 + t * 0.94, label));

  ui.set(1, 'Ready');
  ui.done();
  engine.start();
}

main().catch((err) => {
  console.error('[boot] fatal', err);
  const label = document.getElementById('boot-label');
  if (label) {
    label.textContent = `Boot failed: ${String((err as Error)?.message ?? err)}`;
    label.style.color = '#ff7b7b';
  }
});
