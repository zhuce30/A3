'use client';

import { Pause, Play, Square, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { prepareA3SpeechText } from '@/lib/a3/speech-utils';

type SpeechState = 'idle' | 'speaking' | 'paused';

type A3SpeechControlsProps = {
  text: string;
  id: string;
};

export function A3SpeechControls({ text, id }: A3SpeechControlsProps) {
  const [state, setState] = useState<SpeechState>('idle');
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  useEffect(() => {
    return () => {
      if (supported) window.speechSynthesis.cancel();
    };
  }, [supported]);

  function speak() {
    if (!supported) return;
    const speechText = prepareA3SpeechText(text);
    if (!speechText) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(speechText);
    utterance.lang = 'zh-CN';
    utterance.rate = 1;
    utterance.onend = () => setState('idle');
    utterance.onerror = () => setState('idle');
    window.speechSynthesis.speak(utterance);
    setState('speaking');
  }

  function pause() {
    if (!supported) return;
    window.speechSynthesis.pause();
    setState('paused');
  }

  function resume() {
    if (!supported) return;
    window.speechSynthesis.resume();
    setState('speaking');
  }

  function stop() {
    if (!supported) return;
    window.speechSynthesis.cancel();
    setState('idle');
  }

  if (!supported) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2" data-testid={`a3-speech-controls-${id}`}>
      {state === 'idle' && (
        <Button data-testid="a3-speech-speak" size="sm" variant="outline" onClick={speak}>
          <Volume2 className="size-4" />
          朗读
        </Button>
      )}
      {state === 'speaking' && (
        <Button data-testid="a3-speech-pause" size="sm" variant="outline" onClick={pause}>
          <Pause className="size-4" />
          暂停
        </Button>
      )}
      {state === 'paused' && (
        <Button data-testid="a3-speech-resume" size="sm" variant="outline" onClick={resume}>
          <Play className="size-4" />
          继续
        </Button>
      )}
      {state !== 'idle' && (
        <Button data-testid="a3-speech-stop" size="sm" variant="outline" onClick={stop}>
          <Square className="size-4" />
          停止
        </Button>
      )}
    </div>
  );
}
