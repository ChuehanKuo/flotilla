import React from 'react';
import { Box, Text } from 'ink';
import type { EscalationView } from '@flota/kernel';

export interface EscalationInboxProps {
  escalations: EscalationView[];
}

export function EscalationInbox({ escalations }: EscalationInboxProps) {
  if (escalations.length === 0) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        ⚠ {escalations.length} escalation{escalations.length > 1 ? 's' : ''} awaiting answer
      </Text>
      {escalations.map(e => (
        <Text key={e.taskId} color="yellow">{e.from} ({e.taskId}): {e.text}</Text>
      ))}
    </Box>
  );
}
