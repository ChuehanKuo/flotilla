import { Box, Text } from 'ink';

export interface InspectorProps {
  nodeId?: string;
  lines: string[];
}

export function Inspector({ nodeId, lines }: InspectorProps) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
      <Text bold underline>Inspector{nodeId ? `: ${nodeId}` : ''}</Text>
      {!nodeId && <Text dimColor>(select a node)</Text>}
      {nodeId && lines.length === 0 && <Text dimColor>(no activity yet)</Text>}
      {lines.map((line, i) => <Text key={i}>{line}</Text>)}
    </Box>
  );
}
