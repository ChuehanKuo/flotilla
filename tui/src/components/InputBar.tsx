import { Text } from 'ink';
import type { UiState } from '../viewModel.js';

export interface InputBarProps {
  mode: UiState['mode'];
  input: string;
}

export function InputBar({ mode, input }: InputBarProps) {
  if (mode === 'browse') {
    return <Text dimColor>j/k move · i instruct · a answer · q quit · Ctrl-C kill</Text>;
  }
  const label = mode === 'instruct' ? 'instruct' : 'answer';
  return (
    <Text>
      <Text bold color={mode === 'instruct' ? 'cyan' : 'yellow'}>{label}&gt; </Text>
      {input}
      <Text inverse> </Text>
    </Text>
  );
}
