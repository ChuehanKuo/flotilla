import React from 'react';
import { Text } from 'ink';
import type { EscalationView } from '@flota/kernel';
import type { UiState } from '../viewModel.js';

export interface InputBarProps {
  mode: UiState['mode'];
  input: string;
  // Which escalation an 'answer'-mode submit will resolve (see
  // viewModel.ts's pickAnswerTarget) — shown so the operator can see who
  // they're answering before they hit Enter. Unused in other modes.
  answerTarget?: EscalationView;
}

export function InputBar({ mode, input, answerTarget }: InputBarProps) {
  if (mode === 'browse') {
    return <Text dimColor>j/k move · i instruct · a answer · q quit · Ctrl-C kill</Text>;
  }
  const label = mode === 'instruct'
    ? 'instruct'
    : answerTarget ? `answer ${answerTarget.from} (${answerTarget.taskId})` : 'answer';
  return (
    <Text>
      <Text bold color={mode === 'instruct' ? 'cyan' : 'yellow'}>{label}&gt; </Text>
      {input}
      <Text inverse> </Text>
    </Text>
  );
}
