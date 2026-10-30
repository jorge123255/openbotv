/**
 * Short tones for the bots list. They are generated here. There is no sound file.
 * A browser can block the tone until the user presses a control. The sound pill still shows.
 */

import type { RosterCategory } from "./roster-model";

export type RosterCue = RosterCategory | "needsYou" | "asleep";

interface ToneStep {
  frequency: number;
  duration: number;
  type: OscillatorType;
}

const CUES = {
  monitor: [{ frequency: 523, duration: 0.18, type: "sine" }],
  worker: [{ frequency: 349, duration: 0.16, type: "triangle" }],
  artist: [{ frequency: 784, duration: 0.2, type: "sine" }],
  helper: [{ frequency: 440, duration: 0.18, type: "sine" }],
  needsYou: [
    { frequency: 880, duration: 0.1, type: "sine" },
    { frequency: 1175, duration: 0.14, type: "sine" },
  ],
  asleep: [
    { frequency: 392, duration: 0.16, type: "sine" },
    { frequency: 196, duration: 0.28, type: "sine" },
  ],
} as const satisfies Record<RosterCue, readonly ToneStep[]>;

let audio: AudioContext | undefined;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") return null;
  audio ??= new window.AudioContext();
  return audio;
}

/** Plays one cue. Does nothing when this browser has no audio context. */
export function playRosterSound(cue: RosterCue): void {
  const ctx = audioContext();
  if (!ctx) return;
  const steps = CUES[cue];
  void ctx
    .resume()
    .then(() => {
      let at = ctx.currentTime;
      for (const step of steps) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = step.type;
        osc.frequency.value = step.frequency;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.06, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + step.duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(at);
        osc.stop(at + step.duration);
        at += step.duration;
      }
    })
    .catch(() => undefined);
}
