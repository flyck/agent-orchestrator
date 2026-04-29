/**
 * Browser-native voice → text via the Web Speech API. Used by the
 * dashboard mic button to dictate a fresh task spec without typing.
 *
 * The Web Speech API streams audio to the browser's STT provider —
 * Chrome / Edge route this through Google. That contradicts the
 * project's local-first stance for the few seconds of speech that
 * leave the machine, so this service is intended as a Phase-A
 * prototype. Phase B will swap in a local Whisper transcriber via
 * MediaRecorder + a backend route, keeping this same observable
 * surface so the UI doesn't change.
 *
 * Browser support today (Apr 2026):
 *   Chrome / Edge — works well, silent-stop after ~1.5s of pause.
 *   Safari        — works on macOS / iOS.
 *   Firefox       — not implemented; supported() returns false.
 */

import { Injectable, signal } from '@angular/core';

// The Web Speech API isn't in the default TS lib. Minimal type subset
// we actually use, plus the vendor-prefixed window globals.
interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): { transcript: string };
  [index: number]: { transcript: string };
}
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message?: string;
}
interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getCtor(): SpeechRecognitionCtor | null {
  const w = globalThis as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type VoiceState = 'idle' | 'listening' | 'error';

@Injectable({ providedIn: 'root' })
export class VoiceInputService {
  /** Current recognition state — drives the button's visual state. */
  readonly state = signal<VoiceState>('idle');
  /** Final transcript accumulated across the current session. Cleared
   *  on each `start()`. */
  readonly finalText = signal('');
  /** In-flight partial — what the recognizer thinks you're currently
   *  saying. Reset after each final chunk arrives. */
  readonly interimText = signal('');
  /** Last error, if any. Surface in the UI; cleared on next start. */
  readonly errorMessage = signal<string | null>(null);

  private rec: SpeechRecognitionInstance | null = null;
  /** True only between an explicit stop() and the next start(). The
   *  Chrome SpeechRecognition auto-stops on the first ~1s of silence
   *  even with continuous=true, so we transparently restart on `onend`
   *  unless this flag says the user actually clicked stop. Without
   *  this, a single thinking pause mid-dictation truncated the take
   *  to whatever had been finalized so far. */
  private userStop = false;

  /** True when the browser has the Web Speech API. Hide the mic button
   *  entirely when this is false — there's no graceful fallback for
   *  Phase A. */
  supported(): boolean {
    return getCtor() !== null;
  }

  /** Start a fresh recognition session. No-op if one is already running.
   *  The browser may pop a permission prompt on first call; the user's
   *  choice persists per origin. */
  start(): void {
    if (this.state() === 'listening') return;
    if (!getCtor()) {
      this.state.set('error');
      this.errorMessage.set('SpeechRecognition not available in this browser.');
      return;
    }
    this.finalText.set('');
    this.interimText.set('');
    this.errorMessage.set(null);
    this.userStop = false;
    this.state.set('listening');
    this.beginRecognizer();
  }

  /** (Re)open the underlying recognizer without touching finalText.
   *  Called from `start` (fresh session) and from `onend` (auto-restart
   *  across silence). Each call wires a new instance because Chrome
   *  refuses to call `start()` twice on the same one. */
  private beginRecognizer(): void {
    const Ctor = getCtor();
    if (!Ctor) {
      this.state.set('error');
      this.errorMessage.set('SpeechRecognition not available in this browser.');
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';

    rec.onresult = (ev: SpeechRecognitionEvent) => {
      let interim = '';
      let final = this.finalText();
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i]!;
        const chunk = r[0]?.transcript ?? '';
        if (r.isFinal) {
          final = final ? `${final} ${chunk.trim()}` : chunk.trim();
        } else {
          interim += chunk;
        }
      }
      this.finalText.set(final);
      this.interimText.set(interim.trim());
    };

    rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
      // 'no-speech' fires after the silence timeout, 'aborted' fires
      // when we stop ourselves — both are normal lifecycle events,
      // not failures. Let onend handle the next move.
      if (ev.error === 'no-speech' || ev.error === 'aborted') return;
      this.state.set('error');
      this.errorMessage.set(ev.message || ev.error || 'recognition failed');
    };

    rec.onend = () => {
      this.interimText.set('');
      if (this.userStop || this.state() === 'error') {
        this.state.set(this.state() === 'error' ? 'error' : 'idle');
        return;
      }
      // Browser auto-stopped on silence but the user is still
      // dictating — open a fresh instance and keep going.
      try {
        this.beginRecognizer();
      } catch (err) {
        this.state.set('error');
        this.errorMessage.set(String(err));
      }
    };

    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      this.state.set('error');
      this.errorMessage.set(String(err));
    }
  }

  /** Stop the current session. Safe to call from the idle state. */
  stop(): void {
    this.userStop = true;
    if (!this.rec) {
      this.state.set('idle');
      return;
    }
    try {
      this.rec.stop();
    } catch {
      /* ignore */
    }
    this.state.set('idle');
  }

  /** Clear any captured text + error after the consumer has read it. */
  reset(): void {
    this.finalText.set('');
    this.interimText.set('');
    this.errorMessage.set(null);
    this.state.set('idle');
  }
}
